/**
 * Ordnet Schloesser Standorten zu - ueber drei unabhaengige Signale:
 *
 *   1. WLAN-SSID aus der Nuki-Konfiguration
 *   2. Koordinaten aus der Nuki-Konfiguration
 *   3. Der Schlossname, verglichen mit den Objektnamen des Standorts
 *
 * Der eigentliche Wert liegt nicht in der Zuordnung, sondern im Widerspruch:
 * Zeigen zwei Signale auf verschiedene Standorte, ist irgendwo eine Angabe
 * falsch gepflegt. Solche Faelle werden ausgewiesen statt stillschweigend
 * aufgeloest.
 */

const EARTH_RADIUS_M = 6371000;

export function distanceMeters(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

const isUsableCoordinate = (lat, lng) =>
  typeof lat === 'number' &&
  Number.isFinite(lat) &&
  Number.isFinite(lng) &&
  // 0/0 liegt im Atlantik und heisst in der Praxis "nicht gepflegt".
  !(Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001) &&
  Math.abs(lat) <= 90 &&
  Math.abs(lng) <= 180;

/** Sucht Koordinaten irgendwo in der Nuki-Antwort statt einen festen Pfad anzunehmen. */
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

const normalizeSsid = (value) => (value || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Woerter, die bei euch in fast jedem Namen vorkommen und deshalb nichts
// unterscheiden. Sie fliegen vor dem Vergleich raus.
const STOPWORDS = new Set([
  'the', 'r', 'apartment', 'apartments', 'suite', 'suites', 'villa', 'villas',
  'ch', 'id', 'haus', 'gebaeude', 'gebäude', 'tuer', 'tür', 'tuere', 'türe',
  'haustuer', 'haustür', 'eingang', 'wohnung', 'nr', 'room', 'studio', 'and',
  'in', 'am', 'w', 'mit', 'pool', 'free', 'parking', 'old', 'town', 'center',
  // Geraetebezeichnungen, die in Nuki-Schlossnamen ueberall auftauchen.
  'ultra', 'pro', 'gen', 'smart', 'lock', 'nuki', 'opener', 'keypad'
]);

export function nameTokens(value) {
  return (value || '')
    .toLowerCase()
    .replace(/[äöü]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue' })[c])
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

/**
 * Baut einen Index der Namensbestandteile. Nur was zu genau einem Standort
 * gehoert, taugt als Beweis - "apartment" hilft niemandem weiter.
 */
export function buildNameIndex(sites) {
  const owners = new Map();
  for (const site of sites) {
    const values = [site.name, ...(site.aliases || [])];
    for (const token of new Set(values.flatMap(nameTokens))) {
      if (!owners.has(token)) owners.set(token, new Set());
      owners.get(token).add(site.id);
    }
  }
  const distinctive = new Map();
  for (const [token, ids] of owners) {
    if (ids.size === 1) distinctive.set(token, [...ids][0]);
  }
  return distinctive;
}

export function proposeAssignments({ devices, sites, radiusMeters = 150 }) {
  const ssidOwners = new Map();
  for (const site of sites) {
    for (const ssid of site.ssids || []) {
      const key = normalizeSsid(ssid);
      if (!key) continue;
      if (!ssidOwners.has(key)) ssidOwners.set(key, new Set());
      ssidOwners.get(key).add(site.id);
    }
  }

  const nameIndex = buildNameIndex(sites);
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const siteName = (id) => siteById.get(id)?.name || null;

  return devices.map((device) => {
    const geo = extractGeo(device.last_payload);
    const ssid = extractSsid(device.last_payload);
    const ssidKey = normalizeSsid(ssid);

    // --- Signal 1: SSID
    const ssidSiteIds = ssidKey ? [...(ssidOwners.get(ssidKey) || [])] : [];
    const ssidSignal = {
      value: ssid || null,
      site_id: ssidSiteIds.length === 1 ? ssidSiteIds[0] : null,
      site_name: ssidSiteIds.length === 1 ? siteName(ssidSiteIds[0]) : null,
      status: !ssid
        ? 'fehlt'
        : ssidSiteIds.length === 1
          ? 'eindeutig'
          : ssidSiteIds.length > 1
            ? 'mehrdeutig'
            : 'unbekannt'
    };

    // --- Signal 2: Koordinaten
    const ranked = sites
      .filter((s) => isUsableCoordinate(Number(s.latitude), Number(s.longitude)))
      .map((s) => ({ site: s, distance: geo ? distanceMeters(geo, { lat: Number(s.latitude), lng: Number(s.longitude) }) : null }))
      .filter((c) => c.distance !== null)
      .sort((a, b) => a.distance - b.distance);

    const nearby = ranked.filter((c) => c.distance <= radiusMeters);
    const eindeutigNah = nearby.length === 1 || (nearby.length > 1 && nearby[1].distance > nearby[0].distance * 2);

    const geoSignal = {
      value: geo ? `${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)}` : null,
      site_id: nearby.length && eindeutigNah ? nearby[0].site.id : null,
      site_name: nearby.length && eindeutigNah ? nearby[0].site.name : null,
      distance_m: nearby.length ? Math.round(nearby[0].distance) : null,
      status: !geo
        ? 'fehlt'
        : !nearby.length
          ? 'kein Standort in Reichweite'
          : eindeutigNah
            ? 'eindeutig'
            : 'mehrdeutig'
    };

    // --- Signal 3: Name
    const tokens = nameTokens(device.name);
    const hits = [...new Set(tokens.map((t) => nameIndex.get(t)).filter(Boolean))];
    const nameSignal = {
      value: device.name,
      site_id: hits.length === 1 ? hits[0] : null,
      site_name: hits.length === 1 ? siteName(hits[0]) : null,
      status: !tokens.length
        ? 'kein verwertbarer Name'
        : hits.length === 1
          ? 'eindeutig'
          : hits.length > 1
            ? 'mehrdeutig'
            : 'kein Treffer'
    };

    // --- Abgleich der drei Signale
    const votes = [ssidSignal, geoSignal, nameSignal].filter((s) => s.site_id);
    const tally = new Map();
    for (const vote of votes) tally.set(vote.site_id, (tally.get(vote.site_id) || 0) + 1);

    const ordered = [...tally.entries()].sort((a, b) => b[1] - a[1]);
    const winner = ordered[0] || null;
    const agreeing = winner ? winner[1] : 0;
    const widerspruch = ordered.length > 1;

    const label = (signal) => (signal === ssidSignal ? 'SSID' : signal === geoSignal ? 'Koordinaten' : 'Name');
    const conflicts = widerspruch
      ? votes.map((v) => `${label(v)} → ${v.site_name}`)
      : [];

    let confidence;
    let reason;

    if (widerspruch) {
      confidence = 'widerspruch';
      reason = `Die Signale zeigen auf verschiedene Standorte: ${conflicts.join(', ')}. Irgendwo ist eine Angabe falsch gepflegt.`;
    } else if (agreeing >= 3) {
      confidence = 'sicher';
      reason = 'SSID, Koordinaten und Name zeigen auf denselben Standort.';
    } else if (agreeing === 2) {
      confidence = 'sicher';
      reason = `${votes.map(label).join(' und ')} stimmen überein.`;
    } else if (agreeing === 1) {
      confidence = 'wahrscheinlich';
      reason = `Nur ${label(votes[0])} liefert einen eindeutigen Treffer, die anderen Signale schweigen.`;
    } else {
      confidence = 'unklar';
      reason = 'Kein Signal liefert einen eindeutigen Treffer.';
    }

    // Was fehlt oder unbrauchbar ist - die eigentliche Ausbeute fuer die
    // Datenpflege, unabhaengig davon ob die Zuordnung geklappt hat.
    const gaps = [];
    // Die Nuki Web API liefert die SSID nicht aus. Fehlt sie, ist das keine
    // Pflegeluecke, sondern der Normalfall - deshalb wird sie nicht gemeldet.
    if (ssidSignal.status === 'unbekannt') gaps.push(`SSID "${ssid}" gehört zu keinem Standort`);
    if (geoSignal.status === 'fehlt') gaps.push('Koordinaten fehlen in Nuki');
    if (geoSignal.status === 'kein Standort in Reichweite') gaps.push(`Koordinaten liegen weiter als ${radiusMeters} m von jedem Standort`);
    if (nameSignal.status === 'kein Treffer') gaps.push('Schlossname passt zu keinem Objektnamen');
    if (nameSignal.status === 'kein verwertbarer Name') gaps.push('Schlossname enthält nichts Unterscheidbares');

    return {
      smartlock_id: String(device.smartlock_id),
      name: device.name,
      current_site_id: device.site_id ?? null,
      signals: { ssid: ssidSignal, geo: geoSignal, name: nameSignal },
      site_id: widerspruch ? null : winner ? winner[0] : null,
      site_name: widerspruch ? null : winner ? siteName(winner[0]) : null,
      agreeing_signals: agreeing,
      confidence,
      reason,
      conflicts,
      gaps
    };
  });
}

/** Verdichtet die Vorschlaege zu einer Liste dessen, was gepflegt werden muss. */
export function dataQualityReport(proposals) {
  const counter = new Map();
  for (const proposal of proposals) {
    for (const gap of proposal.gaps) {
      if (!counter.has(gap)) counter.set(gap, []);
      counter.get(gap).push(proposal.name);
    }
  }

  return {
    issues: [...counter.entries()]
      .map(([issue, devices]) => ({ issue, count: devices.length, devices }))
      .sort((a, b) => b.count - a.count),
    conflicts: proposals
      .filter((p) => p.confidence === 'widerspruch')
      .map((p) => ({ name: p.name, smartlock_id: p.smartlock_id, conflicts: p.conflicts }))
  };
}
