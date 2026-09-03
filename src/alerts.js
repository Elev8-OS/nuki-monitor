import { openAlert, findOpenAlert, closeAlert, query } from './db.js';

const WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || '';
const WEBHOOK_SECRET = process.env.ALERT_WEBHOOK_SECRET || '';
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const OFFLINE_MINUTES = Number(process.env.ALERT_AFTER_MINUTES || 15);
const FLEET_THRESHOLD = Number(process.env.FLEET_ALERT_THRESHOLD || 3);
const FLEET_WINDOW_MINUTES = Number(process.env.FLEET_ALERT_WINDOW_MINUTES || 10);

/**
 * Schickt einen Alarm an den konfigurierten Webhook. Fehler werden geloggt,
 * aber nie geworfen: eine kaputte Webhook-URL darf das Polling nicht stoppen.
 */
export async function notify(payload) {
  if (!WEBHOOK_URL) return { skipped: true };

  const body = JSON.stringify({ ...payload, dashboard_url: PUBLIC_URL || undefined });
  const headers = { 'Content-Type': 'application/json' };
  if (WEBHOOK_SECRET) headers['X-Monitor-Secret'] = WEBHOOK_SECRET;

  try {
    const res = await fetch(WEBHOOK_URL, { method: 'POST', headers, body });
    if (!res.ok) console.error('[webhook]', res.status, (await res.text()).slice(0, 200));
    return { ok: res.ok, status: res.status };
  } catch (error) {
    console.error('[webhook]', error.message);
    return { ok: false, error: error.message };
  }
}

function minutesSince(date) {
  return (Date.now() - new Date(date).getTime()) / 60000;
}

/**
 * Prueft nach jedem Poll, ob Alarme zu oeffnen oder zu schliessen sind.
 * Ein Schloss loest erst nach OFFLINE_MINUTES aus, damit kurze Aussetzer
 * nicht jedes Mal das halbe Team aufwecken.
 */
export async function evaluateAlerts(devices) {
  const opened = [];
  const closed = [];

  for (const device of devices) {
    const id = Number(device.smartlock_id);
    const existing = await findOpenAlert('device', id);

    if (device.online === false && device.offline_since) {
      const minutes = minutesSince(device.offline_since);
      if (!existing && minutes >= OFFLINE_MINUTES) {
        const alert = await openAlert('device', 'offline', id, {
          name: device.name,
          site: device.site_name || null,
          offline_since: device.offline_since,
          server_state: device.server_state
        });
        opened.push(alert);
        await notify({
          type: 'lock_offline',
          severity: 'warning',
          smartlock_id: String(id),
          name: device.name,
          site: device.site_name || null,
          offline_since: device.offline_since,
          offline_minutes: Math.round(minutes),
          message: `${device.name}${device.site_name ? ' (' + device.site_name + ')' : ''} ist seit ${Math.round(minutes)} Minuten offline.`
        });
      }
    } else if (device.online === true && existing) {
      await closeAlert(existing.id);
      closed.push(existing);
      const minutes = Math.round(minutesSince(existing.opened_at));
      await notify({
        type: 'lock_recovered',
        severity: 'info',
        smartlock_id: String(id),
        name: device.name,
        site: device.site_name || null,
        alert_duration_minutes: minutes,
        message: `${device.name} ist wieder erreichbar, Alarm lief ${minutes} Minuten.`
      });
    }
  }

  await evaluateFleetAlert();
  return { opened, closed };
}

/**
 * Mehrere Schloesser innerhalb kurzer Zeit offline heisst: die Ursache liegt
 * nicht am einzelnen Router. Dafuer gibt es einen eigenen Alarm.
 */
async function evaluateFleetAlert() {
  const { rows } = await query(
    `select count(distinct smartlock_id)::int as devices
     from events
     where kind = 'offline' and occurred_at >= now() - ($1 || ' minutes')::interval`,
    [String(FLEET_WINDOW_MINUTES)]
  );

  const affected = rows[0]?.devices || 0;
  const existing = await findOpenAlert('fleet', null);

  if (affected >= FLEET_THRESHOLD && !existing) {
    await openAlert('fleet', 'fleet_outage', null, { devices: affected, window_minutes: FLEET_WINDOW_MINUTES });
    await notify({
      type: 'fleet_outage',
      severity: 'critical',
      devices_affected: affected,
      window_minutes: FLEET_WINDOW_MINUTES,
      message: `${affected} Schlösser sind innerhalb von ${FLEET_WINDOW_MINUTES} Minuten offline gegangen. Das spricht gegen einen lokalen Router und für ein Problem bei Nuki.`
    });
  } else if (affected === 0 && existing) {
    await closeAlert(existing.id);
    await notify({
      type: 'fleet_recovered',
      severity: 'info',
      message: 'Der flächige Ausfall ist vorbei, es gab in den letzten Minuten keine weiteren Abbrüche.'
    });
  }
}
