/**
 * Ordnet Schloesser Standorten zu - anhand der WLAN-SSID und der Koordinaten
 * aus der Nuki-Konfiguration.
 *
 * Beides zusammen, weil beides allein unzuverlaessig ist: Dieselbe SSID kommt
 * bei mehreren Gebaeuden vor, und Koordinaten aus dem Einrichtungsvorgang
 * streuen um einige Dutzend Meter. Stimmen beide ueberein, ist die Zuordnung
 * sicher; stimmt nur eines, wird sie als unsicher markiert und muss bestaetigt
 * werden.
 */

const EARTH_RADIUS_M = 6371000;

export function distanceMeters(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

const isUsableCoordinate = (lat, lng) =>
  typeof lat === 'number' &&
  typeof lng === 'number' &&
  Number.isFinite(lat) &&
  Number.isFinite(lng) &&
  // 0/0 liegt im Atlantik und bedeutet in der Praxis "nicht gepflegt".
  !(Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001) &&
  Math.abs(lat) <= 90 &&
  Math.abs(lng) <= 180;

/**
 * Sucht Koordinaten irgendwo in der Nuki-Antwort. Die Felder liegen je nach
 * Geraetetyp in config, advancedConfig oder direkt oben - deshalb wird
 * gesucht statt ein fester Pfad angenommen.
 */
export function extractGeo(payload) {
  const seen = new Set();

  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);

    const lat = Number(node.latitude ?? node.lat);
    const lng = Number(node.longitude ?? node.lng ?? node.lon);
    if (isUsableCoordinate(lat, lng)) return { lat, lng };

    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') {
        const found = walk(value);
        if (found) return found;
      }
    }
    return null;
  };

  return walk(payload);
}

const SSID_KEYS = ['wifissid', 'ssid', 'wlanssid', 'networkname', 'wifiname'];

export function extractSsid(payload) {
  const seen = new Set();

  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);

    for (const [key, value] of Object.entries(node)) {
      const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
      if (SSID_KEYS.includes(normalized) && typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') {
        const found = walk(value);
        if (found) return found;
      }
    }
    return null;
  };

  return walk(payload);
}

// Grosskleinschreibung und Leerzeichen an den Raendern sollen nicht stoeren.
const normalizeSsid = (value) => (value || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Erzeugt fuer jedes Schloss einen Vorschlag. Angewendet wird nichts -
 * das entscheidet ein Mensch.
 */
export function proposeAssignments({ devices, sites, radiusMeters = 150 }) {
  // Welche SSID gehoert zu genau einem Standort? Nur dann ist sie beweiskraeftig.
  const ssidCount = new Map();
  for (const site of sites) {
    for (const ssid of site.ssids || []) {
      const key = normalizeSsid(ssid);
      if (!key) continue;
      ssidCount.set(key, (ssidCount.get(key) || 0) + 1);
    }
  }

  return devices.map((device) => {
    const geo = extractGeo(device.last_payload);
    const ssid = extractSsid(device.last_payload);
    const ssidKey = normalizeSsid(ssid);

    const withDistance = sites
      .filter((s) => isUsableCoordinate(Number(s.latitude), Number(s.longitude)))
      .map((s) => ({
        site: s,
        distance: geo
          ? distanceMeters(geo, { lat: Number(s.latitude), lng: Number(s.longitude) })
          : null
      }))
      .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));

    const nearby = withDistance.filter((c) => c.distance !== null && c.distance <= radiusMeters);

    const ssidMatches = sites.filter((s) =>
      (s.ssids || []).some((value) => normalizeSsid(value) === ssidKey && ssidKey)
    );
    const ssidUnique = ssidKey ? ssidCount.get(ssidKey) === 1 : false;

    const base = {
      smartlock_id: String(device.smartlock_id),
      name: device.name,
      current_site_id: device.site_id ?? null,
      ssid: ssid || null,
      coordinates: geo,
      nearest: nearby[0]
        ? { site_id: nearby[0].site.id, name: nearby[0].site.name, distance_m: Math.round(nearby[0].distance) }
        : null
    };

    // 1. SSID und Koordinaten zeigen auf denselben Standort.
    if (ssidMatches.length && nearby.length) {
      const agreeing = nearby.find((c) => ssidMatches.some((s) => s.id === c.site.id));
      if (agreeing) {
        return {
          ...base,
          site_id: agreeing.site.id,
          site_name: agreeing.site.name,
          confidence: 'sicher',
          reason: `SSID "${ssid}" und Standort stimmen überein, ${Math.round(agreeing.distance)} m entfernt.`
        };
      }
    }

    // 2. SSID gehoert eindeutig zu einem Standort, Koordinaten fehlen oder passen nicht.
    if (ssidUnique && ssidMatches.length === 1) {
      return {
        ...base,
        site_id: ssidMatches[0].id,
        site_name: ssidMatches[0].name,
        confidence: geo ? 'prüfen' : 'wahrscheinlich',
        reason: geo
          ? `SSID "${ssid}" passt eindeutig, die Koordinaten zeigen aber woanders hin${base.nearest ? ` (${base.nearest.name}, ${base.nearest.distance_m} m)` : ''}.`
          : `SSID "${ssid}" passt eindeutig. Koordinaten sind nicht gepflegt.`
      };
    }

    // 3. Nur Koordinaten, und der naechste Standort ist deutlich naeher als der zweitnaechste.
    if (nearby.length) {
      const second = nearby[1];
      const eindeutig = !second || second.distance > nearby[0].distance * 2;
      return {
        ...base,
        site_id: nearby[0].site.id,
        site_name: nearby[0].site.name,
        confidence: eindeutig ? 'wahrscheinlich' : 'prüfen',
        reason: eindeutig
          ? `${Math.round(nearby[0].distance)} m entfernt, nächster anderer Standort deutlich weiter.`
          : `${Math.round(nearby[0].distance)} m entfernt, aber "${second.site.name}" liegt mit ${Math.round(second.distance)} m fast gleich nah.`
      };
    }

    // 4. SSID kommt bei mehreren Standorten vor, Koordinaten helfen nicht.
    if (ssidMatches.length > 1) {
      return {
        ...base,
        site_id: null,
        site_name: null,
        confidence: 'unklar',
        reason: `SSID "${ssid}" wird von ${ssidMatches.length} Standorten genutzt und die Koordinaten helfen nicht weiter.`
      };
    }

    return {
      ...base,
      site_id: null,
      site_name: null,
      confidence: 'unklar',
      reason: geo
        ? 'Kein Standort innerhalb des Radius.'
        : 'Weder SSID noch Koordinaten in den Nuki-Daten gefunden.'
    };
  });
}
