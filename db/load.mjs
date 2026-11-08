#!/usr/bin/env node
// Load the repo's existing data into the Tiger Data Postgres service.
//
//   node --env-file=.env db/load.mjs
//
// Requires .env to define TIGER_DATABASE_URL (see .env.example). Uses the
// `pg` client (npm i pg). Safe to re-run: every load truncates its tables
// first, so the database always mirrors the repo data.
//
// Loaded: CDTA GTFS (routes, stops, services, exceptions, trips, stop_times),
// shuttle routes/stops/scheduled departures, and bike docks.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!process.env.TIGER_DATABASE_URL) {
    console.error('Set TIGER_DATABASE_URL in .env (copy .env.example). Aborting.');
    process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.TIGER_DATABASE_URL });
await client.connect();

// CSV reader for the GTFS text files (quoted fields included).
function parseCsvLine(line) {
    const values = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (inQuotes) {
            if (char === '"' && line[i + 1] === '"') { current += '"'; i++; }
            else if (char === '"') inQuotes = false;
            else current += char;
        } else if (char === '"') {
            inQuotes = true;
        } else if (char === ',') {
            values.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    values.push(current);
    return values;
}

async function readGtfs(name) {
    const text = await readFile(path.join(ROOT, 'data', 'gtfs', name), 'utf8');
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.length > 0);
    const headers = parseCsvLine(lines[0]);
    return lines.slice(1).map((line) => {
        const values = parseCsvLine(line);
        const row = {};
        headers.forEach((header, i) => { row[header] = values[i]; });
        return row;
    });
}

const readJson = async (rel) => JSON.parse(await readFile(path.join(ROOT, rel), 'utf8'));

// Insert rows in bounded batches; parameterized queries keep quoting safe.
async function insertBatched(table, columns, rows, batchSize = 500) {
    let inserted = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        const values = [];
        const params = [];
        batch.forEach((row, rowIdx) => {
            const placeholders = row.map((_, colIdx) => `$${rowIdx * row.length + colIdx + 1}`);
            values.push(`(${placeholders.join(', ')})`);
            params.push(...row);
        });
        await client.query(
            `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${values.join(', ')}`,
            params
        );
        inserted += batch.length;
    }
    return inserted;
}

