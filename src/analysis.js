import { decodeFirmware } from './nuki.js';

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_SECONDS || 60) * 1000;

/**
 * Baut aus den online/offline-Ereignissen eines Geraets die Offline-Phasen.
 * `startedOffline` beruecksichtigt Ausfaelle, die vor dem Fenster begannen.
 */
export function buildOutages(events, from, to, startedOffline) {
  const outages = [];
  let openedAt = startedOffline ? from : null;

  for (const event of events) {
    const at = new Date(event.occurred_at);
    if (event.kind === 'offline' && openedAt === null) {
      openedAt = at;
    } else if (event.kind === 'online' && openedAt !== null) {
      if (at > openedAt) outages.push({ start: openedAt.toISOString(), end: at.toISOString(), ongoing: false });
      openedAt = null;
    }
  }

  if (openedAt !== null) {
    outages.push({ start: openedAt.toISOString(), end: to.toISOString(), ongoing: true });
  }

  const downtime = outages.reduce((sum, o) => sum + (new Date(o.end) - new Date(o.start)), 0);
  const windowMs = to - from;

  return {
    outages,
    downtime_ms: downtime,
    availability: windowMs > 0 ? Math.max(0, Math.min(1, 1 - downtime / windowMs)) : null
  };
}

/**
 * Messluecken: Zeitraeume, in denen die App gar nicht gepollt hat, etwa weil
 * Railway neu gestartet hat. Stille ist dort kein Beleg fuer Stabilitaet.
 */
export function buildCoverage(pollRuns, from, to) {
  const threshold = POLL_INTERVAL_MS * 3;
  const gaps = [];
  let cursor = from.getTime();

  for (const run of pollRuns) {
    const at = new Date(run.started_at).getTime();
    if (at - cursor > threshold) gaps.push({ start: new Date(cursor).toISOString(), end: new Date(at).toISOString() });
    cursor = Math.max(cursor, at);
  }

  if (to.getTime() - cursor > threshold) {
    gaps.push({ start: new Date(cursor).toISOString(), end: to.toISOString() });
  }

  const missing = gaps.reduce((sum, g) => sum + (new Date(g.end) - new Date(g.start)), 0);
  const windowMs = to - from;

  return {
    gaps,
    missing_ms: missing,
    coverage: windowMs > 0 ? Math.max(0, Math.min(1, 1 - missing / windowMs)) : null
  };
}

/** Akkuverlauf als Prozentpunkte pro Tag. Steilerer Abfall deutet auf Reconnect-Schleifen. */
export function batteryTrend(samples) {
  const points = samples.filter((s) => typeof s.battery_charge === 'number');
  if (points.length < 2) return null;

  const first = points[0];
  const last = points[points.length - 1];
  const days = (new Date(last.sampled_at) - new Date(first.sampled_at)) / 86400000;
  if (days < 0.5) return null;

  return {
    from: first.battery_charge,
    to: last.battery_charge,
    per_day: Number(((last.battery_charge - first.battery_charge) / days).toFixed(2)),
    days: Number(days.toFixed(1))
  };
}

