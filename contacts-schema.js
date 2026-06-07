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

function createAllUnexistingContacts() {
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  // La résolution se fait désormais par email + nom (createContactsForLines_
  // dédoublonne via un index). Plus besoin de filtrer sur trackingColumn vide :
  // une URL périmée après fusion empêcherait la re-synchro de la ligne.
  const lines = eligibleLines(sheet, data, line =>
    getByName('Statut', line, data) === "Inscrit"
  );
  const { created, updated, skipped, failed, errors } = createContactsForLines_(sheet, data, lines, CONTACT_SCHEMA);
  const summary = [`${created} contact(s) créé(s).`, `${updated} mis à jour.`];
  if (skipped) summary.push(`${skipped} ligne(s) skipped.`);
  if (failed) summary.push(`${failed} échec(s).`);
  if (errors.length) summary.push('', ...errors);
  SpreadsheetApp.getUi().alert(summary.join('\n'));
}

// Upsert : résout le contact par email + nom (cf. createContactsForLines_).
// S'il existe déjà → mise à jour ; sinon → création. Skip si liste d'attente.
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
  if (getByName('Statut', line, data) === "Inscrit sur liste d'attente") {
    ui.alert(`Ligne ${line}: inscrit sur liste d'attente, contact non créé.`);
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
