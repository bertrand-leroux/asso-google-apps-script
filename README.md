# ALV — Apps Script inscriptions section

Google Apps Script générique pour le tableur d'inscriptions d'une section d'une association, alimenté par un Google Form. Réutilisable tel quel par n'importe quelle section : tous les libellés section-specific sont paramétrés dans `config.js` (`SECTION_NAME`, `RESPONSABLE`, `SECTION_POSTAL_ADDRESS`, `HELLOASSO_URL`, `CONTACT_LABELS`, …).

Automatise :
- Accusé de réception du formulaire d'inscription
- Relances mail (cotisation impayée, certificat médical manquant)
- Génération + envoi des attestations CE de paiement (Doc → PDF)
- Synchronisation `Demandes` ↔ Google Contacts (création/MAJ/suppression)
- Export CSV de la feuille `Google Contacts`
- Client HelloAsso v5 + custom function Sheets `IMPORTHELLOASSO`

## Menu spreadsheet

À l'ouverture, un menu **{ASSO_SHORT} {SECTION_NAME}** est ajouté :

```
Envoi des attestations CE
Relances mail
  ├─ Certificats médicaux
  └─ Cotisations
Contacts
  ├─ Créer tous les manquants
  ├─ Créer / Mettre à jour (ligne du curseur)
  └─ Suppression (ligne du curseur)
```

## Structure des fichiers

| Fichier | Rôle |
|---|---|
| `config.js` | Constantes métier : saison, asso, URLs, IDs form/doc, CONTACT_LABELS |
| `menu.js` | `onOpen` — branchement du menu |
| `sheet-utils.js` | Helpers spreadsheet (`getByName`, `getCursorLine`, `eligibleLines`, …) |
| `mail.js` | `sendMail`, `signature` |
| `contacts.js` | **Moteur générique** de sync People API, piloté par un schema |
| `contacts-schema.js` | `CONTACT_SCHEMA` spécifique à la section + wrappers menu |
| `reminders.js` | `missingPaymentMail`, `sendMedCertificateMail` |
| `certificates.js` | `sendCertificates` (Doc template → PDF → mail) |
| `form-trigger.js` | `sendResponseMail` — déclenché sur soumission du formulaire |
| `csv-export.js` | `saveAsCSV` |
| `helloasso-api.js` | Client REST HelloAsso (OAuth, retry, pagination) + `IMPORTHELLOASSO` |
| `json-to-2d.js` | Aplatissement JSON → tableau 2D (support de `IMPORTHELLOASSO`) |

Apps Script ne supporte pas les imports : tous les fichiers partagent un même scope global. Le découpage est uniquement organisationnel.

## Sync Google Contacts — générique

`contacts.js` ne connaît rien du métier. Toute la mapping colonne ↔ champ People API se déclare dans un objet schema. Pour réutiliser sur un autre tableur :

```js
const MY_SCHEMA = {
  trackingColumn: 'Google Contact',
  name:    { familyName: 'Nom', givenName: 'Prénom' },
  emails:  [{ col: 'Email', label: 'home', required: true }],
  phones:  [{ col: 'Mobile', label: 'main' }],
  birthday:{ col: 'Date de naissance' },
  address: {
    defaults: { countryCode: 'FR' },
    mapping: { postalCode: 'CP', city: 'Ville', streetAddress: 'Adresse' },
  },
  memberships: {
    staticGroups: ['Mon Groupe'],
    dynamicGroups: [
      { col: 'Cours', allowedValues: ['Yoga lundi', 'Pilates mardi'] },
      { col: 'Niveau', allowedValues: ['Débutant', 'Intermédiaire', 'Avancé'] },
    ],
  },
};

// puis depuis un wrapper menu :
syncContactCreate(sheet, line, MY_SCHEMA);
syncContactUpdate(sheet, line, MY_SCHEMA);
syncContactDelete(sheet, line, MY_SCHEMA);
```

`validateSchema_` vérifie au runtime que toutes les colonnes référencées existent dans la feuille.

## Setup

### 1. Lier le script au spreadsheet

Soit éditer le script depuis le tableur (`Extensions → Apps Script`), soit utiliser [clasp](https://github.com/google/clasp) :

```bash
clasp clone <scriptId>
clasp push
```

### 2. Activer les Advanced Services

Dans l'éditeur Apps Script → **Services** → ajouter :
- **People API** (identifiant : `People`)

### 3. Scopes OAuth

Le manifeste demande automatiquement, à la première exécution :

```
https://www.googleapis.com/auth/contacts
https://www.googleapis.com/auth/spreadsheets
https://www.googleapis.com/auth/drive
https://www.googleapis.com/auth/gmail.send
https://www.googleapis.com/auth/documents
https://www.googleapis.com/auth/forms
https://www.googleapis.com/auth/script.external_request
```

### 4. Trigger formulaire

Pour activer l'accusé de réception : **Déclencheurs** → ajouter `sendResponseMail`, source = `Du tableur`, événement = `À l'envoi du formulaire`.

### 5. Ressources Drive

- Document modèle : **TEMPLATE Attestation CE** (placeholders `{{ Prénom de l'enfant }}`, `{{ Nom de l'enfant }}`, `{{ Date de naissance }}`, `{{ Nom Parent 1 }}`, `{{ Nom Parent 2 }}`, `{{ section }}`, `{{ responsable }}`, `{{ year }}`, `{{ nextyear }}`, `{{ now }}`, `{{ paidAmount }}`)
- Dossier de sortie : **Attestations CE 2025**

### 6. Credentials HelloAsso

Une seule fois, depuis l'éditeur Apps Script :

```js
setHelloAssoCredentials('your_client_id', 'your_client_secret');
```

Stockées dans `PropertiesService.getScriptProperties()`, **jamais commitées**. Supprimer l'appel de l'éditeur après exécution.

## Colonnes attendues dans la feuille `Demandes`

Référencées par les différents modules :

- **Identité enfant** : `NOM`, `Prénom`, `Nom de l'enfant`, `Prénom de l'enfant`, `Date de naissance`
- **Parents** : `Nom Parent 1`, `Adresse e-mail`, `Nom Parent 2`, `Email Parent 2`, `Numéro téléphone Mobile`, `Téléphone mobile Parent 2`
- **Adresse** : `Code postal`, `Commune`, `Adresse postale complète`
- **Inscription** : `Statut`, `Choix PILATES encore disponibles`, `Classe à la rentrée`
- **Suivi** : `Total cotisation`, `Total payé`, `Date certificat médical`, `Déclaration sur l'honneur`
- **Sorties écritures** : `Google Contact` (URL), `Attestation CE` (URL PDF)

## Custom function : `=IMPORTHELLOASSO(...)`

Utilisable dans une cellule :

```
=IMPORTHELLOASSO("/organizations/<your-asso-slug>/orders"; "/data/payer"; "noTruncate")
```

Signature : `IMPORTHELLOASSO(url, query, options)`
- `url` : URL complète OU chemin relatif (commence par `/`, base = `https://api.helloasso.com/v5`)
- `query` : préfixes XPath-like séparés par virgules pour filtrer les champs
- `options` : `noInherit`, `noTruncate`, `rawHeaders`, `noHeaders`, `debugLocation`

## Conventions

- **Suffix `_`** sur fonctions privées (convention Apps Script — exclut du dropdown "Select function" de l'éditeur, empêche exécution manuelle accidentelle).
- Fonctions appelées depuis le menu, depuis un trigger, ou exposées comme custom function : **pas** de suffix.
- Constantes en `SCREAMING_SNAKE_CASE`, fonctions en `camelCase`.
