import crypto from 'node:crypto';
import { getSetting, setSetting } from './db.js';
import { storeSecret } from './webhook.js';

const BASE_URL = process.env.NUKI_BASE_URL || 'https://api.nuki.io';
const CLIENT_ID = process.env.NUKI_CLIENT_ID || '';
const CLIENT_SECRET = process.env.NUKI_CLIENT_SECRET || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

// Nur die Features, die dieser Monitor auswertet. Nuki empfiehlt ausdruecklich,
// ungenutzte Features abzuschalten, um die Zahl der Webhooks klein zu halten.
const FEATURES = ['DEVICE_STATUS', 'DEVICE_MASTERDATA', 'DEVICE_LOGS'];
const SCOPES = 'smartlock smartlock.auth account webhook.decentral';

export const oauthConfigured = () => Boolean(CLIENT_ID && CLIENT_SECRET && PUBLIC_URL);

export const redirectUri = () => `${PUBLIC_URL}/oauth/callback`;
export const webhookTarget = () => `${PUBLIC_URL}/api/nuki/webhook`;

export function configProblem() {
  if (!CLIENT_ID) return 'NUKI_CLIENT_ID fehlt.';
  if (!CLIENT_SECRET) return 'NUKI_CLIENT_SECRET fehlt.';
  if (!PUBLIC_URL) return 'PUBLIC_URL fehlt.';
  if (!PUBLIC_URL.startsWith('https://')) return 'PUBLIC_URL muss mit https:// beginnen.';
  return null;
}

// Kurzlebige State-Werte gegen untergeschobene Callbacks. Bewusst nur im
// Speicher: laeuft die App neu an, muss der Ablauf ohnehin neu gestartet werden.
const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

export function createState() {
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now());
  for (const [key, at] of pendingStates) {
    if (Date.now() - at > STATE_TTL_MS) pendingStates.delete(key);
  }
  return state;
}

export function consumeState(state) {
  if (!state || !pendingStates.has(state)) return false;
  const at = pendingStates.get(state);
  pendingStates.delete(state);
  return Date.now() - at <= STATE_TTL_MS;
}

export function authorizeUrl(state) {
  const params = new URLSearchParams({
    response_type: 'code',
    scope: SCOPES,
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    state
  });
  return `${BASE_URL}/oauth/authorize?${params.toString()}`;
}

/**
 * Tauscht den Code gegen ein Access Token. Client ID und Secret gehen als
 * Basic Auth mit.
 *
 * Wichtig zur Kodierung: URLSearchParams schreibt Leerzeichen bereits als "+".
 * Wer die Leerzeichen vorher selbst durch "+" ersetzt, erzeugt "%2B" und
 * damit einen kaputten Scope - Nuki antwortet darauf mit einem 500er.
 */
function tokenParams(code) {
  return new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    scope: SCOPES
  });
}

const basicAuth = () =>
  'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

async function requestToken(code, { inBody }) {
  const params = tokenParams(code);
  const url = inBody ? `${BASE_URL}/oauth/token` : `${BASE_URL}/oauth/token?${params.toString()}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      Accept: 'application/json',
      Authorization: basicAuth()
    },
    body: inBody ? params.toString() : undefined
  });

  return { ok: res.ok, status: res.status, text: await res.text() };
}

export async function exchangeCode(code) {
  // Nukis Dokumentation beschreibt die Parameter in der Query ohne Body.
  // Schlaegt das fehl, wird der uebliche OAuth-Weg mit Body versucht.
  let response = await requestToken(code, { inBody: false });
  if (!response.ok) {
    const retry = await requestToken(code, { inBody: true });
    if (retry.ok) response = retry;
    else {
      throw new Error(
        `Nuki lehnte den Code-Tausch ab (${response.status}): ${response.text.slice(0, 300)}. ` +
          'Häufigste Ursachen: Die Redirect URI in Nuki Web weicht von ' +
          `${redirectUri()} ab, der Code wurde bereits eingelöst, oder Client ID und Secret passen nicht zusammen.`
      );
    }
  }

  let data;
  try {
    data = JSON.parse(response.text);
  } catch {
    throw new Error('Antwort auf den Code-Tausch war kein JSON.');
  }

  if (!data.access_token) throw new Error('Die Antwort enthielt kein access_token.');
  return data;
}

/** Registriert den dezentralen Webhook und legt das Secret in der Datenbank ab. */
export async function registerWebhook(accessToken) {
  const res = await fetch(`${BASE_URL}/api/decentralWebhook`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({ webhookUrl: webhookTarget(), webhookFeatures: FEATURES })
  });

  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Nuki verweigerte die Registrierung (${res.status}). Fehlt dem Zugang der Scope webhook.decentral oder ist der Advanced API Access noch nicht aktiv?`
      );
    }
    throw new Error(`Registrierung fehlgeschlagen (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = JSON.parse(text);
  if (!data.secret) throw new Error('Die Antwort enthielt kein secret.');

  await storeSecret(data.secret);
  await setSetting('nuki_webhook_id', String(data.id ?? ''));
  await setSetting('nuki_webhook_url', data.webhookUrl || webhookTarget());
  await setSetting('nuki_webhook_registered_at', new Date().toISOString());

  return data;
}

export async function registrationInfo() {
  const [id, url, at] = await Promise.all([
    getSetting('nuki_webhook_id'),
    getSetting('nuki_webhook_url'),
    getSetting('nuki_webhook_registered_at')
  ]);
  return { id, url, registered_at: at };
}
