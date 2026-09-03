import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as db from './src/db.js';
import { buildOverview, compareWindows, batteryTrend } from './src/analysis.js';
import { startPolling, pollOnce } from './src/poller.js';
import { notify } from './src/alerts.js';
import { verifySignature, handleWebhook, webhookHealth, webhooksEnabled, recordSignatureFailure, loadSecret, findWifiFields, redact } from './src/webhook.js';
import * as oauth from './src/oauth.js';
import { proposeAssignments, dataQualityReport } from './src/matching.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Wird beim Start protokolliert und ueber /healthz ausgeliefert. Damit laesst
// sich zweifelsfrei feststellen, ob wirklich diese App antwortet.
const APP_VERSION = JSON.parse(
  await readFile(join(__dirname, 'package.json'), 'utf8')
).version;
const PORT = process.env.PORT || 3000;
const DASHBOARD_USER = process.env.DASHBOARD_USER || '';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const PROBE_TOKEN = process.env.PROBE_TOKEN || '';

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendCsv(res, filename, rows) {
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const body = rows.map((row) => row.map(escape).join(';')).join('\r\n');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`
  });
  res.end('\uFEFF' + body);
}

function sendPage(res, status, title, body) {
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:15px;line-height:1.55;color:#000;background:#fff}
.wrap{max-width:640px;margin:0 auto;padding:40px 20px}h1{font-size:21px;font-weight:650;margin:0 0 6px}
.box{border-left:3px solid ${status === 200 ? '#f6bb12' : '#c8322b'};background:#f5f5f5;padding:14px 16px;margin:18px 0}
code{background:#f5f5f5;padding:1px 5px}a.btn{display:inline-block;border:1px solid #000;padding:6px 11px;text-decoration:none;color:#000}
a.btn:hover{background:#f6bb12}</style></head><body><div class="wrap"><h1>${title}</h1>${body}</div></body></html>`;
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function authorized(req) {
  if (!DASHBOARD_PASSWORD) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const [user, pass] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
  return user === (DASHBOARD_USER || user) && pass === DASHBOARD_PASSWORD;
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Ungueltiges JSON im Request-Body.');
  }
}

const windowFrom = (days) => new Date(Date.now() - days * 86400000);
const parseDays = (value) => Math.min(90, Math.max(1, Number(value) || 7));

async function overview(days) {
  const from = windowFrom(days);
  const to = new Date();

  const [devices, events, priorState, pollRuns, health, changes] = await Promise.all([
    db.listDevices(),
    db.eventsSince(from),
    db.stateBefore(from),
    db.pollRunsSince(from),
    db.pollHealth(),
    db.listChanges()
  ]);

  const data = buildOverview({ devices, events, priorState, pollRuns, from, to, changes });
  data.poller = health;
  data.open_alerts = (await db.listAlerts(50)).filter((a) => !a.closed_at);
  data.webhooks = await webhookHealth();
  return data;
}

async function evaluateAlertsSafely(devices) {
  try {
    const { evaluateAlerts } = await import('./src/alerts.js');
    await evaluateAlerts(devices);
  } catch (error) {
    console.error('[alerts]', error.message);
  }
}

