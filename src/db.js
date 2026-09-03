import pg from 'pg';

const { Pool } = pg;

let pool;

export function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL fehlt.');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });

    // Ohne diesen Listener beendet Node den Prozess, sobald Postgres eine
    // untaetige Verbindung schliesst - der Dienst startet dann neu und
    // Anfragen in diesem Moment bekommen eine leere Antwort.
    pool.on('error', (error) => {
      console.error('[db] Fehler auf einer untaetigen Verbindung:', error.message);
    });
  }
  return pool;
}

// Erlaubt es, im Test eine andere Implementierung mit query(text, params) zu setzen.
let client = null;
export function setClient(custom) {
  client = custom;
}
export function query(text, params = []) {
  if (client) return client.query(text, params);
  return getPool().query(text, params);
}

export const SCHEMA = `
create table if not exists devices (
  smartlock_id      bigint primary key,
  name              text not null,
  device_type       integer,
  firmware_version  integer,
  hardware_version  integer,
  server_state      integer,
  online            boolean,
  offline_since     timestamptz,
  battery_charge    integer,
  battery_critical  boolean,
  battery_charging  boolean,
  lock_state        integer,
  door_sensor_state integer,
  last_payload      jsonb not null,
  first_seen_at     timestamptz not null default now(),
  last_polled_at    timestamptz not null default now(),
  last_change_at    timestamptz
);

create table if not exists events (
  id           bigserial primary key,
  smartlock_id bigint not null,
  occurred_at  timestamptz not null default now(),
  kind         text not null,
  detail       jsonb not null default '{}'::jsonb
);
create index if not exists events_device_time_idx on events (smartlock_id, occurred_at desc);
create index if not exists events_kind_time_idx on events (kind, occurred_at desc);

create table if not exists samples (
  id             bigserial primary key,
  smartlock_id   bigint not null,
  sampled_at     timestamptz not null default now(),
  online         boolean,
  server_state   integer,
  battery_charge integer,
  lock_state     integer
);
create index if not exists samples_device_time_idx on samples (smartlock_id, sampled_at desc);

create table if not exists poll_runs (
  id           bigserial primary key,
  started_at   timestamptz not null default now(),
  duration_ms  integer,
  device_count integer,
  ok           boolean not null,
  error        text
);
create index if not exists poll_runs_time_idx on poll_runs (started_at desc);

create table if not exists sites (
  id            serial primary key,
  name          text not null unique,
  router_model  text,
  wpa_mode      text,
  wifi_channel  text,
  has_mesh      boolean not null default false,
  notes         text,
  created_at    timestamptz not null default now()
);

create table if not exists device_sites (
  smartlock_id bigint primary key,
  site_id      integer not null references sites(id) on delete cascade
);

create table if not exists changes (
  id          serial primary key,
  site_id     integer references sites(id) on delete cascade,
  applied_at  timestamptz not null,
  title       text not null,
  description text,
  created_at  timestamptz not null default now()
);
create index if not exists changes_time_idx on changes (applied_at desc);

create table if not exists alerts (
  id           bigserial primary key,
  smartlock_id bigint,
  scope        text not null,
  kind         text not null,
  opened_at    timestamptz not null default now(),
  closed_at    timestamptz,
  detail       jsonb not null default '{}'::jsonb
);
create index if not exists alerts_open_idx on alerts (closed_at, smartlock_id);

create table if not exists probe_samples (
  id          bigserial primary key,
  site_id     integer references sites(id) on delete cascade,
  received_at timestamptz not null default now(),
  measured_at timestamptz,
  target      text,
  reachable   boolean,
  rtt_ms      numeric,
  source      text,
  raw         jsonb not null default '{}'::jsonb
);
create index if not exists probe_time_idx on probe_samples (site_id, received_at desc);

create table if not exists webhook_deliveries (
  id          bigserial primary key,
  received_at timestamptz not null default now(),
  feature     text,
  ok          boolean not null,
  error       text
);
create index if not exists webhook_time_idx on webhook_deliveries (received_at desc);

-- Nachtraegliche Spalten fuer bereits laufende Installationen.
alter table devices add column if not exists needs_reconnect boolean not null default false;
alter table devices add column if not exists admin_pin_state integer;
alter table events  add column if not exists source text not null default 'poll';

create table if not exists settings (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);
`;

export async function migrate() {
  await query(SCHEMA);
}

// ------------------------------------------------------------- Einstellungen
// Hier landen Werte, die zur Laufzeit entstehen - etwa das Webhook-Secret aus
// der Registrierung. So muss niemand es von Hand nach Railway kopieren.

