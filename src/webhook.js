import crypto from 'node:crypto';
import { query, getSetting, setSetting } from './db.js';
import { classifyServerState, decodeFirmware } from './nuki.js';

const REQUIRE_SIGNATURE = process.env.NUKI_WEBHOOK_REQUIRE_SIGNATURE !== 'false';

/**
 * Das Secret kann aus zwei Quellen kommen: aus der Umgebungsvariable oder aus
 * der Registrierung ueber den OAuth-Ablauf. Der Wert aus der Registrierung
 * gewinnt, weil er der zuletzt bei Nuki hinterlegte ist.
 */
let secretCache = process.env.NUKI_WEBHOOK_SECRET || '';

export async function loadSecret() {
  const stored = await getSetting('nuki_webhook_secret');
  if (stored) secretCache = stored;
  return secretCache;
}

export async function storeSecret(secret) {
  await setSetting('nuki_webhook_secret', secret);
  secretCache = secret;
}

export const webhooksEnabled = () => Boolean(secretCache);

/**
 * Nuki signiert den rohen JSON-Body mit HMAC-SHA256 und legt das Ergebnis
 * in den Header X-Nuki-Signature-SHA256. Verglichen wird zeitkonstant.
 */
export function verifySignature(rawBody, signature) {
  const SECRET = secretCache;
  if (!SECRET) return !REQUIRE_SIGNATURE;
  if (!signature) return false;

  const expected = crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature).trim().toLowerCase(), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function addEvent(smartlockId, kind, detail, source = 'webhook') {
  await query('insert into events (smartlock_id, kind, detail, source) values ($1,$2,$3,$4)', [
    smartlockId,
    kind,
    JSON.stringify(detail || {}),
    source
  ]);
}

async function currentDevice(smartlockId) {
  const { rows } = await query('select * from devices where smartlock_id = $1', [smartlockId]);
  return rows[0] || null;
}

/**
 * Verarbeitet DEVICE_STATUS: Verbindungszustand, Schliesszustand, Akku.
 * Das ist der Kern - hier kommt ein Ausfall in Sekunden statt in Minuten an.
 */
async function handleDeviceStatus(payload) {
  const id = Number(payload.smartlockId);
  if (!Number.isFinite(id)) return [];

  const previous = await currentDevice(id);
  if (!previous) return []; // Geraet noch nicht erfasst, der naechste Poll holt es

  const state = payload.state || {};
  const status = classifyServerState(payload.serverState);
  const online = status === 'online';
  const needsReconnect = status === 'connection_broken';
  const kinds = [];

  if (previous.online !== online || previous.needs_reconnect !== needsReconnect) {
    if (status === 'connection_broken') {
      kinds.push('connection_broken');
      await addEvent(id, 'connection_broken', {
        server_state: payload.serverState,
        previous_server_state: previous.server_state
      });
    } else {
      kinds.push(online ? 'online' : 'offline');
      await addEvent(id, online ? 'online' : 'offline', {
        server_state: payload.serverState,
        previous_server_state: previous.server_state
      });
    }
  }

  const batteryCritical = state.batteryCritical ?? previous.battery_critical;
  if (previous.battery_critical !== batteryCritical && batteryCritical !== null) {
    kinds.push(batteryCritical ? 'battery_critical' : 'battery_recovered');
    await addEvent(id, batteryCritical ? 'battery_critical' : 'battery_recovered', {
      charge: state.batteryCharge ?? null
    });
  }

  const lockState = state.state ?? previous.lock_state;
  if (previous.lock_state !== lockState && lockState !== null && lockState !== undefined) {
    kinds.push('lock_state_changed');
    await addEvent(id, 'lock_state_changed', {
      from: previous.lock_state,
      to: lockState,
      trigger: state.trigger ?? null
    });
  }

  const offlineSince = online ? null : previous.online === false ? previous.offline_since : new Date();

  await query(
    `update devices set
       server_state = $2, online = $3, needs_reconnect = $4, offline_since = $5,
       battery_charge = coalesce($6, battery_charge),
       battery_critical = coalesce($7, battery_critical),
       battery_charging = coalesce($8, battery_charging),
       lock_state = coalesce($9, lock_state),
       door_sensor_state = coalesce($10, door_sensor_state),
       last_polled_at = now(),
       last_change_at = case when $11 then now() else last_change_at end
     where smartlock_id = $1`,
    [
      id,
      payload.serverState ?? null,
      online,
      needsReconnect,
      offlineSince,
      typeof state.batteryCharge === 'number' ? state.batteryCharge : null,
      state.batteryCritical ?? null,
      state.batteryCharging ?? null,
      state.state ?? null,
      state.doorsensorState ?? null,
      kinds.length > 0
    ]
  );

  if (kinds.length) {
    await query(
      'insert into samples (smartlock_id, online, server_state, battery_charge, lock_state) values ($1,$2,$3,$4,$5)',
      [id, online, payload.serverState ?? null, state.batteryCharge ?? null, state.state ?? null]
    );
  }

  return kinds;
}