export const app = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/healthz') {
    // Antwortet auch, solange die Datenbank noch nicht bereit ist. Damit laesst
    // sich unterscheiden, ob der Dienst laeuft oder Railway den 404 liefert.
    let database = 'unbekannt';
    try {
      await db.query('select 1');
      database = 'verbunden';
    } catch (error) {
      database = 'nicht verbunden: ' + error.message;
    }
    return sendJson(res, 200, {
      app: 'nuki-monitor',
      version: APP_VERSION,
      ok: true,
      auth_required: Boolean(DASHBOARD_PASSWORD),
      database,
      time: new Date().toISOString()
    });
  }

  // Nuki authentifiziert sich ueber die HMAC-Signatur, nicht ueber Basic Auth.
  // Diese Route muss immer schnell mit 200 antworten: Nuki warnt ab 5 Prozent
  // Fehlerrate und stellt die Zustellung bei dauerhaften Fehlern ganz ein.
  if (url.pathname === '/api/nuki/webhook' && req.method === 'POST') {
    try {
      const raw = await readRawBody(req);
      if (!verifySignature(raw, req.headers['x-nuki-signature-sha256'])) {
        await recordSignatureFailure().catch(() => {});
        return sendJson(res, 401, { error: 'Signatur ungueltig.' });
      }

      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        return sendJson(res, 200, { ignored: 'kein gueltiges JSON' });
      }

      // Sofort bestaetigen, danach verarbeiten.
      sendJson(res, 200, { received: true });
      handleWebhook(payload)
        .then(async () => {
          const devices = await db.listDevices();
          await evaluateAlertsSafely(devices);
        })
        .catch((error) => console.error('[webhook]', error.message));
      return;
    } catch (error) {
      console.error('[webhook]', error.message);
      return sendJson(res, 200, { received: false });
    }
  }

  // Die Sonde authentifiziert sich mit einem eigenen Token, nicht ueber Basic Auth.
  if (url.pathname === '/api/probe' && req.method === 'POST') {
    try {
      if (!PROBE_TOKEN || req.headers['x-probe-token'] !== PROBE_TOKEN) {
        return sendJson(res, 401, { error: 'Ungueltiges Sonden-Token.' });
      }
      const body = await readBody(req);
      const site = body.site_id
        ? { id: body.site_id }
        : body.site
          ? await db.siteByName(body.site)
          : null;
      if (!site) return sendJson(res, 400, { error: 'Standort unbekannt. Lege ihn zuerst unter /setup an.' });

      const samples = Array.isArray(body.samples) ? body.samples : [body];
      for (const sample of samples) {
        await db.insertProbeSample({
          site_id: site.id,
          measured_at: sample.measured_at,
          target: sample.target,
          reachable: sample.reachable,
          rtt_ms: sample.rtt_ms,
          source: sample.source || 'probe',
          raw: sample.raw || {}
        });
      }
      return sendJson(res, 200, { stored: samples.length });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (!authorized(req)) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Nuki Monitor", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8'
    });
    return res.end('Anmeldung erforderlich.');
  }

  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = await readFile(join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (url.pathname === '/setup' || url.pathname === '/setup.html') {
      const html = await readFile(join(__dirname, 'public', 'setup.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    if (url.pathname === '/oauth/start') {
      const problem = oauth.configProblem();
      if (problem) {
        return sendPage(res, 400, 'Zugang noch nicht vollständig', `
          <div class="box">${problem}</div>
          <p>Setze in Railway <code>NUKI_CLIENT_ID</code>, <code>NUKI_CLIENT_SECRET</code> und
          <code>PUBLIC_URL</code>. Die Werte findest du in Nuki Web unter Advanced API.</p>
          <p><a class="btn" href="/setup">Zurück</a></p>`);
      }
      // ?features=all registriert alle sechs Features fuer eine einmalige
      // Bestandsaufnahme. Danach wieder ohne den Parameter neu verbinden.
      const alle = url.searchParams.get('features') === 'all';
      res.writeHead(302, { Location: oauth.authorizeUrl(oauth.createState(alle)) });
      return res.end();
    }

    if (url.pathname === '/oauth/callback') {
      const error = url.searchParams.get('error');
      if (error) {
        return sendPage(res, 400, 'Nuki hat abgebrochen', `
          <div class="box">${error}: ${url.searchParams.get('error_description') || 'kein Grund angegeben'}</div>
          <p><a class="btn" href="/setup">Zurück</a></p>`);
      }

      const code = url.searchParams.get('code');
      if (!code) {
        return sendPage(res, 400, 'Kein Code erhalten', `
          <div class="box">Nuki hat keinen Autorisierungscode mitgeschickt.</div>
          <p>Stimmt die Redirect URI in Nuki Web exakt mit
          <code>${oauth.redirectUri()}</code> überein?</p>
          <p><a class="btn" href="/setup">Zurück</a></p>`);
      }

      const stateOptions = oauth.consumeState(url.searchParams.get('state'));
      if (!stateOptions) {
        return sendPage(res, 400, 'Abgelaufen oder nicht angefordert', `
          <div class="box">Dieser Rückruf gehört zu keinem laufenden Vorgang. Codes sind kurzlebig.</div>
          <p>Starte den Vorgang neu.</p>
          <p><a class="btn" href="/oauth/start">Nochmal verbinden</a></p>`);
      }

      try {
        const token = await oauth.exchangeCode(code);
        const registration = await oauth.registerWebhook(token.access_token, { alle: stateOptions.alle });
        return sendPage(res, 200, 'Webhook eingerichtet', `
          <div class="box">Nuki schickt Ereignisse ab sofort an
          <code>${oauth.webhookTarget()}</code>.<br>
          Registrierte Features: <code>${oauth.featureList(stateOptions.alle).join(', ')}</code></div>
          <p>Das Secret liegt in der Datenbank, du musst nichts nach Railway kopieren.
          Registrierungs-ID: <code>${registration.id ?? '—'}</code></p>
          <p>Sperre zur Probe ein Schloss über die Nuki App. Innerhalb von Sekunden
          muss im Dashboard ein Ereignis erscheinen.</p>
          <p><a class="btn" href="/">Zum Dashboard</a></p>`);
      } catch (err) {
        console.error('[oauth]', err.message);
        return sendPage(res, 500, 'Einrichtung fehlgeschlagen', `
          <div class="box">${err.message}</div>
          <p><a class="btn" href="/oauth/start">Nochmal versuchen</a></p>`);
      }
    }

    // Zeigt je Feature die zuletzt empfangene Nutzlast und alles, was nach
    // einem WLAN-Namen aussieht.
    // Loescht alle gespeicherten Rohdaten. Nach einer Bestandsaufnahme mit
    // DEVICE_AUTHS gehoert das gedrueckt - dort stehen Keypad-Codes drin.
    if (url.pathname === '/api/webhook-samples' && req.method === 'DELETE') {
      await db.query('delete from webhook_samples');
      return sendJson(res, 200, { geloescht: true });
    }

    if (url.pathname === '/api/webhook-samples' || url.pathname === '/api/webhook-samples.json') {
      const limit = Number(url.searchParams.get('limit')) || 200;
      const [samples, counts] = await Promise.all([db.webhookSamples(limit), db.webhookSampleCounts()]);

      const payload = {
        stand: new Date().toISOString(),
        gespeichert: samples.length,
        je_feature: counts,
        wlan_gefunden: samples.flatMap((s) =>
          findWifiFields(s.payload).map((f) => ({ ...f, feature: s.feature, received_at: s.received_at }))
        ),
        // Vollstaendig und ungefiltert - genau so, wie Nuki es geschickt hat.
        // Zweite Sicherung: auch bereits gespeicherte Nutzlasten werden beim
        // Ausliefern noch einmal von Codes befreit.
        samples: samples.map((s) => ({
          feature: s.feature,
          received_at: s.received_at,
          payload: redact(s.payload)
        }))
      };

      if (url.pathname.endsWith('.json')) {
        const body = JSON.stringify(payload, null, 2);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': 'attachment; filename="nuki-webhook-rohdaten.json"'
        });
        return res.end(body);
      }

      return sendJson(res, 200, payload);
    }

    if (url.pathname === '/api/webhook-status') {
      return sendJson(res, 200, {
        health: await webhookHealth(),
        registration: await oauth.registrationInfo(),
        oauth_ready: oauth.oauthConfigured(),
        oauth_problem: oauth.configProblem(),
        redirect_uri: oauth.redirectUri(),
        webhook_target: oauth.webhookTarget()
      });
    }

    if (url.pathname === '/api/overview') {
      return sendJson(res, 200, await overview(parseDays(url.searchParams.get('days'))));
    }

    if (url.pathname === '/api/device') {
      const id = url.searchParams.get('id');
      if (!id) return sendJson(res, 400, { error: 'Parameter id fehlt.' });
      const detail = await db.deviceDetail(id, windowFrom(parseDays(url.searchParams.get('days'))));
      if (!detail.device) return sendJson(res, 404, { error: 'Schloss nicht gefunden.' });
      detail.battery_trend = batteryTrend(detail.samples);
      return sendJson(res, 200, detail);
    }

    // ------------------------------------------------------------ Standorte
    if (url.pathname === '/api/sites') {
      if (req.method === 'GET') return sendJson(res, 200, { sites: await db.listSites() });
      if (req.method === 'POST') {
        const body = await readBody(req);
        // Mit id wird gezielt geaendert, ohne id angelegt oder ergaenzt.
        if (body.id) {
          const aktualisiert = await db.updateSite(Number(body.id), body);
          if (!aktualisiert) return sendJson(res, 404, { error: 'Standort nicht gefunden.' });
          return sendJson(res, 200, aktualisiert);
        }
        return sendJson(res, 200, await db.createSite(body));
      }
      if (req.method === 'DELETE') {
        await db.deleteSite(Number(url.searchParams.get('id')));
        return sendJson(res, 200, { deleted: true });
      }
    }

    // Standorte aus einer Liste anlegen oder ergaenzen, etwa aus Elev8 Suite.
    if (url.pathname === '/api/sites/import' && req.method === 'POST') {
      const body = await readBody(req);
      const sites = Array.isArray(body) ? body : body.sites;
      if (!Array.isArray(sites)) return sendJson(res, 400, { error: 'Erwartet wird eine Liste von Standorten.' });

      const created = [];
      const skipped = [];
      for (const site of sites) {
        if (!site.name) {
          skipped.push({ site, reason: 'kein Name' });
          continue;
        }
        created.push(await db.createSite(site));
      }
      return sendJson(res, 200, { imported: created.length, skipped, sites: created });
    }

    // Vorschlaege berechnen. Angewendet wird hier nichts.
    if (url.pathname === '/api/match') {
      const radius = Math.min(2000, Math.max(20, Number(url.searchParams.get('radius')) || 150));
      const [devices, sites] = await Promise.all([db.devicesForMatching(), db.sitesForMatching()]);
      const proposals = proposeAssignments({ devices, sites, radiusMeters: radius });

      return sendJson(res, 200, {
        radius_meters: radius,
        sites_with_coordinates: sites.filter((s) => s.latitude !== null && s.longitude !== null).length,
        sites_total: sites.length,
        summary: {
          sicher: proposals.filter((p) => p.confidence === 'sicher').length,
          wahrscheinlich: proposals.filter((p) => p.confidence === 'wahrscheinlich').length,
          widerspruch: proposals.filter((p) => p.confidence === 'widerspruch').length,
          unklar: proposals.filter((p) => p.confidence === 'unklar').length,
          drei_signale: proposals.filter((p) => p.agreeing_signals >= 3).length
        },
        data_quality: dataQualityReport(proposals),
        proposals
      });
    }

    // Erst hier wird zugeordnet, und nur was ausdruecklich mitgegeben wurde.
    if (url.pathname === '/api/match/apply' && req.method === 'POST') {
      const body = await readBody(req);
      const assignments = Array.isArray(body) ? body : body.assignments;
      if (!Array.isArray(assignments)) return sendJson(res, 400, { error: 'Erwartet wird eine Liste von Zuordnungen.' });

      let applied = 0;
      for (const item of assignments) {
        if (!item.smartlock_id || !item.site_id) continue;
        await db.assignDevice(item.smartlock_id, item.site_id);
        applied += 1;
      }
      return sendJson(res, 200, { applied });
    }

    if (url.pathname === '/api/assign' && req.method === 'POST') {
      const body = await readBody(req);
      await db.assignDevice(body.smartlock_id, body.site_id ?? null);
      return sendJson(res, 200, { ok: true });
    }

    // ----------------------------------------------------------- Aenderungen
    if (url.pathname === '/api/changes') {
      if (req.method === 'GET') return sendJson(res, 200, { changes: await db.listChanges() });
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (!body.title || !body.applied_at) {
          return sendJson(res, 400, { error: 'title und applied_at sind erforderlich.' });
        }
        return sendJson(res, 200, await db.createChange(body));
      }
      if (req.method === 'DELETE') {
        await db.deleteChange(Number(url.searchParams.get('id')));
        return sendJson(res, 200, { deleted: true });
      }
    }

    if (url.pathname === '/api/compare') {
      const change = await db.getChange(Number(url.searchParams.get('id')));
      if (!change) return sendJson(res, 404, { error: 'Aenderung nicht gefunden.' });

      const hours = Math.min(336, Math.max(6, Number(url.searchParams.get('hours')) || 72));
      const span = hours * 3600000;
      const applied = new Date(change.applied_at);
      const deviceIds = await db.devicesForSite(change.site_id);

      const [beforeEvents, afterEvents] = await Promise.all([
        db.eventsBetween(new Date(applied.getTime() - span), applied, ['online', 'offline']),
        db.eventsBetween(applied, new Date(applied.getTime() + span), ['online', 'offline'])
      ]);

      const result = compareWindows({
        deviceIds,
        beforeEvents,
        afterEvents,
        applied: change.applied_at,
        hours
      });

      return sendJson(res, 200, { change, ...result });
    }

    // ---------------------------------------------------------------- Alarme
    if (url.pathname === '/api/alerts') {
      return sendJson(res, 200, { alerts: await db.listAlerts(100) });
    }

    if (url.pathname === '/api/alerts/test' && req.method === 'POST') {
      const result = await notify({
        type: 'test',
        severity: 'info',
        message: 'Testalarm aus dem Nuki Monitor. Wenn du das siehst, funktioniert der Webhook.'
      });
      return sendJson(res, 200, result);
    }

    // ----------------------------------------------------------------- Sonde
    if (url.pathname === '/api/probes') {
      const from = windowFrom(parseDays(url.searchParams.get('days')));
      return sendJson(res, 200, { probes: await db.probeSummary(from) });
    }

    // ---------------------------------------------------------------- Export
    if (url.pathname === '/api/export/outages.csv') {
      const data = await overview(parseDays(url.searchParams.get('days')));
      const rows = [['Standort', 'Schloss', 'SmartlockID', 'Firmware', 'Beginn', 'Ende', 'Minuten', 'laufend']];
      for (const device of data.devices) {
        for (const outage of device.outages) {
          rows.push([
            device.site_name || '',
            device.name,
            device.smartlock_id,
            device.firmware || device.firmware_raw || '',
            outage.start,
            outage.ongoing ? '' : outage.end,
            Math.round((new Date(outage.end) - new Date(outage.start)) / 60000),
            outage.ongoing ? 'ja' : 'nein'
          ]);
        }
      }
      return sendCsv(res, 'ausfaelle.csv', rows);
    }

    if (url.pathname === '/api/export/summary.csv') {
      const data = await overview(parseDays(url.searchParams.get('days')));
      const rows = [
        ['Standort', 'Schloss', 'SmartlockID', 'Firmware', 'Router', 'WPA', 'Kanal', 'Mesh', 'Abbrueche', 'Ausfallminuten', 'Verfuegbarkeit']
      ];
      for (const device of data.devices) {
        rows.push([
          device.site_name || '',
          device.name,
          device.smartlock_id,
          device.firmware || device.firmware_raw || '',
          device.router_model || '',
          device.wpa_mode || '',
          device.wifi_channel || '',
          device.has_mesh === null ? '' : device.has_mesh ? 'ja' : 'nein',
          device.disconnects,
          Math.round(device.downtime_ms / 60000),
          device.availability === null ? '' : (device.availability * 100).toFixed(2)
        ]);
      }
      rows.push([]);
      rows.push(['Zeitraum', data.window.from, 'bis', data.window.to]);
      rows.push(['Messabdeckung', ((data.coverage.coverage ?? 0) * 100).toFixed(1) + ' %']);
      return sendCsv(res, 'uebersicht.csv', rows);
    }

    if (url.pathname === '/api/poll' && req.method === 'POST') {
      const result = await pollOnce();
      return sendJson(res, result.ok ? 200 : 502, result);
    }

    if (url.pathname === '/api/health') {
      return sendJson(res, 200, { poller: await db.pollHealth(), webhooks: await webhookHealth() });
    }

    sendJson(res, 404, { error: 'Nicht gefunden.' });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: error.message });
  }
});

