/**
 * End-to-End-Test ohne echte Nuki-API und ohne externen Postgres.
 * Nutzt PGlite (Postgres im Prozess) und lokale HTTP-Mocks.
 * Start:  npm test
 */
import http from 'node:http';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

process.env.NODE_ENV = 'test';
process.env.NUKI_API_TOKEN = 'testtoken';
process.env.SAMPLE_INTERVAL_MINUTES = '0';
process.env.ALERT_AFTER_MINUTES = '0';
process.env.FLEET_ALERT_THRESHOLD = '2';
process.env.POLL_INTERVAL_SECONDS = '60';
process.env.NUKI_WEBHOOK_SECRET = 'webhookgeheim';
process.env.NUKI_CLIENT_ID = 'clientid';
process.env.NUKI_CLIENT_SECRET = 'clientsecret';
process.env.PUBLIC_URL = 'https://nuki.example.com';

// --- Nuki-Mock ---------------------------------------------------------
let fleet = [
  { smartlockId: 111, name: 'Villa Nord', type: 4, firmwareVersion: 329988, hardwareVersion: 3, serverState: 0,
    state: { state: 1, batteryCharge: 82, batteryCritical: false, doorsensorState: 3 } },
  { smartlockId: 222, name: 'Chalet Sued', type: 4, firmwareVersion: 329732, hardwareVersion: 3, serverState: 0,
    state: { state: 3, batteryCharge: 40, batteryCritical: false, doorsensorState: 2 } }
];

let oauthCalls = [];
const nukiMock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url.startsWith('/oauth/token')) {
      oauthCalls.push({ url: req.url, auth: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ access_token: 'token-mit-scope', expires_in: 3600 }));
    }
    if (req.url === '/api/decentralWebhook' && req.method === 'PUT') {
      const parsed = JSON.parse(body);
      oauthCalls.push({ register: parsed, auth: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 987654321, secret: 'frisches-secret', webhookUrl: parsed.webhookUrl, webhookFeatures: parsed.webhookFeatures }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(fleet));
  });
});
await new Promise((r) => nukiMock.listen(4721, r));
process.env.NUKI_BASE_URL = 'http://127.0.0.1:4721';

// --- Webhook-Mock ------------------------------------------------------
const received = [];
const hookMock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ secret: req.headers['x-monitor-secret'], payload: JSON.parse(body) });
    res.writeHead(200).end('ok');
  });
});
await new Promise((r) => hookMock.listen(4722, r));
process.env.ALERT_WEBHOOK_URL = 'http://127.0.0.1:4722/hook';
process.env.ALERT_WEBHOOK_SECRET = 'geheim';
process.env.PROBE_TOKEN = 'probetoken';

// --- Postgres im Prozess ----------------------------------------------
const pglite = await PGlite.create();
const db = await import('../src/db.js');
db.setClient({
  query: async (text, params = []) => {
    if (text.includes('create table')) {
      await pglite.exec(text);
      return { rows: [] };
    }
    return pglite.query(text, params);
  }
});

await db.migrate();
console.log('✓ Schema angelegt');

const { pollOnce } = await import('../src/poller.js');
const { buildOutages, buildCoverage, batteryTrend, compareWindows, buildOverview } = await import('../src/analysis.js');
const { app } = await import('../server.js');
await new Promise((r) => app.listen(4723, r));

const api = async (path, options = {}) => {
  const res = await fetch('http://127.0.0.1:4723' + path, options);
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
};

// --- Erstaufnahme ------------------------------------------------------
let result = await pollOnce();
assert.equal(result.ok, true);
assert.equal(result.devices, 2);
console.log('✓ Erstaufnahme: 2 Schloesser');

// --- Standorte und Zuordnung ------------------------------------------
const site = await db.createSite({ name: 'Villa Nord', router_model: 'Internet-Box 4', wpa_mode: 'WPA2/WPA3', wifi_channel: 'auto' });
await db.assignDevice(111, site.id);
const sites = await db.listSites();
assert.equal(sites[0].device_count, 1);
console.log('✓ Standort angelegt und Schloss zugeordnet');

// --- Ausfall loest Alarm und Webhook aus -------------------------------
fleet = structuredClone(fleet);
fleet[0].serverState = 4;
await pollOnce();