export function buildOverview({ devices, events, priorState, pollRuns, from, to, changes = [] }) {
  const byDevice = new Map();
  for (const event of events) {
    const key = String(event.smartlock_id);
    if (!byDevice.has(key)) byDevice.set(key, []);
    byDevice.get(key).push(event);
  }

  const rows = devices.map((device) => {
    const key = String(device.smartlock_id);
    const deviceEvents = byDevice.get(key) || [];
    const connectivity = deviceEvents.filter((e) => e.kind === 'online' || e.kind === 'offline');
    const { outages, downtime_ms, availability } = buildOutages(
      connectivity,
      from,
      to,
      priorState.get(key) === 'offline'
    );

    return {
      smartlock_id: key,
      name: device.name,
      site_id: device.site_id ?? null,
      site_name: device.site_name || null,
      router_model: device.router_model || null,
      wpa_mode: device.wpa_mode || null,
      wifi_channel: device.wifi_channel || null,
      has_mesh: device.has_mesh ?? null,
      online: device.online,
      needs_reconnect: device.needs_reconnect ?? false,
      server_state: device.server_state,
      offline_since: device.offline_since,
      firmware: decodeFirmware(device.firmware_version),
      firmware_raw: device.firmware_version,
      battery_charge: device.battery_charge,
      battery_critical: device.battery_critical,
      subscription_state: device.subscription_state ?? null,
      wifi_enabled: device.wifi_enabled ?? null,
      lock_state: device.lock_state,
      last_polled_at: device.last_polled_at,
      disconnects: connectivity.filter((e) => e.kind === 'offline').length,
      downtime_ms,
      availability,
      outages,
      firmware_changes: deviceEvents
        .filter((e) => e.kind === 'firmware_changed')
        .map((e) => ({ at: e.occurred_at, ...e.detail })),
      event_count: deviceEvents.length
    };
  });

  rows.sort((a, b) => b.disconnects - a.disconnects || b.downtime_ms - a.downtime_ms);

  // Auswertung je Standort: macht Muster sichtbar, die pro Schloss untergehen.
  const siteMap = new Map();
  for (const row of rows) {
    const key = row.site_name || 'ohne Standort';
    if (!siteMap.has(key)) {
      siteMap.set(key, {
        site: key,
        router_model: row.router_model,
        wpa_mode: row.wpa_mode,
        wifi_channel: row.wifi_channel,
        has_mesh: row.has_mesh,
        devices: 0,
        disconnects: 0,
        downtime_ms: 0
      });
    }
    const entry = siteMap.get(key);
    entry.devices += 1;
    entry.disconnects += row.disconnects;
    entry.downtime_ms += row.downtime_ms;
  }

  const sites = [...siteMap.values()]
    .map((s) => ({
      ...s,
      disconnects_per_device: Number((s.disconnects / Math.max(1, s.devices)).toFixed(2))
    }))
    .sort((a, b) => b.disconnects_per_device - a.disconnects_per_device);

  const offlineEvents = events.filter((e) => e.kind === 'offline');
  const byHour = Array.from({ length: 24 }, () => 0);
  for (const event of offlineEvents) byHour[new Date(event.occurred_at).getHours()] += 1;

  const stamps = offlineEvents
    .map((e) => ({ t: new Date(e.occurred_at).getTime(), id: String(e.smartlock_id) }))
    .sort((a, b) => a.t - b.t);

  let clustered = 0;
  for (let i = 1; i < stamps.length; i += 1) {
    if (stamps[i].t - stamps[i - 1].t <= 10 * 60 * 1000 && stamps[i].id !== stamps[i - 1].id) clustered += 1;
  }

  const coverage = buildCoverage(pollRuns, from, to);

  return {
    window: { from: from.toISOString(), to: to.toISOString(), days: Math.round((to - from) / 86400000) },
    generated_at: new Date().toISOString(),
    coverage,
    changes: changes
      .filter((c) => new Date(c.applied_at) >= from && new Date(c.applied_at) <= to)
      .map((c) => ({ id: c.id, at: c.applied_at, title: c.title, site: c.site_name || null, site_id: c.site_id })),
    summary: {
      devices: devices.length,
      offline_now: rows.filter((r) => r.online === false).length,
      total_disconnects: rows.reduce((s, r) => s + r.disconnects, 0),
      devices_affected: rows.filter((r) => r.disconnects > 0).length,
      clustered_disconnects: clustered,
      battery_critical: rows.filter((r) => r.battery_critical === true).length,
      needs_reconnect: rows.filter((r) => r.needs_reconnect === true).length,
      subscription_inactive: rows.filter(
        (r) => r.subscription_state && r.subscription_state !== 'ACTIVE'
      ).length,
      wifi_disabled: rows.filter((r) => r.wifi_enabled === false).length,
      firmware_versions: [...new Set(rows.map((r) => r.firmware).filter(Boolean))].sort(),
      worst_availability: rows.length ? Math.min(...rows.map((r) => r.availability ?? 1)) : null,
      unassigned_devices: rows.filter((r) => !r.site_name).length
    },
    sites,
    disconnects_by_hour: byHour,
    devices: rows
  };
}

/**
 * Vergleicht dasselbe Zeitfenster vor und nach einer Aenderung.
 * Genau das ist die Frage, die eine Router-Umstellung beantworten soll.
 */
export function compareWindows({ deviceIds, beforeEvents, afterEvents, applied, hours }) {
  const span = hours * 3600000;
  const beforeFrom = new Date(new Date(applied).getTime() - span);
  const beforeTo = new Date(applied);
  const afterFrom = new Date(applied);
  const afterTo = new Date(new Date(applied).getTime() + span);
  const now = new Date();

  const tally = (events, from, to) => {
    const relevant = events.filter((e) => deviceIds.includes(String(e.smartlock_id)));
    const disconnects = relevant.filter((e) => e.kind === 'offline').length;

    let downtime = 0;
    for (const id of deviceIds) {
      const own = relevant
        .filter((e) => String(e.smartlock_id) === id && (e.kind === 'online' || e.kind === 'offline'))
        .sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
      downtime += buildOutages(own, from, to, false).downtime_ms;
    }

    return { disconnects, downtime_ms: downtime };
  };

  const before = tally(beforeEvents, beforeFrom, beforeTo);
  const after = tally(afterEvents, afterFrom, afterTo > now ? now : afterTo);
  const elapsedHours = Math.min(hours, (now - new Date(applied)) / 3600000);

  const delta = before.disconnects === 0 ? null : (after.disconnects - before.disconnects) / before.disconnects;

  let verdict = 'zu früh';
  if (elapsedHours >= hours * 0.9) {
    if (before.disconnects === 0 && after.disconnects === 0) verdict = 'unverändert stabil';
    else if (delta === null) verdict = after.disconnects > 0 ? 'schlechter' : 'unverändert';
    else if (delta <= -0.5) verdict = 'deutlich besser';
    else if (delta <= -0.2) verdict = 'besser';
    else if (delta >= 0.2) verdict = 'schlechter';
    else verdict = 'unverändert';
  }

  return {
    applied,
    hours,
    elapsed_hours: Number(elapsedHours.toFixed(1)),
    complete: elapsedHours >= hours * 0.9,
    devices: deviceIds.length,
    before,
    after,
    change_ratio: delta,
    verdict
  };
}
