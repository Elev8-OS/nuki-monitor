const BASE_URL = process.env.NUKI_BASE_URL || 'https://api.nuki.io';
const TOKEN = process.env.NUKI_API_TOKEN;

/**
 * serverState laut Nuki Web API Doku:
 *   0 ok, 1 unregistered, 2 auth uuid invalid, 3 auth invalid, 4 offline
 *
 * Wichtig fuer die Auswertung: Nur 4 ist ein echter Verbindungsausfall.
 * Bei 1 bis 3 muss die Verbindung des Geraets zum Nuki-Web-Konto neu
 * hergestellt werden - das ist ein Konfigurationsproblem und darf nicht
 * als WLAN-Ausfall in die Statistik wandern.
 */
export const SERVER_STATES = {
  0: 'ok',
  1: 'nicht registriert',
  2: 'Auth-UUID ungültig',
  3: 'Autorisierung ungültig',
  4: 'offline'
};

export function classifyServerState(serverState) {
  if (serverState === 0) return 'online';
  if (serverState === 4) return 'offline';
  if (serverState === 1 || serverState === 2 || serverState === 3) return 'connection_broken';
  return 'unknown';
}

/**
 * Nuki liefert die Firmware als Ganzzahl, die als HEX gelesen wird.
 * Beispiel aus der Doku: 133135 (DEC) = 2080F (HEX) = Version 2.8.15.
 * Das entspricht major * 65536 + minor * 256 + patch.
 */
export function decodeFirmware(value) {
  if (typeof value !== 'number' || value <= 0) return null;
  const major = Math.floor(value / 65536);
  const minor = Math.floor((value % 65536) / 256);
  const patch = value % 256;
  if (major > 20) return null;
  return `${major}.${minor}.${patch}`;
}

export async function fetchSmartlocks() {
  if (!TOKEN) throw new Error('NUKI_API_TOKEN fehlt.');

  const res = await fetch(`${BASE_URL}/smartlock`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' }
  });

  if (res.status === 401 || res.status === 403) {
    throw Object.assign(
      new Error(
        'Nuki hat den Token abgelehnt. Der Token wird ungueltig, sobald das Passwort des Nuki-Web-Kontos geaendert wird.'
      ),
      { status: res.status }
    );
  }

  if (res.status === 429) {
    throw Object.assign(new Error('Nuki-Rate-Limit erreicht. Poll-Intervall erhoehen.'), { status: 429 });
  }

  if (!res.ok) {
    const body = await res.text();
    throw Object.assign(new Error(`Nuki antwortete mit ${res.status}: ${body.slice(0, 300)}`), { status: res.status });
  }

  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('Unerwartete Antwort von /smartlock: kein Array.');
  return data;
}

/** Uebersetzt einen Smartlock aus der API in unser flaches Modell. */
export function mapSmartlock(raw) {
  const state = raw.state || {};
  const status = classifyServerState(raw.serverState);

  return {
    smartlock_id: Number(raw.smartlockId),
    name: raw.name || String(raw.smartlockId),
    device_type: raw.type ?? null,
    firmware_version: raw.firmwareVersion ?? null,
    hardware_version: raw.hardwareVersion ?? null,
    server_state: raw.serverState ?? null,
    online: status === 'online',
    needs_reconnect: status === 'connection_broken',
    battery_charge: typeof state.batteryCharge === 'number' ? state.batteryCharge : null,
    battery_critical: state.batteryCritical ?? null,
    battery_charging: state.batteryCharging ?? null,
    lock_state: state.state ?? null,
    door_sensor_state: state.doorsensorState ?? null,
    payload: raw
  };
}

export const LOCK_STATES = {
  0: 'unkalibriert',
  1: 'gesperrt',
  2: 'entsperrt (Vorgang)',
  3: 'entsperrt',
  4: 'gesperrt (Vorgang)',
  5: 'entriegelt',
  6: 'entriegelt (Lock n Go)',
  7: 'entriegeln (Vorgang)',
  254: 'Motorproblem',
  255: 'unbekannt'
};

/** Trigger eines Log-Eintrags laut Nuki-Doku. */
export const LOG_TRIGGERS = {
  0: 'System',
  1: 'manuell',
  2: 'Button',
  3: 'automatisch',
  4: 'Web',
  5: 'App',
  6: 'Auto Lock',
  7: 'Zubehör',
  255: 'Keypad'
};