const offlineHook = received.find((r) => r.payload.type === 'lock_offline');
assert.ok(offlineHook, 'kein lock_offline-Webhook');
assert.equal(offlineHook.secret, 'geheim');
assert.equal(offlineHook.payload.site, 'Villa Nord');
assert.match(offlineHook.payload.message, /Villa Nord/);
console.log('✓ Ausfall erzeugt Alarm und Webhook mit Standort und Secret');

// --- Kein doppelter Alarm ---------------------------------------------
await pollOnce();
assert.equal(received.filter((r) => r.payload.type === 'lock_offline').length, 1, 'Alarm wurde doppelt gesendet');
console.log('✓ Alarm wird nicht wiederholt');

// --- Flaechenalarm bei zwei gleichzeitigen Ausfaellen -------------------
fleet = structuredClone(fleet);
fleet[1].serverState = 4;
await pollOnce();
const fleetHook = received.find((r) => r.payload.type === 'fleet_outage');
assert.ok(fleetHook, 'kein fleet_outage-Webhook');
assert.equal(fleetHook.payload.devices_affected, 2);
console.log('✓ Zwei gleichzeitige Ausfaelle loesen den Flaechenalarm aus');

// --- Rueckkehr schliesst die Alarme ------------------------------------
fleet = structuredClone(fleet);
fleet[0].serverState = 0;
fleet[1].serverState = 0;
fleet[1].firmwareVersion = 329988;
await pollOnce();
assert.ok(received.some((r) => r.payload.type === 'lock_recovered'), 'kein Recovery-Webhook');
const open = (await db.listAlerts(20)).filter((a) => !a.closed_at && a.scope === 'device');
assert.equal(open.length, 0, 'Geraetealarm wurde nicht geschlossen');
console.log('✓ Rueckkehr schliesst den Alarm und meldet Entwarnung');

// --- Vergleich vor und nach einer Aenderung ----------------------------
const applied = new Date(Date.now() - 60 * 60 * 1000);
const before = [
  { smartlock_id: '111', kind: 'offline', occurred_at: new Date(applied.getTime() - 50 * 60000).toISOString() },
  { smartlock_id: '111', kind: 'online', occurred_at: new Date(applied.getTime() - 40 * 60000).toISOString() },
  { smartlock_id: '111', kind: 'offline', occurred_at: new Date(applied.getTime() - 30 * 60000).toISOString() },
  { smartlock_id: '111', kind: 'online', occurred_at: new Date(applied.getTime() - 20 * 60000).toISOString() }
];
const comparison = compareWindows({
  deviceIds: ['111'], beforeEvents: before, afterEvents: [], applied: applied.toISOString(), hours: 1
});
assert.equal(comparison.before.disconnects, 2);
assert.equal(comparison.after.disconnects, 0);
assert.equal(comparison.verdict, 'deutlich besser');
assert.equal(comparison.complete, true);
console.log('✓ Vergleich erkennt die Verbesserung nach einer Aenderung');

const early = compareWindows({ deviceIds: ['111'], beforeEvents: before, afterEvents: [], applied: new Date().toISOString(), hours: 72 });
assert.equal(early.verdict, 'zu früh');
console.log('✓ Zu frueher Vergleich wird als solcher gekennzeichnet');

// --- Messluecken -------------------------------------------------------
const from = new Date('2026-01-01T00:00:00Z');
const to = new Date('2026-01-01T04:00:00Z');
const coverage = buildCoverage(
  [{ started_at: '2026-01-01T00:01:00Z' }, { started_at: '2026-01-01T03:00:00Z' }],
  from, to
);
assert.equal(coverage.gaps.length, 2, 'Luecken nicht erkannt');
assert.ok(coverage.coverage < 0.3, 'Abdeckung falsch berechnet');
console.log('✓ Messluecken werden erkannt und die Abdeckung sinkt');

const dense = buildCoverage(
  Array.from({ length: 241 }, (_, i) => ({ started_at: new Date(from.getTime() + i * 60000).toISOString() })),
  from, to
);
assert.equal(dense.gaps.length, 0);
assert.equal(dense.coverage, 1);
console.log('✓ Lueckenlose Messung ergibt volle Abdeckung');

// --- Akkuverlauf -------------------------------------------------------
const trend = batteryTrend([
  { sampled_at: '2026-01-01T00:00:00Z', battery_charge: 90 },
  { sampled_at: '2026-01-06T00:00:00Z', battery_charge: 60 }
]);
assert.equal(trend.per_day, -6);
console.log('✓ Akkuverlauf wird als Prozentpunkte pro Tag berechnet');

