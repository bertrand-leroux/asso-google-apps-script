// =============================================================================
// Google Contacts sync — generic. Driven by a schema describing how spreadsheet
// columns map to People API Person fields.
//
// Schema shape (all keys optional except `name`):
// {
//   name:       { familyName: 'col A', givenName: 'col B' },
//   emails:     [ { col, label, required? }, ... ],
//   phones:     [ { col, label, required? }, ... ],
//   birthday:   { col },
//   address:    { defaults: {...}, mapping: { postalCode: 'col', city: 'col', ... } },
//   memberships:{ staticGroups: ['Group A'], dynamicGroups: [{ col, allowedValues: [...] }, ...] },
//   trackingColumn: 'Google Contact'   // sheet column where contact URL is written/read
// }
// =============================================================================

const CONTACT_URL_PREFIX = 'https://contacts.google.com/person/';
const CONTACT_PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,addresses,birthdays,memberships,metadata';
const CONTACT_BATCH_LIMIT = 200;

// searchContacts exige un warmup (requête à query vide) pour rafraîchir le cache
// serveur avant la vraie recherche. On le fait une seule fois par exécution.
const CONTACT_SEARCH_WARMUP_MS = 3000;
let _contactSearchWarmed = false;

// -----------------------------------------------------------------------------
// Schema validation
// -----------------------------------------------------------------------------

function collectSchemaColumns_(schema) {
  const cols = [schema.trackingColumn];
  if (schema.name) cols.push(...Object.values(schema.name));
  if (schema.emails) cols.push(...schema.emails.map(s => s.col));
  if (schema.phones) cols.push(...schema.phones.map(s => s.col));
  if (schema.birthday) cols.push(schema.birthday.col);
  if (schema.address) cols.push(...Object.values(schema.address.mapping));
  if (schema.memberships && schema.memberships.dynamicGroups) {
    cols.push(...schema.memberships.dynamicGroups.map(dg => dg.col));
  }
  return cols.filter(Boolean);
}

function validateSchema_(schema, data) {
  const header = data[0];
  const missing = collectSchemaColumns_(schema).filter(col => header.indexOf(col) === -1);
  if (missing.length) {
    throw new Error(`Colonnes manquantes dans la feuille: ${missing.map(c => `"${c}"`).join(', ')}`);
  }
}

// -----------------------------------------------------------------------------
// Groups
// -----------------------------------------------------------------------------

function listAllContactGroups_() {
  const all = [];
  let pageToken;
  do {
    const res = People.ContactGroups.list({ pageSize: 1000, pageToken });
    if (res.contactGroups) all.push(...res.contactGroups);
    pageToken = res.nextPageToken;
  } while (pageToken);
  return all;
}

function ensureContactGroups_(schema) {
  const spec = schema.memberships;
  if (!spec) return {};
  const dynamicAllowed = (spec.dynamicGroups || []).flatMap(dg => dg.allowedValues);
  const wanted = [...(spec.staticGroups || []), ...dynamicAllowed];
  const existing = listAllContactGroups_();
  const byName = {};
  wanted.forEach(name => {
    const found = existing.find(g => g.name === name);
    byName[name] = found || People.ContactGroups.create({ contactGroup: { name } });
  });
  return byName;
}

// -----------------------------------------------------------------------------
// Person builders — pure, take (line, data, schema, groups)
// -----------------------------------------------------------------------------

function buildContactName_(spec, line, data) {
  const entry = {};
  Object.entries(spec).forEach(([field, col]) => {
    entry[field] = getByName(col, line, data);
  });
  return [entry];
}

function buildContactLabeledValues_(specs, line, data) {
  return specs
    .map(({ col, label, required }) => {
      const value = getByName(col, line, data);
      if (!value && !required) return null;
      return { value, type: label };
    })
    .filter(Boolean);
}

function buildContactBirthday_(spec, line, data) {
  const raw = getByName(spec.col, line, data);
  if (!raw) return [];
  const date = raw instanceof Date ? raw : new Date(raw);
  return [{ date: { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() } }];
}

