// -----------------------------------------------------------------------------
// Menu wrappers — these names are referenced by the spreadsheet menu.
// -----------------------------------------------------------------------------

// Label "ligne N (Prénom NOM)" pour identifier un contact dans les messages UI.
// Lit les colonnes nom/prénom déclarées dans CONTACT_SCHEMA.name.
function contactLabel_(line, data) {
  const familyName = getByName(CONTACT_SCHEMA.name.familyName, line, data);
  const givenName = getByName(CONTACT_SCHEMA.name.givenName, line, data);
  return `ligne ${line} (${givenName} ${familyName})`;
}

// Conditions d'éligibilité d'une ligne à la création/màj d'un contact Google.
// POINT D'EXTENSION par section : par défaut toutes les lignes sont éligibles
// (eligibleLines ignore déjà les lignes masquées par filtre). Pour restreindre
// selon une colonne propre à la section, renvoyer false ici, ex. :
//   if (getByName('Statut', line, data) !== 'Inscrit') return false;
//   if (getByName('Paiement', line, data) !== 'OK') return false;
// (NB: getByName renvoie undefined si la colonne n'existe pas dans la feuille.)
function isContactEligible_(line, data) {
  return true;
}

function createAllUnexistingContacts() {
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  // La résolution se fait par email + nom (createContactsForLines_ dédoublonne
  // via un index) : un contact déjà présent → mis à jour, sinon → créé.
  // Contraintes d'éligibilité propres à la section : voir isContactEligible_.
  const lines = eligibleLines(sheet, data, line => isContactEligible_(line, data));
  const { created, updated, skipped, failed, errors } = createContactsForLines_(sheet, data, lines, CONTACT_SCHEMA);
  const summary = [`${created} contact(s) créé(s).`, `${updated} mis à jour.`];
  if (skipped) summary.push(`${skipped} ligne(s) skipped.`);
  if (failed) summary.push(`${failed} échec(s).`);
  if (errors.length) summary.push('', ...errors);
  SpreadsheetApp.getUi().alert(summary.join('\n'));
}

// Upsert : résout le contact par email + nom (cf. createContactsForLines_).
// S'il existe déjà → mise à jour ; sinon → création. Skip si non éligible.
function upsertContact() {
  const sheet = getSheet();
  const line = getCursorLine(sheet);
  if (line === null) return;

  const ui = SpreadsheetApp.getUi();
  const data = sheet.getDataRange().getValues();

  if (getColNumberByName(CONTACT_SCHEMA.trackingColumn, data) === undefined) {
    ui.alert(`Colonne "${CONTACT_SCHEMA.trackingColumn}" introuvable dans la feuille.`);
    return;
  }
  // Contraintes d'éligibilité propres à la section : voir isContactEligible_.
  if (!isContactEligible_(line, data)) {
    ui.alert(`Ligne ${line}: non éligible à la création de contact.`);
    return;
  }

  const who = contactLabel_(line, data);
  const { created, updated, errors } = syncContactCreate(sheet, line, CONTACT_SCHEMA);
  if (created === 1) ui.alert(`Contact ${who} créé.`);
  else if (updated === 1) ui.alert(`Contact ${who} mis à jour.`);
  else ui.alert(`Échec ${who}.\n${errors.join('\n')}`);
}

function withCursorLine_(label, action) {
  const sheet = getSheet();
  const line = getCursorLine(sheet);
  if (line === null) return;
  const data = sheet.getDataRange().getValues();
  const who = contactLabel_(line, data);
  const ui = SpreadsheetApp.getUi();
  try {
    action(sheet, line);
    ui.alert(`Contact ${who} ${label}.`);
  } catch (e) {
    Logger.log(`${label} fail ${who}: ${e}`);
    ui.alert(`Échec ${label} ${who}: ${e.message}`);
  }
}

function deleteContact() {
  withCursorLine_('supprimé', (sheet, line) => syncContactDelete(sheet, line, CONTACT_SCHEMA));
}