// --- Sonden-Ingest -----------------------------------------------------
let probe = await api('/api/probe', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Probe-Token': 'probetoken' },
  body: JSON.stringify({ site: 'Villa Nord', samples: [
    { reachable: true, rtt_ms: 4.2, target: '192.168.1.42' },
    { reachable: false, rtt_ms: null, target: '192.168.1.42' }
  ] })
});
assert.equal(probe.status, 200);
assert.equal(probe.body.stored, 2);

const badToken = await api('/api/probe', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Probe-Token': 'falsch' },
  body: JSON.stringify({ site: 'Villa Nord', reachable: true })
});
assert.equal(badToken.status, 401);

const summary = await db.probeSummary(new Date(Date.now() - 86400000));
assert.equal(summary[0].samples, 2);
assert.equal(summary[0].failures, 1);
console.log('✓ Sonde: Ingest, Tokenpruefung und Auswertung');

// --- HTTP-Endpunkte ----------------------------------------------------
const ov = await api('/api/overview?days=7');
assert.equal(ov.status, 200);
assert.equal(ov.body.summary.devices, 2);
assert.equal(ov.body.summary.unassigned_devices, 1);
assert.ok(ov.body.sites.some((s) => s.site === 'Villa Nord'));
assert.ok(ov.body.coverage);

const change = await api('/api/changes', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: 'WPA2 gesetzt', site_id: site.id, applied_at: applied.toISOString() })
});
assert.equal(change.status, 200);

const compare = await api(`/api/compare?id=${change.body.id}&hours=1`);
assert.equal(compare.status, 200);
assert.equal(compare.body.devices, 1);

const csv = await api('/api/export/summary.csv?days=7');
assert.equal(csv.status, 200);
assert.ok(csv.body.includes('Standort;Schloss'), 'CSV-Kopfzeile fehlt');
assert.ok(csv.body.includes('Villa Nord'));

const outages = await api('/api/export/outages.csv?days=7');
assert.ok(outages.body.includes('Beginn;Ende'), 'Ausfall-CSV fehlerhaft');

assert.equal((await api('/')).status, 200);
assert.equal((await api('/setup')).status, 200);
assert.equal((await api('/healthz')).status, 200);
assert.equal((await api('/api/device?id=999')).status, 404);
console.log('✓ HTTP: Overview, Vergleich, CSV-Export, Seiten und Fehlerfaelle');

// --- Randfaelle der Ausfallberechnung ----------------------------------
const carried = buildOutages([{ kind: 'online', occurred_at: '2026-01-01T06:00:00Z' }],
  new Date('2026-01-01T00:00:00Z'), new Date('2026-01-02T00:00:00Z'), true);
assert.equal(carried.downtime_ms, 6 * 3600e3);

const ongoing = buildOutages([{ kind: 'offline', occurred_at: '2026-01-01T18:00:00Z' }],
  new Date('2026-01-01T00:00:00Z'), new Date('2026-01-02T00:00:00Z'), false);
assert.equal(ongoing.outages[0].ongoing, true);
console.log('✓ Randfaelle: Ausfall vor dem Fenster und laufender Ausfall');

// --- Webhook-Ausfall darf das Polling nicht stoppen --------------------
process.env.ALERT_WEBHOOK_URL = 'http://127.0.0.1:1/tot';
const alerts = await import('../src/alerts.js?bust=2');
const failed = await alerts.notify({ type: 'test' });
assert.equal(failed.ok, false);
assert.equal((await pollOnce()).ok, true);
console.log('✓ Kaputter Webhook stoppt das Polling nicht');

// --- Webhooks ----------------------------------------------------------
const crypto = await import('node:crypto');
const { verifySignature } = await import('../src/webhook.js');

const sign = (body) => crypto.createHmac('sha256', 'webhookgeheim').update(body).digest('hex');
const postHook = (payload, signature) => {
  const body = JSON.stringify(payload);
  return api('/api/nuki/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Nuki-Signature-SHA256': signature ?? sign(body) },
    body
  });
};

assert.equal(verifySignature(Buffer.from('abc'), sign('abc')), true);
assert.equal(verifySignature(Buffer.from('abc'), sign('xyz')), false);
assert.equal(verifySignature(Buffer.from('abc'), undefined), false);
assert.equal(verifySignature(Buffer.from('abc'), 'kurz'), false);
console.log('✓ Signaturpruefung akzeptiert nur korrekte HMACs');

