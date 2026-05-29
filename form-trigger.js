// =============================================================================
// Form trigger — acknowledges a new inscription via mail
// Bound to the Google Form submission event.
// =============================================================================

function sendResponseMail(e) {
  const editUrl = e && e.response
    ? e.response.getEditResponseUrl()
    : FormApp.openById(INSCRIPTION_FORM_ID).getResponses().pop().getEditResponseUrl();

  const data = e.namedValues;
  const email = getDataValue(data, 'Adresse e-mail');
  const email2 = getDataValue(data, 'Email Parent 2');
  const nomEnfant = getDataValue(data, "Nom de l'enfant");
  const prenomEnfant = getDataValue(data, "Prénom de l'enfant");
  const choix1 = getDataValue(data, 'Choix 1');
  const choix2 = getDataValue(data, 'Choix 2');
  const choix3 = getDataValue(data, 'Choix 3');
  const dob = getDataValue(data, 'Date de naissance');
  const classe = getDataValue(data, 'Classe à la rentrée');

  const allValues = Object.keys(data)
    .map(key => `${key}: ${data[key]}`)
    .join('\n');

  // SECTION_POSTAL_ADDRESS est défini multi-ligne en config sans indentation.
  // Ici on l'injecte dans un bloc indenté de 10 espaces : on préfixe chaque
  // ligne au lieu d'écrire l'adresse en dur, pour rester adaptable à toute
  // section (cf. config.js).
  const indentedPostalAddress = SECTION_POSTAL_ADDRESS
    .split('\n')
    .map(l => `          ${l}`)
    .join('\n');

  const body = `Bonjour,

Nous avons bien reçu votre demande d'inscription pour votre enfant ${prenomEnfant} ${nomEnfant}.

Si besoin vous pouvez modifier votre réponse en cliquant sur le lien suivant :
${editUrl}

Date de naissance : ${dob}
Classe à la rentrée : ${classe}

Choix 1 : ${choix1}
Choix 2 : ${choix2}
Choix 3 : ${choix3}

Lien vers le fichier de suivi de votre demande d'inscription :
${TRACKING_SHEET_URL}

Paiement de la cotisation :
  * paiement Pass'Sport : nous transférer obligatoirement le courriel officiel du Pass'Sport (pas juste nous donner le code)

  * paiement en ligne sécurisé Helloasso :
    ${HELLOASSO_URL}

  * paiement chèques-vacances: vous devez impérativement
      - Renseigner l'ordre sur chaque chèque-vacances : "à l'ordre de ${ASSO_SHORT} - ${SECTION_NAME.toUpperCase()}"
      - Ecrire au dos de chaque chèque-vacances, le nom et prénom de l'enfant concerné.
      - Déposer ces chèques à l'adresse suivante :
${indentedPostalAddress}

Ne fournir aucun papier libre supplémentaire s'il vous plaît.


Toutes vos réponses :

${allValues}
`;

  const attachments = [];
  try {
    attachments.push(DriveApp.getFileById(REGLEMENT_DOC_ID).getAs(MimeType.PDF));
  } catch (err) {
    Logger.log(`Règlement PDF introuvable (id=${REGLEMENT_DOC_ID}): ${err}. Mail envoyé sans PJ.`);
  }

  sendMail({
    to: email,
    cc: email2 || undefined,
    subject: `Demande d'inscription - ${nomEnfant} ${prenomEnfant}`,
    body,
    attachments,
  });
}
