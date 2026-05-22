// -----------------------------------------------------------------------------
// Menu wrappers — these names are referenced by the spreadsheet menu.
// -----------------------------------------------------------------------------

function createAllUnexistingContacts() {
  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  const lines = eligibleLines(sheet, data, line =>
    getByName('Statut', line, data) !== "Inscrit sur liste d'attente"
    && getByName(CONTACT_SCHEMA.trackingColumn, line, data) === ''
  );
  const { created, skipped, failed, errors } = createContactsForLines_(sheet, data, lines, CONTACT_SCHEMA);
  const summary = [`${created} contact(s) créé(s).`];
  if (skipped) summary.push(`${skipped} ligne(s) skipped.`);
  if (failed) summary.push(`${failed} échec(s).`);
  if (errors.length) summary.push('', ...errors);
  SpreadsheetApp.getUi().alert(summary.join('\n'));
}

function createOneContact() {
  const sheet = getSheet();
  const line = getCursorLine(sheet);
  if (line === null) return;

  const ui = SpreadsheetApp.getUi();
  const data = sheet.getDataRange().getValues();

  if (getColNumberByName(CONTACT_SCHEMA.trackingColumn, data) === undefined) {
    ui.alert(`Colonne "${CONTACT_SCHEMA.trackingColumn}" introuvable dans la feuille.`);
    return;
  }
  if (getByName(CONTACT_SCHEMA.trackingColumn, line, data) !== '') {
    ui.alert(`Ligne ${line}: contact Google déjà existant.`);
    return;
  }
  if (getByName('Statut', line, data) === "Inscrit sur liste d'attente") {
    ui.alert(`Ligne ${line}: inscrit sur liste d'attente, contact non créé.`);
    return;
  }

  const { created, errors } = syncContactCreate(sheet, line, CONTACT_SCHEMA);
  ui.alert(created === 1
    ? `Contact ligne ${line} créé.`
    : `Échec création ligne ${line}.\n${errors.join('\n')}`);
}

function withCursorLine_(label, action) {
  const sheet = getSheet();
  const line = getCursorLine(sheet);
  if (line === null) return;
  const ui = SpreadsheetApp.getUi();
  try {
    action(sheet, line);
    ui.alert(`Contact ligne ${line} ${label}.`);
  } catch (e) {
    Logger.log(`${label} fail line ${line}: ${e}`);
    ui.alert(`Échec ${label} ligne ${line}: ${e.message}`);
  }
}

function updateContact() {
  withCursorLine_('mis à jour', (sheet, line) => syncContactUpdate(sheet, line, CONTACT_SCHEMA));
}

function deleteContact() {
  withCursorLine_('supprimé', (sheet, line) => syncContactDelete(sheet, line, CONTACT_SCHEMA));
}