const rejected = await postHook({ feature: 'DEVICE_STATUS', smartlockId: 111, serverState: 4 }, 'falsch');
assert.equal(rejected.status, 401);
console.log('✓ Falsch signierter Webhook wird abgewiesen');

// serverState 4 = echter Ausfall
const beforeOffline = (await db.eventsSince(new Date(Date.now() - 3600e3), ['offline'])).length;
let hook = await postHook({ feature: 'DEVICE_STATUS', smartlockId: 111, serverState: 4, state: { state: 1, batteryCharge: 80 } });
assert.equal(hook.status, 200);
await new Promise((r) => setTimeout(r, 200));
const afterOffline = (await db.eventsSince(new Date(Date.now() - 3600e3), ['offline'])).length;
assert.equal(afterOffline, beforeOffline + 1, 'offline-Ereignis aus Webhook fehlt');
const src = (await db.eventsSince(new Date(Date.now() - 3600e3), ['offline'])).at(-1).source;
assert.equal(src, 'webhook');
console.log('✓ serverState 4 aus dem Webhook erzeugt ein offline-Ereignis mit Quelle webhook');

// serverState 2 = Konfigurationsproblem, KEIN Ausfall
await postHook({ feature: 'DEVICE_STATUS', smartlockId: 222, serverState: 2, state: { state: 3 } });
await new Promise((r) => setTimeout(r, 200));
const broken = await db.eventsSince(new Date(Date.now() - 3600e3), ['connection_broken']);
assert.equal(broken.length, 1, 'connection_broken fehlt');
const stillNoExtraOffline = await db.eventsSince(new Date(Date.now() - 3600e3), ['offline']);
assert.equal(stillNoExtraOffline.length, afterOffline, 'serverState 2 wurde faelschlich als Ausfall gezaehlt');
console.log('✓ serverState 2 zaehlt als Konfigurationsproblem, nicht als Ausfall');

// Firmware ueber MASTERDATA
await postHook({ feature: 'DEVICE_MASTERDATA', smartlockId: 111, firmwareVersion: 133135, name: 'Villa Nord' });
await new Promise((r) => setTimeout(r, 200));
const fwEvents = await db.eventsSince(new Date(Date.now() - 3600e3), ['firmware_changed']);
const last = fwEvents.at(-1);
assert.equal(last.detail.to, '2.8.15', 'Firmware-Dekodierung stimmt nicht mit dem Beispiel aus der Nuki-Doku ueberein');
console.log('✓ Firmware 133135 wird zu 2.8.15 dekodiert, wie im Nuki-Beispiel');

// Aktivitaetsprotokoll
await postHook({ feature: 'DEVICE_LOGS', smartlockLog: { smartlockId: 111, action: 1, trigger: 255, state: 0, name: 'Keypad Gast' } });
await new Promise((r) => setTimeout(r, 200));
const activity = await db.eventsSince(new Date(Date.now() - 3600e3), ['activity']);
assert.equal(activity.length, 1);
assert.equal(activity[0].detail.trigger, 255);
console.log('✓ Aktivitaetsprotokoll aus dem Webhook wird gespeichert');

// Unbekanntes Feature geht nicht verloren
await postHook({ feature: 'DEVICE_CONFIG', smartlockId: 111, config: { name: 'x' } });
await new Promise((r) => setTimeout(r, 200));
assert.equal((await db.eventsSince(new Date(Date.now() - 3600e3), ['webhook_other'])).length, 1);
console.log('✓ Unbekanntes Feature wird protokolliert statt verworfen');

// Kaputtes JSON darf keine 500 erzeugen: Nuki stellt bei Fehlerraten die Zustellung ein
const brokenBody = '{nicht json';
const brokenRes = await api('/api/nuki/webhook', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Nuki-Signature-SHA256': sign(brokenBody) },
  body: brokenBody
});
assert.equal(brokenRes.status, 200, 'kaputtes JSON muss trotzdem 200 liefern');
console.log('✓ Kaputter Payload liefert 200, damit Nuki die Zustellung nicht abschaltet');

const health = await api('/api/health');
assert.equal(health.body.webhooks.enabled, true);
assert.ok(health.body.webhooks.total_24h > 0);
assert.ok(health.body.webhooks.signature_failures_24h >= 1);
console.log('✓ Webhook-Zustand wird protokolliert und ist abrufbar');

