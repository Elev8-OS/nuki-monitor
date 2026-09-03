import { fetchSmartlocks, mapSmartlock, decodeFirmware } from './nuki.js';
import { query, cleanup, listDevices } from './db.js';
import { evaluateAlerts } from './alerts.js';

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_SECONDS || 60) * 1000;
const SAMPLE_INTERVAL_MS = Number(process.env.SAMPLE_INTERVAL_MINUTES || 15) * 60 * 1000;
const SAMPLE_RETENTION_DAYS = Number(process.env.SAMPLE_RETENTION_DAYS || 90);
const EVENT_RETENTION_DAYS = Number(process.env.EVENT_RETENTION_DAYS || 365);

const lastSampleAt = new Map();
let runCount = 0;

async function addEvent(smartlockId, kind, detail = {}) {
  await query('insert into events (smartlock_id, kind, detail) values ($1, $2, $3)', [
    smartlockId,
    kind,
    JSON.stringify(detail)
  ]);
}

async function upsertDevice(device, changed, offlineSince) {
  await query(
    `insert into devices (
       smartlock_id, name, device_type, firmware_version, hardware_version, server_state, online, offline_since,
       battery_charge, battery_critical, battery_charging, lock_state, door_sensor_state,
       last_payload, last_polled_at, last_change_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now(), case when $15 then now() else null end)
     on conflict (smartlock_id) do update set
       name = excluded.name,
       device_type = excluded.device_type,
       firmware_version = excluded.firmware_version,
       hardware_version = excluded.hardware_version,
       server_state = excluded.server_state,
       online = excluded.online,
       offline_since = excluded.offline_since,
       battery_charge = excluded.battery_charge,
       battery_critical = excluded.battery_critical,
       battery_charging = excluded.battery_charging,
       lock_state = excluded.lock_state,
       door_sensor_state = excluded.door_sensor_state,
       last_payload = excluded.last_payload,
       last_polled_at = now(),
       last_change_at = case when $15 then now() else devices.last_change_at end`,
    [
      device.smartlock_id,
      device.name,
      device.device_type,
      device.firmware_version,
      device.hardware_version,
      device.server_state,
      device.online,
      offlineSince,
      device.battery_charge,
      device.battery_critical,
      device.battery_charging,
      device.lock_state,
      device.door_sensor_state,
      JSON.stringify(device.payload),
      changed
    ]
  );
}

async function writeSample(device) {
  await query(
    'insert into samples (smartlock_id, online, server_state, battery_charge, lock_state) values ($1,$2,$3,$4,$5)',
    [device.smartlock_id, device.online, device.server_state, device.battery_charge, device.lock_state]
  );
  lastSampleAt.set(device.smartlock_id, Date.now());
}

/** Vergleicht den frischen Zustand mit dem gespeicherten und schreibt die Wechsel. */
export async function reconcile(device, previous) {
  const events = [];
  let offlineSince = previous ? previous.offline_since : null;

  if (!previous) {
    events.push([
      'device_added',
      {
        online: device.online,
        firmware: decodeFirmware(device.firmware_version),
        firmware_raw: device.firmware_version
      }
    ]);
    offlineSince = device.online ? null : new Date();
  } else {
    if (previous.online !== device.online) {
      events.push([
        device.online ? 'online' : 'offline',
        { server_state: device.server_state, previous_server_state: previous.server_state }
      ]);
      offlineSince = device.online ? null : new Date();
    }

    if (previous.firmware_version !== device.firmware_version) {
      events.push([
        'firmware_changed',
        {
          from: decodeFirmware(previous.firmware_version),
          to: decodeFirmware(device.firmware_version),
          from_raw: previous.firmware_version,
          to_raw: device.firmware_version
        }
      ]);
    }

    if (previous.battery_critical !== device.battery_critical && device.battery_critical !== null) {
      events.push([
        device.battery_critical ? 'battery_critical' : 'battery_recovered',
        { charge: device.battery_charge }
      ]);
    }

    if (previous.lock_state !== device.lock_state && device.lock_state !== null) {
      events.push(['lock_state_changed', { from: previous.lock_state, to: device.lock_state }]);
    }

    if (previous.name !== device.name) {
      events.push(['renamed', { from: previous.name, to: device.name }]);
    }
  }

  for (const [kind, detail] of events) {
    await addEvent(device.smartlock_id, kind, detail);
  }

  const changed = events.length > 0;
  await upsertDevice(device, changed, offlineSince);

  const due = Date.now() - (lastSampleAt.get(device.smartlock_id) || 0) > SAMPLE_INTERVAL_MS;
  if (changed || due) await writeSample(device);

  return events.map(([kind]) => kind);
}

export async function pollOnce() {
  const started = Date.now();

  try {
    const raw = await fetchSmartlocks();
    const { rows: existing } = await query('select * from devices');
    const previousById = new Map(existing.map((row) => [Number(row.smartlock_id), row]));

    let changes = 0;
    for (const item of raw) {
      const device = mapSmartlock(item);
      if (!Number.isFinite(device.smartlock_id)) continue;
      const kinds = await reconcile(device, previousById.get(device.smartlock_id) || null);
      changes += kinds.length;
    }

    await query('insert into poll_runs (duration_ms, device_count, ok) values ($1,$2,true)', [
      Date.now() - started,
      raw.length
    ]);

    const alerts = await evaluateAlerts(await listDevices());

    runCount += 1;
    if (runCount % 60 === 0) await cleanup(SAMPLE_RETENTION_DAYS, EVENT_RETENTION_DAYS);

    return { ok: true, devices: raw.length, changes, alerts_opened: alerts.opened.length };
  } catch (error) {
    console.error('[poll]', error.message);
    await query('insert into poll_runs (duration_ms, device_count, ok, error) values ($1,$2,false,$3)', [
      Date.now() - started,
      0,
      error.message.slice(0, 500)
    ]).catch(() => {});
    return { ok: false, error: error.message };
  }
}

export function startPolling() {
  const tick = async () => {
    await pollOnce();
    setTimeout(tick, POLL_INTERVAL_MS);
  };
  tick();
  console.log(`Polling alle ${POLL_INTERVAL_MS / 1000} Sekunden.`);
}