function buildContactAddress_(spec, line, data) {
  const entry = { ...(spec.defaults || {}) };
  Object.entries(spec.mapping).forEach(([field, col]) => {
    entry[field] = String(getByName(col, line, data));
  });
  return [entry];
}

function buildContactMemberships_(spec, groups, line, data) {
  if (!spec) return [];
  const out = (spec.staticGroups || []).map(name => ({
    contactGroupMembership: { contactGroupResourceName: groups[name].resourceName },
  }));
  // Une cellule vide pour un dynamicGroup donné = pas d'appartenance ajoutée
  // pour ce groupe (pas d'erreur). Permet d'avoir plusieurs colonnes facultatives.
  (spec.dynamicGroups || []).forEach(dg => {
    const groupName = getByName(dg.col, line, data);
    if (!groupName) return;
    if (!groups[groupName]) {
      throw new Error(`Groupe inconnu ligne ${line}: "${groupName}" (colonne "${dg.col}")`);
    }
    out.push({ contactGroupMembership: { contactGroupResourceName: groups[groupName].resourceName } });
  });
  return out;
}

// Fusionne les memberships au lieu de les écraser (read-modify-write). Une même
// personne peut être gérée par plusieurs sections (Pilates, Yoga) partageant le
// même contact Google. On ne remplace que les groupes gérés par CE schéma
// (staticGroups + dynamicGroups.allowedValues = Object.values(groups)) et on
// préserve tout le reste (autre section + groupes système comme myContacts).
function mergeManagedMemberships_(person, existingMemberships, groups) {
  if (!person.memberships) return person;
  const managed = Object.values(groups).map(g => g.resourceName);
  const preserved = (existingMemberships || []).filter(m => {
    const rn = m.contactGroupMembership && m.contactGroupMembership.contactGroupResourceName;
    return rn && managed.indexOf(rn) === -1;
  });
  person.memberships = preserved.concat(person.memberships);
  return person;
}

function buildContactPerson_(line, data, schema, groups) {
  const person = {};
  if (schema.name) person.names = buildContactName_(schema.name, line, data);
  if (schema.emails) person.emailAddresses = buildContactLabeledValues_(schema.emails, line, data);
  if (schema.phones) person.phoneNumbers = buildContactLabeledValues_(schema.phones, line, data);
  if (schema.birthday) person.birthdays = buildContactBirthday_(schema.birthday, line, data);
  if (schema.address) person.addresses = buildContactAddress_(schema.address, line, data);
  if (schema.memberships) person.memberships = buildContactMemberships_(schema.memberships, groups, line, data);
  return person;
}

// -----------------------------------------------------------------------------
// URL helpers — la colonne tracking n'est plus la source de vérité (les URLs
// deviennent obsolètes après fusion de doublons), seulement un lien pratique.
// -----------------------------------------------------------------------------

function contactUrlFromResourceName_(resourceName) {
  return CONTACT_URL_PREFIX + resourceName.split('/').pop();
}

// -----------------------------------------------------------------------------
// Résolution d'un contact par identité (email + nom), au lieu de l'URL stockée.
// -----------------------------------------------------------------------------

