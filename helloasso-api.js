// =============================================================================
// HelloAsso API client
// Doc: https://api.helloasso.com/v5/swagger/index.html
// =============================================================================

const HELLOASSO_API_BASE = 'https://api.helloasso.com/v5';
const HELLOASSO_TOKEN_URL = 'https://api.helloasso.com/oauth2/token';
const HELLOASSO_TOKEN_PROP_KEY = 'helloasso_token_v2';
const HELLOASSO_TOKEN_TTL_SAFETY_MS = 60 * 1000; // refresh 60s before expiry

// -----------------------------------------------------------------------------
// Token (persisted in ScriptProperties — durable, survit éviction CacheService)
//
// Pas de LockService : interdit en contexte custom function (=IMPORTHELLOASSO
// en cellule). Race condition acceptée : si plusieurs appels parallèles ratent
// la propriété simultanément, chacun POSTe /oauth2/token et le dernier write
// gagne. ScriptProperties = durable → cache miss bien plus rare que
// CacheService → réduit drastiquement les stampedes (Cloudflare 1015).
// -----------------------------------------------------------------------------

// Formule G Sheets pour matcher un paiement Helloasso
// Headers dans la feuille "Helloasso" : Date|Nom|Prénom|Email payeur|Montant (€)|Nom de l'enfant|Prénom de l'enfant
// Headers dans la feuille lançant la formule suivante : Horodateur|Choix 1|Choix 2|Choix 3|Nom de l'enfant|Prénom de l'enfant|Sexe de l'enfant|Date de naissance|Classe à la rentrée|Nom Parent 1|Adresse e-mail|Téléphone mobile Parent 1|Nom Parent 2|Email Parent 2|Téléphone mobile Parent 2|Code postal|Commune|Adresse|Remarques|Saison 2025/2026|Règlement de la cotisation annuelle|Droit à l'image|Déclaration sur l'honneur|Consentement au règlement de l'Ecole du sport de Vertou|Assurances|Règlement Général sur la Protection des Données.||||Prénom de l'enfant Nom de l'enfant|Statut|Cours|Date certificat médical|Total cotisation|Total payé|Total Helloasso
// =IFNA(IFNA(INDEX(FILTER(Helloasso!B:B;MINUSCULE(SUPPRESPACE(Helloasso!C:C))=MINUSCULE(SUPPRESPACE($E2));MINUSCULE(SUPPRESPACE(Helloasso!F:F))=MINUSCULE(SUPPRESPACE($F2)));1);RECHERCHEV(MINUSCULE($B2);Helloasso!D:E;2;FAUX));"")

function getToken_() {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(HELLOASSO_TOKEN_PROP_KEY);
  if (raw) {
    try {
      const { token, expiresAt } = JSON.parse(raw);
      if (token && expiresAt && Date.now() < expiresAt) return 'Bearer ' + token;
    } catch (_) { /* propriété corrompue → re-fetch */ }
  }

  for (let attempt = 0; attempt <= HELLOASSO_MAX_RETRIES; attempt++) {
    const res = UrlFetchApp.fetch(HELLOASSO_TOKEN_URL, {
      method: 'post',
      payload: {
        client_id: HELLOASSO_CLIENT_ID,
        client_secret: HELLOASSO_CLIENT_SECRET,
        grant_type: 'client_credentials',
      },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      muteHttpExceptions: true,
    });

    const code = res.getResponseCode();
    const body = res.getContentText();

    if ((code === 429 || code >= 500) && attempt < HELLOASSO_MAX_RETRIES) {
      Utilities.sleep(HELLOASSO_BACKOFF_BASE_MS * Math.pow(2, attempt));
      continue;
    }
    if (code < 200 || code >= 300) {
      throw new Error(`HelloAsso token request failed (${code}): ${body}`);
    }

    const data = JSON.parse(body);
    const ttlMs = Math.max(60000, (data.expires_in || 1800) * 1000 - HELLOASSO_TOKEN_TTL_SAFETY_MS);
    const expiresAt = Date.now() + ttlMs;
    props.setProperty(HELLOASSO_TOKEN_PROP_KEY, JSON.stringify({ token: data.access_token, expiresAt }));
    return 'Bearer ' + data.access_token;
  }
}

function invalidateToken_() {
  PropertiesService.getScriptProperties().deleteProperty(HELLOASSO_TOKEN_PROP_KEY);
}

// -----------------------------------------------------------------------------
// Generic API fetch — handles auth, retries (401 once, 429/5xx with backoff),
// JSON parsing, error surfacing
// -----------------------------------------------------------------------------

const HELLOASSO_MAX_RETRIES = 3;
const HELLOASSO_BACKOFF_BASE_MS = 500;

