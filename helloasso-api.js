// =============================================================================
// HelloAsso API client
// Doc: https://api.helloasso.com/v5/swagger/index.html
// =============================================================================

const HELLOASSO_API_BASE = 'https://api.helloasso.com/v5';
const HELLOASSO_TOKEN_URL = 'https://api.helloasso.com/oauth2/token';
const HELLOASSO_TOKEN_CACHE_KEY = 'helloasso_access_token';
const HELLOASSO_TOKEN_TTL_SAFETY = 60; // refresh 60s before expiry

// -----------------------------------------------------------------------------
// Credentials — stored in ScriptProperties, NEVER hardcoded
// Setup once from the script editor:
//   setHelloAssoCredentials('your_client_id', 'your_client_secret');
// Then delete the call line.
// -----------------------------------------------------------------------------

let HELLOASSO_CREDENTIALS_CACHE_ = null;

function setHelloAssoCredentials(clientId, clientSecret) {
  PropertiesService.getScriptProperties().setProperties({
    HELLOASSO_CLIENT_ID: clientId,
    HELLOASSO_CLIENT_SECRET: clientSecret,
  });
  HELLOASSO_CREDENTIALS_CACHE_ = { clientId, clientSecret };
}

function getHelloAssoCredentials_() {
  if (HELLOASSO_CREDENTIALS_CACHE_) return HELLOASSO_CREDENTIALS_CACHE_;
  const props = PropertiesService.getScriptProperties();
  const clientId = props.getProperty('HELLOASSO_CLIENT_ID');
  const clientSecret = props.getProperty('HELLOASSO_CLIENT_SECRET');
  if (!clientId || !clientSecret) {
    throw new Error(
      'HelloAsso credentials missing. Run setHelloAssoCredentials(id, secret) once.'
    );
  }
  HELLOASSO_CREDENTIALS_CACHE_ = { clientId, clientSecret };
  return HELLOASSO_CREDENTIALS_CACHE_;
}

// -----------------------------------------------------------------------------
// Token (cached)
// -----------------------------------------------------------------------------

function getToken_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(HELLOASSO_TOKEN_CACHE_KEY);
  if (cached) return 'Bearer ' + cached;

  // Pas de LockService ici : interdit en contexte custom function
  // (=IMPORTHELLOASSO en cellule) — lève une exception qui casse l'appel.
  // Race condition acceptée : si plusieurs appels parallèles ratent le cache
  // simultanément, chacun POSTe /oauth2/token et le dernier write gagne dans
  // le cache. Conséquence bénigne (quelques appels OAuth gaspillés, pas de
  // corruption). Rate-limit HelloAsso assez généreux pour absorber.
  const { clientId, clientSecret } = getHelloAssoCredentials_();
  const res = UrlFetchApp.fetch(HELLOASSO_TOKEN_URL, {
    method: 'post',
    payload: {
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  const body = res.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error(`HelloAsso token request failed (${code}): ${body}`);
  }

  const data = JSON.parse(body);
  const ttl = Math.max(60, (data.expires_in || 1800) - HELLOASSO_TOKEN_TTL_SAFETY);
  cache.put(HELLOASSO_TOKEN_CACHE_KEY, data.access_token, Math.min(ttl, 21600));
  return 'Bearer ' + data.access_token;
}

function invalidateToken_() {
  CacheService.getScriptCache().remove(HELLOASSO_TOKEN_CACHE_KEY);
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
// Pagination helper — HelloAsso uses pageIndex / pageSize, total in `pagination`
// -----------------------------------------------------------------------------

function helloAssoFetchAll_(path, query = {}, pageSize = 100) {
  const out = [];
  let pageIndex = 1;
  while (true) {
    const res = helloAssoFetch_(path, { query: { ...query, pageIndex, pageSize } });
    const items = res.data || [];
    out.push(...items);
    const totalPages = res.pagination && res.pagination.totalPages;
    if (totalPages ? pageIndex >= totalPages : items.length < pageSize) break;
    pageIndex++;
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
// Must be called from menu (not as @customfunction) because the auth chain
// needs PropertiesService / CacheService / LockService — all blocked in the
// custom-function sandbox.
// JSON-flattening helpers live in json-to-2d.js.
// =============================================================================

function importHelloAsso_toSheet_(url, query, options) {
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

function importHelloAsso() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.prompt(
    'Import HelloAsso',
    'Full URL or path (starting with /):',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  const url = resp.getResponseText().trim();
  if (!url) return;
  importHelloAsso_toSheet_(url);
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
  const path = '/organizations/<your-asso-slug>/orders';
  const json = helloAssoFetch_(path);
  Logger.log(JSON.stringify(json, null, 2));
}

function debugImportHelloAsso() {
  const url = '/organizations/<your-asso-slug>/orders';
  const query = '/data/payer';
  const options = 'noTruncate';

  const object = helloAssoFetch_(url);
  const rows = parseJSONObject_(object, query, options, includeXPath_, defaultTransform_);
  Logger.log(JSON.stringify(rows, null, 2));
}