export async function getSetting(key) {
  const { rows } = await query('select value from settings where key = $1', [key]);
  return rows[0]?.value ?? null;
}

export async function setSetting(key, value) {
  await query(
    `insert into settings (key, value) values ($1,$2)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, value]
  );
}

// --------------------------------------------------------------- Geraete

export async function listDevices() {
  const { rows } = await query(
    `select d.*, s.id as site_id, s.name as site_name, s.router_model, s.wpa_mode, s.wifi_channel, s.has_mesh
     from devices d
     left join device_sites ds on ds.smartlock_id = d.smartlock_id
     left join sites s on s.id = ds.site_id
     order by d.name asc`
  );
  return rows;
}

export async function eventsSince(from, kinds = null) {
  if (kinds) {
    const { rows } = await query(
      'select smartlock_id, occurred_at, kind, detail, source from events where occurred_at >= $1 and kind = any($2) order by occurred_at asc',
      [from, kinds]
    );
    return rows;
  }
  const { rows } = await query(
    'select smartlock_id, occurred_at, kind, detail, source from events where occurred_at >= $1 order by occurred_at asc',
    [from]
  );
  return rows;
}

export async function eventsBetween(from, to, kinds) {
  const { rows } = await query(
    `select smartlock_id, occurred_at, kind, detail from events
     where occurred_at >= $1 and occurred_at < $2 and kind = any($3) order by occurred_at asc`,
    [from, to, kinds]
  );
  return rows;
}

export async function stateBefore(from) {
  const { rows } = await query(
    `select distinct on (smartlock_id) smartlock_id, kind, occurred_at
     from events
     where kind in ('online','offline') and occurred_at < $1
     order by smartlock_id, occurred_at desc`,
    [from]
  );
  return new Map(rows.map((r) => [String(r.smartlock_id), r.kind]));
}

export async function deviceDetail(smartlockId, from) {
  const [device, events, samples] = await Promise.all([
    query(
      `select d.*, s.name as site_name from devices d
       left join device_sites ds on ds.smartlock_id = d.smartlock_id
       left join sites s on s.id = ds.site_id
       where d.smartlock_id = $1`,
      [smartlockId]
    ),
    query(
      'select occurred_at, kind, detail, source from events where smartlock_id = $1 and occurred_at >= $2 order by occurred_at desc limit 500',
      [smartlockId, from]
    ),
    query(
      'select sampled_at, online, server_state, battery_charge, lock_state from samples where smartlock_id = $1 and sampled_at >= $2 order by sampled_at asc limit 3000',
      [smartlockId, from]
    )
  ]);

  return { device: device.rows[0] || null, events: events.rows, samples: samples.rows };
}

// ------------------------------------------------------------- Messguete

export async function pollRunsSince(from) {
  const { rows } = await query(
    'select started_at, ok from poll_runs where started_at >= $1 order by started_at asc',
    [from]
  );
  return rows;
}

export async function pollHealth() {
  const { rows } = await query(
    'select started_at, duration_ms, device_count, ok, error from poll_runs order by started_at desc limit 20'
  );
  return { last: rows[0] || null, recent_failures: rows.filter((r) => !r.ok).length, runs: rows };
}

// -------------------------------------------------------------- Standorte

export async function listSites() {
  const { rows } = await query(
    `select s.*, count(ds.smartlock_id)::int as device_count
     from sites s left join device_sites ds on ds.site_id = s.id
     group by s.id order by s.name asc`
  );
  return rows;
}

export async function createSite(site) {
  const { rows } = await query(
    `insert into sites (name, router_model, wpa_mode, wifi_channel, has_mesh, notes)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (name) do update set
       router_model = excluded.router_model,
       wpa_mode = excluded.wpa_mode,
       wifi_channel = excluded.wifi_channel,
       has_mesh = excluded.has_mesh,
       notes = excluded.notes
     returning *`,
    [
      site.name,
      site.router_model || null,
      site.wpa_mode || null,
      site.wifi_channel || null,
      Boolean(site.has_mesh),
      site.notes || null
    ]
  );
  return rows[0];
}

export async function deleteSite(id) {
  await query('delete from sites where id = $1', [id]);
}

export async function assignDevice(smartlockId, siteId) {
  if (siteId === null) {
    await query('delete from device_sites where smartlock_id = $1', [smartlockId]);
    return;
  }
  await query(
    `insert into device_sites (smartlock_id, site_id) values ($1,$2)
     on conflict (smartlock_id) do update set site_id = excluded.site_id`,
    [smartlockId, siteId]
  );
}

export async function siteByName(name) {
  const { rows } = await query('select * from sites where name = $1', [name]);
  return rows[0] || null;
}

// ------------------------------------------------------------ Aenderungen

export async function listChanges() {
  const { rows } = await query(
    `select c.*, s.name as site_name from changes c
     left join sites s on s.id = c.site_id
     order by c.applied_at desc limit 200`
  );
  return rows;
}

export async function createChange(change) {
  const { rows } = await query(
    'insert into changes (site_id, applied_at, title, description) values ($1,$2,$3,$4) returning *',
    [change.site_id || null, change.applied_at, change.title, change.description || null]
  );
  return rows[0];
}

export async function deleteChange(id) {
  await query('delete from changes where id = $1', [id]);
}

export async function getChange(id) {
  const { rows } = await query(
    'select c.*, s.name as site_name from changes c left join sites s on s.id = c.site_id where c.id = $1',
    [id]
  );
  return rows[0] || null;
}

export async function devicesForSite(siteId) {
  if (!siteId) {
    const { rows } = await query('select smartlock_id from devices');
    return rows.map((r) => String(r.smartlock_id));
  }
  const { rows } = await query('select smartlock_id from device_sites where site_id = $1', [siteId]);
  return rows.map((r) => String(r.smartlock_id));
}

// ---------------------------------------------------------------- Alarme

export async function openAlert(scope, kind, smartlockId, detail) {
  const { rows } = await query(
    'insert into alerts (scope, kind, smartlock_id, detail) values ($1,$2,$3,$4) returning *',
    [scope, kind, smartlockId, JSON.stringify(detail || {})]
  );
  return rows[0];
}

export async function findOpenAlert(scope, smartlockId) {
  if (smartlockId === null) {
    const { rows } = await query(
      'select * from alerts where closed_at is null and scope = $1 and smartlock_id is null order by opened_at desc limit 1',
      [scope]
    );
    return rows[0] || null;
  }
  const { rows } = await query(
    'select * from alerts where closed_at is null and scope = $1 and smartlock_id = $2 order by opened_at desc limit 1',
    [scope, smartlockId]
  );
  return rows[0] || null;
}

export async function closeAlert(id) {
  const { rows } = await query('update alerts set closed_at = now() where id = $1 returning *', [id]);
  return rows[0];
}

export async function listAlerts(limit = 50) {
  const { rows } = await query(
    `select a.*, d.name as device_name, s.name as site_name from alerts a
     left join devices d on d.smartlock_id = a.smartlock_id
     left join device_sites ds on ds.smartlock_id = a.smartlock_id
     left join sites s on s.id = ds.site_id
     order by a.opened_at desc limit $1`,
    [limit]
  );
  return rows;
}

// ----------------------------------------------------------------- Sonde

export async function insertProbeSample(sample) {
  await query(
    'insert into probe_samples (site_id, measured_at, target, reachable, rtt_ms, source, raw) values ($1,$2,$3,$4,$5,$6,$7)',
    [
      sample.site_id,
      sample.measured_at || new Date(),
      sample.target || null,
      sample.reachable ?? null,
      sample.rtt_ms ?? null,
      sample.source || 'probe',
      JSON.stringify(sample.raw || {})
    ]
  );
}

export async function probeSummary(from) {
  const { rows } = await query(
    `select p.site_id, s.name as site_name,
            count(*)::int as samples,
            sum(case when p.reachable then 0 else 1 end)::int as failures,
            avg(p.rtt_ms) as avg_rtt_ms,
            max(p.received_at) as last_seen
     from probe_samples p left join sites s on s.id = p.site_id
     where p.received_at >= $1
     group by p.site_id, s.name order by failures desc`,
    [from]
  );
  return rows;
}

export async function cleanup(sampleDays, eventDays) {
  await query(`delete from samples where sampled_at < now() - ($1 || ' days')::interval`, [String(sampleDays)]);
  await query(`delete from events where occurred_at < now() - ($1 || ' days')::interval`, [String(eventDays)]);
  await query(`delete from probe_samples where received_at < now() - ($1 || ' days')::interval`, [String(sampleDays)]);
  await query("delete from poll_runs where started_at < now() - interval '30 days'");
  await query("delete from webhook_deliveries where received_at < now() - interval '30 days'");
  await query("delete from alerts where closed_at is not null and closed_at < now() - interval '90 days'");
}