function helloAssoFetch_(pathOrUrl, { method = 'get', query, payload, authRetry = true } = {}) {
  const url = buildUrl_(pathOrUrl, query);

  for (let attempt = 0; attempt <= HELLOASSO_MAX_RETRIES; attempt++) {
    const options = {
      method,
      headers: { Authorization: getToken_(), 'cache-control': 'no-cache' },
      muteHttpExceptions: true,
    };
    if (payload !== undefined) {
      options.contentType = 'application/json';
      options.payload = JSON.stringify(payload);
    }

    const res = UrlFetchApp.fetch(url, options);
    const code = res.getResponseCode();
    const body = res.getContentText();

    if (code === 401 && authRetry) {
      invalidateToken_();
      return helloAssoFetch_(pathOrUrl, { method, query, payload, authRetry: false });
    }

    if ((code === 429 || code >= 500) && attempt < HELLOASSO_MAX_RETRIES) {
      Utilities.sleep(HELLOASSO_BACKOFF_BASE_MS * Math.pow(2, attempt));
      continue;
    }

    if (code < 200 || code >= 300) {
      throw new Error(`HelloAsso ${method.toUpperCase()} ${url} → ${code}: ${body}`);
    }

    return body ? JSON.parse(body) : null;
  }
}

function buildUrl_(pathOrUrl, query) {
  const base = pathOrUrl.startsWith('http') ? pathOrUrl : HELLOASSO_API_BASE + pathOrUrl;
  if (!query || Object.keys(query).length === 0) return base;
  const qs = Object.entries(query)
    .filter(([_, v]) => v !== undefined && v !== null)
    .flatMap(([k, v]) => (Array.isArray(v) ? v.map(x => [k, x]) : [[k, v]]))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return qs ? `${base}${base.includes('?') ? '&' : '?'}${qs}` : base;
}

// -----------------------------------------------------------------------------
// Pagination helper — deux modes selon endpoint :
//   - pageIndex/pageSize : pagination[totalPages] > 0 (endpoints classiques)
//   - continuationToken  : totalPages=-1 (ex: /items?withDetails=true), token
//     opaque renvoyé dans pagination.continuationToken, à repasser en query.
// -----------------------------------------------------------------------------

function helloAssoFetchAll_(path, query = {}, pageSize = 100) {
  const out = [];
  let pageIndex = 1;
  let continuationToken;
  while (true) {
    const q = { ...query, pageSize };
    if (continuationToken) q.continuationToken = continuationToken;
    else q.pageIndex = pageIndex;

    const res = helloAssoFetch_(path, { query: q });
    const items = res.data || [];
    out.push(...items);

    const pag = res.pagination || {};
    if (pag.totalPages && pag.totalPages > 0) {
      if (pageIndex >= pag.totalPages) break;
      pageIndex++;
    } else {
      if (items.length < pageSize || !pag.continuationToken) break;
      continuationToken = pag.continuationToken;
    }
  }
  return out;
}

// =============================================================================
// URLEncode — exposed for spreadsheet use
// =============================================================================

function URLEncode(value) {
  return encodeURIComponent(String(value));
}

// =============================================================================
// IMPORTHELLOASSO — GET HelloAsso REST endpoint, flatten JSON to 2D for Sheets.
// Utilisable de deux manières :
//   1. =IMPORTHELLOASSO(url, query, options) directement dans une cellule
//      (custom function — refresh auto par Sheets).
//   2. Menu "Import HelloAsso" → prompt URL → écrit dans feuille active
//      (menuImportHelloAsso ci-dessous).
// JSON-flattening helpers live in json-to-2d.js.
//
// Restrictions custom function : pas de LockService (cf. getToken_),
// PropertiesService.getScriptProperties() et CacheService OK.
// =============================================================================

/**
 * GET a HelloAsso endpoint and return the JSON flattened to a 2D array.
 *
 * @param {string} url     Full HelloAsso URL or relative path (starting with /).
 * @param {string} query   Comma-separated XPath-like prefixes to include.
 * @param {string} options Comma-separated options: noInherit, noTruncate, rawHeaders, noHeaders, debugLocation.
 * @return {Array<Array<*>>} 2D array, headers in row 0 unless noHeaders.
 * @customfunction
 */
function IMPORTHELLOASSO(url, query, options) {
  const object = helloAssoFetch_(url);
  return parseJSONObject_(object, query, options, includeXPath_, defaultTransform_);
}

/**
 * GET tous les items du formulaire Membership de la campagne courante,
 * pagination incluse, et retourne un 2D array pour Sheets.
 *
 * Slug + asso lus depuis config.js (HELLOASSO_ASSO_SLUG / HELLOASSO_CAMPAIGN_SLUG).
 * Pour changer de saison/campagne : éditer HELLOASSO_CAMPAIGN_SLUG dans config.js.
 *
 * @return {Array<Array<*>>} 2D array, headers en row 0.
 * @customfunction
 */