function normalizeContactKey_(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

// L'email de recherche = la première colonne email déclarée `required`.
function lookupEmailSpec_(schema) {
  const spec = (schema.emails || []).find(e => e.required);
  if (!spec) {
    throw new Error('Schema: aucune colonne email "required" pour la recherche de contact.');
  }
  return spec;
}

// Identité composite d'une ligne : email + NOM + Prénom (normalisés). Distingue
// les fratries qui partagent le même email parent. Renvoie null si email vide.
function contactIdentityForLine_(line, data, schema) {
  const email = normalizeContactKey_(getByName(lookupEmailSpec_(schema).col, line, data));
  if (!email) return null;
  const familyName = normalizeContactKey_(getByName(schema.name.familyName, line, data));
  const givenName = normalizeContactKey_(getByName(schema.name.givenName, line, data));
  return { email, familyName, givenName, key: `${email}|${familyName}|${givenName}` };
}

// Toutes les clés d'identité d'un person (combinaisons email × nom).
function personIdentityKeys_(person) {
  const emails = (person.emailAddresses || []).map(e => normalizeContactKey_(e.value)).filter(Boolean);
  const names = (person.names || []).map(n => ({
    familyName: normalizeContactKey_(n.familyName),
    givenName: normalizeContactKey_(n.givenName),
  }));
  const keys = [];
  emails.forEach(email => names.forEach(n => keys.push(`${email}|${n.familyName}|${n.givenName}`)));
  return keys;
}

function personMatchesIdentity_(person, identity) {
  return personIdentityKeys_(person).indexOf(identity.key) !== -1;
}

// Warmup unique par exécution (chaque appel de menu = nouvelle exécution Apps Script).
function warmContactSearchCache_() {
  if (_contactSearchWarmed) return;
  People.People.searchContacts({ query: '', readMask: 'emailAddresses', pageSize: 1 });
  Utilities.sleep(CONTACT_SEARCH_WARMUP_MS);
  _contactSearchWarmed = true;
}

// Single-row : cherche par email puis filtre sur l'identité exacte. Renvoie
// { resourceName, etag, person } (etag live via get) ou null.
function findContactForLine_(line, data, schema) {
  const identity = contactIdentityForLine_(line, data, schema);
  if (!identity) return null;
  warmContactSearchCache_();
  const res = People.People.searchContacts({
    query: identity.email,
    readMask: 'names,emailAddresses,metadata',
    pageSize: 30,
  });
  const match = (res.results || [])
    .map(r => r.person)
    .find(p => personMatchesIdentity_(p, identity));
  if (!match) return null;
  const full = People.People.get(match.resourceName, { personFields: CONTACT_PERSON_FIELDS });
  return { resourceName: full.resourceName, etag: full.etag, person: full };
}

// Bulk : un seul parcours paginé des contacts de l'utilisateur → index
// identité → { resourceName, etag }. Évite N searchContacts (warmup/sleep) et le
// cache périmé juste après batchCreateContacts.
function buildContactIndex_() {
  const index = {};
  let pageToken;
  do {
    const res = People.People.Connections.list('people/me', {
      personFields: 'names,emailAddresses,memberships,metadata',
      pageSize: 1000,
      pageToken,
    });
    (res.connections || []).forEach(p => {
      personIdentityKeys_(p).forEach(key => {
        index[key] = { resourceName: p.resourceName, etag: p.etag, memberships: p.memberships };
      });
    });
    pageToken = res.nextPageToken;
  } while (pageToken);
  return index;
}

// -----------------------------------------------------------------------------
// Batch create — for many lines
// -----------------------------------------------------------------------------

function chunk_(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Met à jour un contact résolu. updatePersonFields ne liste que ce qu'on envoie :
// lister un champ sans le fournir l'effacerait sur le contact. L'etag peut venir
// de Connections.list (potentiellement périmé) → refetch + retry une fois si échec.
function updateResolvedContact_(resourceName, etag, fresh) {
  const updatePersonFields = Object.keys(fresh).join(',');
  try {
    return People.People.updateContact({ etag, ...fresh }, resourceName, { updatePersonFields });
  } catch (e) {
    const current = People.People.get(resourceName, { personFields: CONTACT_PERSON_FIELDS });
    return People.People.updateContact({ etag: current.etag, ...fresh }, resourceName, { updatePersonFields });
  }
}

// Upsert en masse : résout chaque ligne par identité (email + nom) via un index
// construit en une passe. Ligne déjà présente → update (pas de doublon) ; sinon
// → create groupé. La colonne tracking n'est plus lue, seulement (ré)écrite.
function createContactsForLines_(sheet, data, lines, schema) {
  validateSchema_(schema, data);
  const groups = ensureContactGroups_(schema);
  const contactCol = getColNumberByName(schema.trackingColumn, data);
  const index = buildContactIndex_();

  const result = { created: 0, updated: 0, skipped: 0, failed: 0, errors: [] };
  const creates = [];
  const updates = [];
  lines.forEach(line => {
    try {
      const identity = contactIdentityForLine_(line, data, schema);
      if (!identity) {
        result.skipped++;
        result.errors.push(`Ligne ${line} skipped: email de recherche vide`);
        return;
      }
      const contactPerson = buildContactPerson_(line, data, schema, groups);
      const existing = index[identity.key];
      if (existing) {
        updates.push({ line, contactPerson, ...existing });
      } else {
        creates.push({ line, contactPerson });
      }
    } catch (e) {
      result.skipped++;
      result.errors.push(`Ligne ${line} skipped: ${e.message}`);
      Logger.log(`Skip line ${line}: ${e.message}`);
    }
  });

  chunk_(creates, CONTACT_BATCH_LIMIT).forEach(batch => {
    const contacts = batch.map(({ contactPerson }) => ({ contactPerson }));
    let res;
    try {
      res = People.People.batchCreateContacts({ contacts, readMask: 'names' });
    } catch (e) {
      result.failed += batch.length;
      result.errors.push(`Batch (${batch.length} lignes): ${e.message}`);
      Logger.log(`Batch failure: ${e}`);
      return;
    }
    (res.createdPeople || []).forEach((wrap, i) => {
      const { line } = batch[i];
      const person = wrap.person;
      if (!person) {
        result.failed++;
        result.errors.push(`Ligne ${line}: aucun person renvoyé`);
        Logger.log(`No person returned line ${line}`);
        return;
      }
      sheet.getRange(line, contactCol).setValue(contactUrlFromResourceName_(person.resourceName));
      result.created++;
    });
  });

  updates.forEach(({ line, contactPerson, resourceName, etag, memberships }) => {
    try {
      mergeManagedMemberships_(contactPerson, memberships, groups);
      const updated = updateResolvedContact_(resourceName, etag, contactPerson);
      sheet.getRange(line, contactCol).setValue(contactUrlFromResourceName_(updated.resourceName));
      result.updated++;
    } catch (e) {
      result.failed++;
      result.errors.push(`Ligne ${line} (update): ${e.message}`);
      Logger.log(`Update failure line ${line}: ${e}`);
    }
  });

  return result;
}

// -----------------------------------------------------------------------------
// Single-row ops — used from menu (cursor line)
// -----------------------------------------------------------------------------

function syncContactCreate(sheet, line, schema) {
  const data = sheet.getDataRange().getValues();
  return createContactsForLines_(sheet, data, [line], schema);  // { created, updated, skipped, failed, errors }
}

function syncContactUpdate(sheet, line, schema) {
  const data = sheet.getDataRange().getValues();
  validateSchema_(schema, data);

  const found = findContactForLine_(line, data, schema);
  if (!found) {
    const id = contactIdentityForLine_(line, data, schema);
    const who = id ? `${id.email} (${id.givenName} ${id.familyName})` : `ligne ${line}`;
    throw new Error(`Aucun contact Google trouvé pour ${who}.`);
  }

  const groups = ensureContactGroups_(schema);
  const fresh = buildContactPerson_(line, data, schema, groups);
  mergeManagedMemberships_(fresh, found.person.memberships, groups);
  const updated = updateResolvedContact_(found.resourceName, found.etag, fresh);

  // Rafraîchit l'URL : auto-corrige une URL devenue obsolète après fusion.
  const contactCol = getColNumberByName(schema.trackingColumn, data);
  sheet.getRange(line, contactCol).setValue(contactUrlFromResourceName_(updated.resourceName));
}

function syncContactDelete(sheet, line, schema) {
  const data = sheet.getDataRange().getValues();
  validateSchema_(schema, data);

  const contactCol = getColNumberByName(schema.trackingColumn, data);
  const found = findContactForLine_(line, data, schema);
  // Succès doux : si aucun contact (déjà supprimé / fusionné), on vide juste la
  // cellule sans erreur — le but « aucun contact ne doit exister » est atteint.
  if (found) People.People.deleteContact(found.resourceName);
  sheet.getRange(line, contactCol).clearContent();
}