/** Verarbeitet DEVICE_MASTERDATA: Firmware, Name, Verbindungszustand. */
async function handleMasterData(payload) {
  const id = Number(payload.smartlockId);
  if (!Number.isFinite(id)) return [];

  const previous = await currentDevice(id);
  if (!previous) return [];

  const kinds = [];

  if (payload.firmwareVersion && previous.firmware_version !== payload.firmwareVersion) {
    kinds.push('firmware_changed');
    await addEvent(id, 'firmware_changed', {
      from: decodeFirmware(previous.firmware_version),
      to: decodeFirmware(payload.firmwareVersion),
      from_raw: previous.firmware_version,
      to_raw: payload.firmwareVersion
    });
  }

  if (payload.name && previous.name !== payload.name) {
    kinds.push('renamed');
    await addEvent(id, 'renamed', { from: previous.name, to: payload.name });
  }

  if (payload.adminPinState === 2 && previous.admin_pin_state !== 2) {
    kinds.push('admin_pin_invalid');
    await addEvent(id, 'admin_pin_invalid', { admin_pin_state: payload.adminPinState });
  }

  await query(
    `update devices set
       name = coalesce($2, name),
       firmware_version = coalesce($3, firmware_version),
       hardware_version = coalesce($4, hardware_version),
       admin_pin_state = coalesce($5, admin_pin_state),
       last_polled_at = now()
     where smartlock_id = $1`,
    [
      id,
      payload.name || null,
      payload.firmwareVersion || null,
      payload.hardwareVersion || null,
      payload.adminPinState ?? null
    ]
  );

  return kinds;
}

/** Verarbeitet DEVICE_LOGS: Sperraktionen und Systemeintraege aus dem Aktivitaetsprotokoll. */
async function handleLogs(payload) {
  const log = payload.smartlockLog || {};
  const id = Number(log.smartlockId ?? payload.smartlockId);
  if (!Number.isFinite(id)) return [];

  await addEvent(id, 'activity', {
    action: log.action ?? null,
    trigger: log.trigger ?? null,
    state: log.state ?? null,
    name: log.name ?? null,
    auth_id: log.authId ?? null,
    date: log.date ?? null,
    auto_unlock: log.autoUnlock ?? null
  });

  return ['activity'];
}

async function recordDelivery(feature, ok, error) {
  await query(
    'insert into webhook_deliveries (feature, ok, error) values ($1,$2,$3)',
    [feature || null, ok, error ? String(error).slice(0, 300) : null]
  );
}

/**
 * Nuki kann einen einzelnen Payload oder ein Array schicken. Alles, was wir
 * nicht kennen, wird protokolliert statt verworfen - so faellt eine neue
 * Feature-Version auf, ohne dass Daten verloren gehen.
 */
export async function handleWebhook(body) {
  const items = Array.isArray(body) ? body : [body];
  const handled = [];

  for (const item of items) {
    const feature = item.feature || item.type || 'unbekannt';
    try {
      if (feature === 'DEVICE_STATUS') handled.push(...(await handleDeviceStatus(item)));
      else if (feature === 'DEVICE_MASTERDATA') handled.push(...(await handleMasterData(item)));
      else if (feature === 'DEVICE_LOGS') handled.push(...(await handleLogs(item)));
      else if (item.smartlockId) {
        await addEvent(Number(item.smartlockId), 'webhook_other', { feature, payload: item });
        handled.push('webhook_other');
      }
      await recordDelivery(feature, true, null);
    } catch (error) {
      console.error('[webhook]', feature, error.message);
      await recordDelivery(feature, false, error.message);
    }
  }

  return handled;
}

export async function webhookHealth() {
  const { rows } = await query(
    `select
       count(*)::int as total,
       sum(case when ok then 0 else 1 end)::int as failures,
       max(received_at) as last_received
     from webhook_deliveries
     where received_at >= now() - interval '24 hours'`
  );

  const { rows: sig } = await query(
    "select count(*)::int as signature_failures from webhook_deliveries where feature = 'signature' and received_at >= now() - interval '24 hours'"
  );

  return {
    enabled: webhooksEnabled(),
    total_24h: rows[0]?.total || 0,
    failures_24h: rows[0]?.failures || 0,
    signature_failures_24h: sig[0]?.signature_failures || 0,
    last_received: rows[0]?.last_received || null
  };
}

export async function recordSignatureFailure() {
  await recordDelivery('signature', false, 'Signatur ungueltig');
}