async function main() {
    console.log('Loading CDTA routes…');
    const routesTxt = await readGtfs('routes.txt');
    await client.query('TRUNCATE cdta_stop_times, cdta_trips, cdta_service_exceptions, cdta_services, cdta_stops, cdta_routes');
    await insertBatched('cdta_routes',
        ['route_id', 'short_name', 'long_name', 'color', 'sort_order'],
        routesTxt.map((r) => [r.route_id, r.route_short_name, r.route_long_name,
            r.route_color || '123573', Number(r.route_sort_order) || null]));

    console.log('Loading CDTA stops…');
    const stopsTxt = await readGtfs('stops.txt');
    await insertBatched('cdta_stops',
        ['stop_id', 'name', 'lat', 'lon'],
        stopsTxt.map((s) => [s.stop_id, s.stop_name, Number(s.stop_lat), Number(s.stop_lon)]));

    console.log('Loading CDTA calendar…');
    const calendarTxt = await readGtfs('calendar.txt');
    const calendarDatesTxt = await readGtfs('calendar_dates.txt');
    const tripsTxt = await readGtfs('trips.txt');

    const serviceIds = [...new Set([
        ...calendarTxt.map((r) => r.service_id),
        ...calendarDatesTxt.map((r) => r.service_id),
        ...tripsTxt.map((r) => r.service_id),
    ])];
    const byService = new Map(calendarTxt.map((r) => [r.service_id, r]));
    // calendar-only rows insert their flags; exception-only services get an
    // all-false placeholder row so foreign keys from trips still resolve.
    await insertBatched('cdta_services',
        ['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date'],
        serviceIds.map((id) => {
            const c = byService.get(id);
            return c
                ? [id, c.monday === '1', c.tuesday === '1', c.wednesday === '1', c.thursday === '1',
                   c.friday === '1', c.saturday === '1', c.sunday === '1',
                   Number(c.start_date), Number(c.end_date)]
                : [id, false, false, false, false, false, false, false, 0, 0];
        }));

    await insertBatched('cdta_service_exceptions',
        ['service_id', 'date', 'exception_type'],
        calendarDatesTxt.map((e) => [e.service_id, Number(e.date), Number(e.exception_type)]));

    console.log('Loading CDTA trips…');
    await insertBatched('cdta_trips',
        ['trip_id', 'route_id', 'service_id', 'headsign', 'direction_id'],
        tripsTxt.map((t) => [t.trip_id, t.route_id, t.service_id, t.trip_headsign,
            t.direction_id === '' ? null : Number(t.direction_id)]));

    console.log('Loading CDTA stop times (this is the big one, ~788k rows)…');
    const stopTimesRows = [];
    for (const row of await readGtfs('stop_times.txt')) {
        const clock = (row.departure_time || row.arrival_time).split(':');
        stopTimesRows.push([
            row.trip_id,
            Number(row.stop_sequence),
            row.stop_id,
            Number(clock[0]) * 3600 + Number(clock[1]) * 60 + Number(clock[2]),
        ]);
    }
    await insertBatched('cdta_stop_times', ['trip_id', 'stop_sequence', 'stop_id', 'departure_sec'], stopTimesRows, 1000);
    console.log(`  ${stopTimesRows.length.toLocaleString()} stop times`);

    console.log('Loading shuttles…');
    const schedule = await readJson('data/shuttle_schedule.json');
    const routeShapes = await readJson('data/shuttle_routes.json');
    await client.query('TRUNCATE shuttle_departures, shuttle_stops, shuttle_routes');

    await insertBatched('shuttle_routes', ['route_key', 'name', 'color'], [
        ['NORTH', 'North Shuttle', routeShapes.NORTH.COLOR],
        ['WEST', 'West Shuttle', routeShapes.WEST.COLOR],
    ]);

    // Shuttle stop offsets live on each route's stop object; a stop only one
    // loop serves gets NULL for the other loop.
    const stopKeys = [...new Set([
        ...routeShapes.NORTH.STOPS,
        ...routeShapes.WEST.STOPS,
    ])];
    const stopNames = {
        STUDENT_UNION: 'Student Union', STUDENT_UNION_RETURN: 'Student Union',
        COLONIE: 'Colonie Avenue', GEORGIAN: 'Georgian Court', BRINSMADE: 'Brinsmade Drive',
        STAC_1: 'STAC I', STAC_2: 'STAC II', STAC_3: 'STAC III', ECAV: 'ECAV',
        HOUSTON_FIELD_HOUSE: 'Houston Field House', ACADEMY_HALL: 'Academy Hall',
        POLYTECHNIC: 'Polytechnic Apartments', CITY_STATION: 'City Station',
        BLITMAN: 'Blitman Commons', CHASAN: 'Chasan Building', FEDERAL_6TH: 'Federal St & 6th Ave',
        WEST_HALL: 'West Hall', SAGE_HALL: 'Sage Hall',
    };
    const humanize = (key) => stopNames[key] ?? key.toLowerCase().replaceAll('_', ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
    await insertBatched('shuttle_stops',
        ['stop_key', 'name', 'lat', 'lon', 'north_offset_min', 'west_offset_min'],
        stopKeys.map((key) => {
            const north = routeShapes.NORTH[key];
            const west = routeShapes.WEST[key];
            const coords = (north ?? west).COORDINATES;
            return [key, humanize(key), coords[0], coords[1],
                north?.OFFSET ?? null, west?.OFFSET ?? null];
        }));

    const departureRows = [];
    for (const dayType of ['weekday', 'saturday', 'sunday']) {
        for (const departures of Object.values(schedule[dayType])) {
            for (const [clock, routeKey] of departures) {
                const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(clock.trim());
                if (!match) throw new Error(`Unreadable shuttle time: ${clock}`);
                let hours = Number(match[1]) % 12;
                if (match[3].toUpperCase() === 'PM') hours += 12;
                departureRows.push([routeKey, dayType, hours * 60 + Number(match[2])]);
            }
        }
    }
    await insertBatched('shuttle_departures', ['route_key', 'day_type', 'start_min'], departureRows);
    console.log(`  ${departureRows.length} scheduled departures`);

    console.log('Loading bike docks…');
    const bikeGeojson = await readJson('data/bikedata.geojson');
    await client.query('TRUNCATE bike_docks');
    const docks = bikeGeojson.features
        .filter((f) => f.geometry?.type === 'Point')
        .map((f) => [f.properties?.name || 'CDPHP rack',
            Number(f.properties?.capacity) || null,
            f.geometry.coordinates[1], f.geometry.coordinates[0]]);
    await insertBatched('bike_docks', ['name', 'capacity', 'lat', 'lon'], docks);
    console.log(`  ${docks.length} docks`);

    console.log('Done. Database mirrors repo data.');
    await client.end();
}

main().catch(async (error) => {
    console.error(error);
    await client.end().catch(() => {});
    process.exitCode = 1;
});
