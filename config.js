// =============================================================================
// Project-wide config — season, branding, sheet/form/doc references, contact labels
// =============================================================================

const GOOGLE_SHEET_ID = 'xxx';
const INSCRIPTION_FORM_ID = '<GOOGLE_FORM_ID>';
const REGLEMENT_DOC_ID = '<REGLEMENT_DOC_ID>';
const SHEET_NAME = 'Demandes';
const CONTACTS_SHEET_NAME = 'Google Contacts';
const TRACKING_SHEET_ID = 'XXX';

const YEAR_START = 2025;
const YEAR_END = 2026;
const SEASON = `${YEAR_START}/${YEAR_END}`;

// -----------------------------------------------------------------------------
// À renseigner par chaque section avant utilisation. Valeurs ci-dessous = exemples
// génériques / placeholders, à remplacer par les vraies valeurs de la section.
// -----------------------------------------------------------------------------

const ASSO_NAME = 'Amicale Laïque de Vertou';
const ASSO_SHORT = 'ALV';
const SECTION_NAME = 'Nom de la section';
const RESPONSABLE = 'Prénom NOM';
const FROM_NAME = SECTION_NAME;
const HELLOASSO_ASSO_SLUG = 'amicale-laique-de-vertou';
const HELLOASSO_CAMPAIGN_SLUG = 'adhesion-ecole-du-sport-ou-roller-2026-2027';
const HELLOASSO_CLIENT_ID = 'ton_client_id_ici';
const HELLOASSO_CLIENT_SECRET = 'ton_client_secret_ici';

const SECTION_POSTAL_ADDRESS = `${ASSO_SHORT} ${SECTION_NAME}, chez ${RESPONSABLE}
Numéro et nom de rue
Code postal VILLE`;

// URL publique de la campagne d'adhésion HelloAsso de la section.
const HELLOASSO_URL = `https://www.helloasso.com/associations/${HELLOASSO_ASSO_SLUG}/adhesions/${HELLOASSO_CAMPAIGN_SLUG}`;

// IDs Google des ressources liées au tableur d'inscriptions de la section.
const TRACKING_SHEET_URL = `https://docs.google.com/spreadsheets/d/${TRACKING_SHEET_ID}`;

const CERT_TEMPLATE_DOC = 'TEMPLATE Attestation CE';
const CERT_FOLDER = `Attestations CE ${YEAR_START}`;
const COTISATION_MIN = 80;
const COTISATION_MAX = 90;

// Google Contact labels appliqués dynamiquement par contacts.js selon la valeur
// d'une colonne (cf. CONTACT_SCHEMA.memberships.dynamicGroups). Permet de cibler
// des sous-groupes (cours, niveau, créneau, …) lors de la rédaction d'un mail.
const CONTACT_LABELS = [
  'PILATES  - Mardi 10h - 15 personnes maximum',
  'PILATES - Mardi 11h  - 15 personnes maximum',
  'PILATES - Mardi 20h30 - 20 personnes maximum',
];

// =============================================================================
// Contact schema for "Demandes" sheet — declares column → People field mapping.
// All the project-specific knowledge about contacts lives here. The generic
// engine is in contacts.js and knows nothing about this métier.
// =============================================================================

const YEAR_GROUP_NAME = `Elèves ${YEAR_START}`;

const ADDRESS_DEFAULTS = {
  countryCode: 'FR',
  country: 'France',
  region: 'Pays de la Loire',
};

const CONTACT_SCHEMA = {
  trackingColumn: 'Google Contact',
  name: {
    familyName: 'NOM',
    givenName: 'Prénom',
  },
  emails: [
    { col: 'Adresse e-mail', label: 'Email Parent 1', required: true },
    { col: 'Email Parent 2', label: 'Email Parent 2' },
  ],
  phones: [
    { col: 'Numéro téléphone Mobile', label: 'main', required: true },
    { col: 'Téléphone mobile Parent 2', label: 'other' },
  ],
  birthday: { col: 'Date de naissance' },
  address: {
    defaults: ADDRESS_DEFAULTS,
    mapping: {
      postalCode: 'Code postal',
      city: 'Commune',
      streetAddress: 'Adresse postale complète',
    },
  },
  memberships: {
    staticGroups: [YEAR_GROUP_NAME],
    dynamicGroups: [
      { col: 'Choix PILATES encore disponibles', allowedValues: CONTACT_LABELS },
    ],
  },
};

