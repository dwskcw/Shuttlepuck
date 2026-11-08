#!/usr/bin/env node
// Record live RPI shuttle GPS pings into the Tiger hypertable.
//
//   node --env-file=.env db/record-shuttles.mjs            # run forever
//   node --env-file=.env db/record-shuttles.mjs --once     # single sample
//
// Polls the public Shubble endpoints (no key needed) every POLL_SECONDS and
// batch-inserts new positions. Matching a vehicle to its route uses the same
// /api/velocities endpoint the map uses; near_stop is the closest shuttle
// stop within NEAR_STOP_M meters (NULL otherwise) so the analytics views can
// segment trips without any geometry extension in the database.

import pg from 'pg';

const POLL_SECONDS = Number(process.env.POLL_SECONDS ?? 20);
const NEAR_STOP_M = 60;
const SHUTTLE_API = process.env.SHUTTLE_API ?? 'https://shuttles.rpi.edu';

if (!process.env.TIGER_DATABASE_URL) {
    console.error('Set TIGER_DATABASE_URL in .env (copy .env.example). Aborting.');
    process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.TIGER_DATABASE_URL });
await client.connect();

// Shuttle stops loaded from the repo bundle; kept in memory for the
// near-stop matching.
const { readFile } = await import('node:fs/promises');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = JSON.parse(await readFile(path.join(ROOT, 'planner', 'planner-data.json'), 'utf8'));
const stops = bundle.shuttle.stops.map((s) => ({ key: s.key, lat: s.lat, lon: s.lon }));

function haversineMeters(a, b) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(b[0] - a[0]);
    const dLon = toRad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function nearestStop(lat, lon) {
    let best = null;
    for (const stop of stops) {
        const meters = haversineMeters([lat, lon], [stop.lat, stop.lon]);
        if (meters <= NEAR_STOP_M && (!best || meters < best.meters)) {
            best = { key: stop.key, meters };
        }
    }
    return best?.key ?? null;
}

async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.json();
}

async function sampleOnce() {
    const [locations, velocities] = await Promise.all([
        fetchJson(`${SHUTTLE_API}/api/locations`),
        fetchJson(`${SHUTTLE_API}/api/velocities`).catch(() => ({})),
    ]);

    const rows = [];
    for (const [vehicleId, v] of Object.entries(locations)) {
        if (!Number.isFinite(v.latitude) || !Number.isFinite(v.longitude)) continue;
        const route = velocities[vehicleId]?.route_name ?? null;
        rows.push([
            new Date(),                          // recorded_at: when WE saw it
            vehicleId,
            v.name ?? null,
            route === 'NORTH' || route === 'WEST' ? route : null,
            nearestStop(v.latitude, v.longitude),
            v.latitude,
            v.longitude,
            Number.isFinite(v.speed_mph) ? v.speed_mph : null,
            Number.isFinite(v.heading_degrees) ? v.heading_degrees : null,
        ]);
    }

    if (rows.length === 0) {
        console.log(new Date().toISOString(), 'no vehicles in service');
        return 0;
    }
    await client.query(
        `INSERT INTO shuttle_positions
             (recorded_at, vehicle_id, vehicle_name, route_key, near_stop,
              lat, lon, speed_mph, heading_deg)
         SELECT * FROM UNNEST($1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::text[],
                              $6::float8[], $7::float8[], $8::real[], $9::real[])`,
        [rows.map((r) => r[0]), rows.map((r) => r[1]), rows.map((r) => r[2]),
         rows.map((r) => r[3]), rows.map((r) => r[4]), rows.map((r) => r[5]),
         rows.map((r) => r[6]), rows.map((r) => r[7]), rows.map((r) => r[8])]
    );
    console.log(new Date().toISOString(), `inserted ${rows.length} positions`);
    return rows.length;
}

const once = process.argv.includes('--once');
if (once) {
    await sampleOnce();
    await client.end();
} else {
    console.log(`Recording shuttle GPS every ${POLL_SECONDS}s. Ctrl-C to stop.`);
    setInterval(() => sampleOnce().catch((error) => console.error(error.message)), POLL_SECONDS * 1000);
    await sampleOnce().catch((error) => console.error(error.message));
}