function IMPORTHELLOITEMS() {
  const path = `/organizations/${HELLOASSO_ASSO_SLUG}/forms/Membership/${HELLOASSO_CAMPAIGN_SLUG}/items`;
  const items = helloAssoFetchAll_(path);
  return parseJSONObject_(items, undefined, undefined, includeXPath_, defaultTransform_);
}

/**
 * Vue résumée des items Membership : 7 colonnes sélectionnées.
 * customFields lookup par nom (pas index) — résiste aux changements d'ordre.
 *
 * @return {Array<Array<*>>} 2D array, headers en row 0.
 * @customfunction
 */
function IMPORTHELLOITEMS_SUMMARY() {
  const path = `/organizations/${HELLOASSO_ASSO_SLUG}/forms/Membership/${HELLOASSO_CAMPAIGN_SLUG}/items`;
  const items = helloAssoFetchAll_(path, { withDetails: true });

  const header = ['Date', 'Nom', 'Prénom', 'Email payeur', 'Montant (€)', "Nom de l'enfant", "Prénom de l'enfant"];
  const cf = (item, name) => {
    const f = (item.customFields || []).find(c => c.name === name);
    return f ? f.answer : '';
  };
  const fmtDate = s => s ? s.slice(0, 10) + ' ' + s.slice(11, 19) : '';
  const rows = items.map(it => [
    fmtDate(it.order && it.order.date),
    (it.user && it.user.lastName) || '',
    (it.user && it.user.firstName) || '',
    (it.payer && it.payer.email) || '',
    (it.amount || 0) / 100,
    cf(it, "Nom de l'enfant"),
    cf(it, "Prénom de l'enfant"),
  ]);
  return [header, ...rows];
}

function menuImportHelloAsso_toSheet_(url, query, options) {
  const object = helloAssoFetch_(url);
  const rows = parseJSONObject_(object, query, options, includeXPath_, defaultTransform_);
  if (!rows || rows.length === 0) {
    SpreadsheetApp.getUi().alert('No data returned.');
    return;
  }
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const cell = sheet.getActiveCell();
  sheet.getRange(cell.getRow(), cell.getColumn(), rows.length, rows[0].length)
    .setValues(rows);
}

function menuImportHelloAsso() {
  const url = `/organizations/${HELLOASSO_ASSO_SLUG}/forms/Membership/${HELLOASSO_CAMPAIGN_SLUG}/items?pageSize=100&pageIndex=1`;
  menuImportHelloAsso_toSheet_(url);
}

// =============================================================================
// Debug helpers — zero-arg wrappers pour Run/Debug depuis l'éditeur Apps Script.
// Éditer les paramètres hardcodés en tête de chaque fonction, sélectionner la
// fonction dans la dropdown de l'éditeur, cliquer Run (▶) ou Debug (🐞).
// Poser des breakpoints dans getToken_ / helloAssoFetch_ / parseJSONObject_
// pour inspecter step-by-step. Sortie via Logger.log → "Journal d'exécution".
//
// Pas de suffix `_` : ces fonctions sont volontairement listées dans la dropdown
// "Select function" de l'éditeur (cf. convention CLAUDE.md / README).
// =============================================================================

function debugToken() {
  Logger.log(getToken_());
}

function debugHelloAssoFetch() {
  const path = `/organizations/${HELLOASSO_ASSO_SLUG}/orders`;
  const json = helloAssoFetch_(path);
  Logger.log(JSON.stringify(json, null, 2));
}

function debugImportHelloAsso() {
  const url = `/organizations/${HELLOASSO_ASSO_SLUG}/orders`;
  const query = '/data/payer';
  const options = 'noTruncate';

  const object = helloAssoFetch_(url);
  const rows = parseJSONObject_(object, query, options, includeXPath_, defaultTransform_);
  Logger.log(JSON.stringify(rows, null, 2));
}

function debugImportHelloItemsSummary() {
  const t0 = Date.now();
  const path = `/organizations/${HELLOASSO_ASSO_SLUG}/forms/Membership/${HELLOASSO_CAMPAIGN_SLUG}/items`;
  const items = helloAssoFetchAll_(path, { withDetails: true });
  const t1 = Date.now();
  Logger.log(`Fetched ${items.length} items in ${t1 - t0}ms`);
  Logger.log(`First item keys: ${items[0] ? Object.keys(items[0]).join(', ') : '(none)'}`);
  Logger.log(JSON.stringify(items.slice(0, 2), null, 2));
}
