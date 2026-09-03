import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as db from './src/db.js';
import { buildOverview, compareWindows, batteryTrend } from './src/analysis.js';
import { startPolling, pollOnce } from './src/poller.js';
import { notify } from './src/alerts.js';
import { verifySignature, handleWebhook, webhookHealth, webhooksEnabled, recordSignatureFailure } from './src/webhook.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
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

  if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });

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
      if (req.method === 'POST') return sendJson(res, 200, await db.createSite(await readBody(req)));
      if (req.method === 'DELETE') {
        await db.deleteSite(Number(url.searchParams.get('id')));
        return sendJson(res, 200, { deleted: true });
      }
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

if (process.env.NODE_ENV !== 'test') {
  db.migrate()
    .then(() => {
      app.listen(PORT, () => console.log(`Nuki Monitor laeuft auf Port ${PORT}`));
      if (webhooksEnabled()) {
        console.log('Webhooks aktiv. Der Poll laeuft nur noch als Abgleich.');
      }
      startPolling();
    })
    .catch((error) => {
      console.error('Start fehlgeschlagen:', error.message);
      process.exit(1);
    });
}