// --- OAuth-Ablauf ------------------------------------------------------
const oauthModule = await import('../src/oauth.js');
assert.equal(oauthModule.redirectUri(), 'https://nuki.example.com/oauth/callback');
assert.equal(oauthModule.webhookTarget(), 'https://nuki.example.com/api/nuki/webhook');
assert.equal(oauthModule.configProblem(), null);

const authUrl = oauthModule.authorizeUrl('teststate');
assert.ok(authUrl.includes('scope=smartlock+smartlock.auth+account+webhook.decentral'), 'Scope fehlt in der Autorisierungs-URL');
assert.ok(authUrl.includes('redirect_uri=https%3A%2F%2Fnuki.example.com%2Foauth%2Fcallback'));
console.log('✓ Autorisierungs-URL enthaelt Scope und Redirect URI');

const st = oauthModule.createState();
assert.equal(oauthModule.consumeState(st), true);
assert.equal(oauthModule.consumeState(st), false, 'State darf nur einmal gelten');
assert.equal(oauthModule.consumeState('untergeschoben'), false);
console.log('✓ State gilt genau einmal und schuetzt vor fremden Rueckrufen');

const badState = await api('/oauth/callback?code=abc&state=gefaelscht');
assert.equal(badState.status, 400);
assert.ok(String(badState.body).includes('Nochmal verbinden'));

const denied = await api('/oauth/callback?error=access_denied');
assert.equal(denied.status, 400);

const noCode = await api('/oauth/callback?state=x');
assert.equal(noCode.status, 400);
assert.ok(String(noCode.body).includes('nuki.example.com/oauth/callback'), 'Fehlerseite nennt die erwartete Redirect URI nicht');
console.log('✓ Fehlerfaelle des Rueckrufs werden verstaendlich beantwortet');

// Vollstaendiger Durchlauf mit gueltigem State
const goodState = oauthModule.createState();
oauthCalls = [];
const done = await api(`/oauth/callback?code=echter-code&state=${goodState}`);
assert.equal(done.status, 200);
assert.ok(String(done.body).includes('Webhook eingerichtet'));

const tokenCall = oauthCalls.find((c) => c.url?.startsWith('/oauth/token'));
assert.ok(tokenCall, 'Code wurde nicht getauscht');
assert.equal(tokenCall.auth, 'Basic ' + Buffer.from('clientid:clientsecret').toString('base64'));

const registerCall = oauthCalls.find((c) => c.register);
assert.ok(registerCall, 'Webhook wurde nicht registriert');
assert.equal(registerCall.register.webhookUrl, 'https://nuki.example.com/api/nuki/webhook');
assert.deepEqual(registerCall.register.webhookFeatures, ['DEVICE_STATUS', 'DEVICE_MASTERDATA', 'DEVICE_LOGS']);
assert.equal(registerCall.auth, 'Bearer token-mit-scope');
console.log('✓ Rueckruf tauscht den Code, registriert den Webhook und meldet Erfolg');

// Das neue Secret muss sofort fuer die Signaturpruefung gelten
const storedSecret = await db.getSetting('nuki_webhook_secret');
assert.equal(storedSecret, 'frisches-secret');
const newSig = (body) => crypto.createHmac('sha256', 'frisches-secret').update(body).digest('hex');
const withNew = JSON.stringify({ feature: 'DEVICE_STATUS', smartlockId: 111, serverState: 0, state: { state: 1 } });
const accepted = await api('/api/nuki/webhook', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Nuki-Signature-SHA256': newSig(withNew) },
  body: withNew
});
assert.equal(accepted.status, 200);
const withOld = await api('/api/nuki/webhook', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Nuki-Signature-SHA256': sign(withNew) },
  body: withNew
});
assert.equal(withOld.status, 401, 'Das alte Secret darf nach der Registrierung nicht mehr gelten');
console.log('✓ Neues Secret gilt sofort, das alte wird abgewiesen');

const status = await api('/api/webhook-status');
assert.equal(status.body.registration.id, '987654321');
assert.equal(status.body.oauth_ready, true);
console.log('✓ Registrierung ist ueber den Statusendpunkt sichtbar');

nukiMock.close();
hookMock.close();
app.close();
await pglite.close();
console.log('\nAlle Tests bestanden.');