// Ein unbehandelter Fehler darf den Dienst nicht wortlos beenden. Sonst
// bekommen laufende Anfragen eine leere Antwort und niemand sieht den Grund.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] Unbehandelte Promise-Ablehnung:', reason?.stack || reason);
});
process.on('uncaughtException', (error) => {
  console.error('[fatal] Unbehandelter Fehler:', error?.stack || error);
});

if (process.env.NODE_ENV !== 'test') {
  // Zuerst lauschen, dann die Datenbank einrichten. Railways privates Netzwerk
  // braucht nach dem Containerstart einige Sekunden, bis postgres.railway.internal
  // aufloest. Wer dabei sofort aufgibt, hinterlaesst einen Dienst, der gar nicht
  // erst hochkommt - und Railway antwortet dann auf jeden Pfad mit einem 404.
  app.listen(PORT, () => {
    console.log(`Nuki Monitor ${APP_VERSION} laeuft auf Port ${PORT}`);
    console.log(
      DASHBOARD_PASSWORD
        ? 'Zugriffsschutz aktiv.'
        : 'WARNUNG: DASHBOARD_PASSWORD ist leer, das Dashboard ist oeffentlich erreichbar.'
    );
  });

  const startDatabase = async (attempt = 1) => {
    try {
      await db.migrate();
      await loadSecret();
      console.log('Datenbank bereit.');
      if (webhooksEnabled()) console.log('Webhooks aktiv. Der Poll laeuft nur noch als Abgleich.');
      startPolling();
    } catch (error) {
      const wait = Math.min(30, attempt * 3);
      console.error(`[db] Start fehlgeschlagen (Versuch ${attempt}): ${error.message}`);
      if (attempt === 1) {
        console.error('[db] Pruefe DATABASE_URL und DATABASE_SSL. Interne Adresse: false, oeffentliche Proxy-Adresse: true.');
      }
      console.error(`[db] Neuer Versuch in ${wait} Sekunden.`);
      setTimeout(() => startDatabase(attempt + 1), wait * 1000);
    }
  };

  startDatabase();
}
