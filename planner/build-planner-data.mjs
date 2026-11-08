#!/usr/bin/env node
// Build the data bundle used by the multimodal journey planner.
//
//   node planner/build-planner-data.mjs
//
// Reads the raw sources already in this repo:
//   data/gtfs/*.txt           CDTA GTFS (routes, stops, trips, stop_times, calendar)
//   data/shuttle_routes.json  shuttle stop coordinates + per-stop route offsets
//   data/shuttle_schedule.json departure times per bus per day type
//   data/bikedata.geojson     CDPHP bike share docks
//
// and writes planner/planner-data.json with:
//   shuttle   — stops with per-route minute offsets, and one bus trip list per day type
//   cdta      — trip patterns with explicit stop times + the service calendar
//   docks     — bike share dock coordinates and names
//   footpaths — pairs of stops within walking distance, with estimated walk minutes
//
// Assumptions are documented inline where they are made.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'planner', 'planner-data.json');

// Tunables, kept as named constants so the trade-offs are visible.
const TRANSFER_WALK_M = 250;      // max walk between two stops to count as a transfer
const WALK_M_PER_MIN = 75;        // ~4.5 km/h; estimates footpath minutes (not drawn legs)
const BIKE_MIN_PER_KM = 5;        // ~12 km/h; estimates dock-to-dock ride minutes

const readJson = async (rel) => JSON.parse(await readFile(path.join(ROOT, rel), 'utf8'));

// Read one GTFS csv into row objects. Handles quoted fields (route names
// contain commas) and an optional BOM.
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

// Great-circle distance in meters. Good enough for walking-threshold
// decisions. Accepts points as [lat, lon] arrays or {lat, lon} objects.
export function haversineMeters(a, b) {
    const [lat1, lon1] = Array.isArray(a) ? a : [a.lat, a.lon];
    const [lat2, lon2] = Array.isArray(b) ? b : [b.lat, b.lon];
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

// '7:05 PM' -> minutes since midnight (1145). Shuttle schedule uses 12-hour clocks.
export function parseClock12(text) {
    const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(text).trim());
    if (!match) throw new Error(`Unreadable shuttle time: ${text}`);
    let hours = Number(match[1]) % 12;
    if (match[3].toUpperCase() === 'PM') hours += 12;
    return hours * 60 + Number(match[2]);
}

// 'STUDENT_UNION' -> 'Student Union', unless a curated name exists below.
const SHUTTLE_STOP_NAMES = {
    STUDENT_UNION: 'Student Union',
    STUDENT_UNION_RETURN: 'Student Union',
    COLONIE: 'Colonie Avenue',
    GEORGIAN: 'Georgian Court',
    BRINSMADE: 'Brinsmade Drive',
    STAC_1: 'STAC I',
    STAC_2: 'STAC II',
    STAC_3: 'STAC III',
    ECAV: 'ECAV',
    HOUSTON_FIELD_HOUSE: 'Houston Field House',
    ACADEMY_HALL: 'Academy Hall',
    POLYTECHNIC: 'Polytechnic Apartments',
    CITY_STATION: 'City Station',
    BLITMAN: 'Blitman Commons',
    CHASAN: 'Chasan Building',
    FEDERAL_6TH: 'Federal St & 6th Ave',
    WEST_HALL: 'West Hall',
    SAGE_HALL: 'Sage Hall',
    POLK_ST_AND_4TH: 'Polk St & 4th St',
    '7_EAST': '7 East',
};

function humanizeStopKey(key) {
    if (SHUTTLE_STOP_NAMES[key]) return SHUTTLE_STOP_NAMES[key];
    return key.toLowerCase()
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

// ---------------------------------------------------------------- shuttles
//
// shuttle_routes.json gives every shuttle stop a route-specific OFFSET, in
// minutes after the bus leaves Student Union (both loops are ~15 minutes end
// to end, which is what makes the minutes interpretation credible).
// shuttle_schedule.json gives each bus a list of [departure clock time, route].
// A trip is therefore: start minute + route; the stop times follow from offsets.
function buildShuttle(schedule, routeShapes) {
    // Stop order: NORTH loop first, then any WEST-only stops, then entry/exit
    // routes are skipped (those are private car routes to campus, not part of
    // the on-campus transit web).
    const routeNames = { NORTH: 'North Shuttle', WEST: 'West Shuttle' };
    const loopRoutes = Object.keys(routeNames);
    const stopOrder = [];
    for (const routeKey of loopRoutes) {
        for (const stopKey of routeShapes[routeKey].STOPS) {
            if (!stopOrder.includes(stopKey)) stopOrder.push(stopKey);
        }
    }

    const stops = stopOrder.map((stopKey) => {
        const offsets = {};
        let coords = null;
        for (const routeKey of loopRoutes) {
            const stop = routeShapes[routeKey][stopKey];
            if (!stop) continue;
            offsets[routeKey] = stop.OFFSET;
            coords ??= stop.COORDINATES;
        }
        return {
            key: stopKey,
            name: humanizeStopKey(stopKey),
            lat: coords[0],
            lon: coords[1],
            offsets,
        };
    });

    // One trip list per day type. Each entry: route the bus loops, and the
    // minute (since midnight) it leaves Student Union.
    const tripsByDayType = { weekday: [], saturday: [], sunday: [] };
    for (const [dayType, vehicles] of Object.entries(tripsByDayType)) {
        for (const [vehicleName, departures] of Object.entries(schedule[dayType])) {
            for (const [clock, routeKey] of departures) {
                if (!routeNames[routeKey]) {
                    console.warn(`shuttle schedule: ${vehicleName} names unknown route ${routeKey}; skipped`);
                    continue;
                }
                tripsByDayType[dayType].push({ route: routeKey, start: parseClock12(clock) });
            }
        }
        tripsByDayType[dayType].sort((a, b) => a.start - b.start);
    }

    return {
        stops,
        routes: Object.fromEntries(loopRoutes.map((key) => {
            const lastStopKey = routeShapes[key].STOPS.at(-1);
            const loopMinutes = routeShapes[key][lastStopKey].OFFSET;
            return [key, {
                name: routeNames[key],
                color: routeShapes[key].COLOR,
                loopMinutes,
                // Road geometry with per-point minute offsets, so the UI can
                // draw exactly the slice of the loop a rider experiences.
                shape: buildShuttleShape(routeShapes[key]),
            }];
        })),
        trips: tripsByDayType,
    };
}

// Concatenate the route's per-leg polylines in POLYLINE_STOPS order, tagging
// each point with a minute offset interpolated between the leg's stop offsets.
// Result: [[lat, lon, minuteOffset], ...] — small, and enough to slice legs.
function buildShuttleShape(routeShape) {
    const stopKeys = routeShape.POLYLINE_STOPS;
    const legs = routeShape.ROUTES;
    const shape = [];
    for (let legIndex = 0; legIndex < legs.length; legIndex++) {
        const from = routeShape[stopKeys[legIndex]];
        const to = routeShape[stopKeys[legIndex + 1]];
        if (!from || !to) continue;
        const leg = legs[legIndex];
        for (let i = 0; i < leg.length; i++) {
            const t = leg.length === 1 ? 0 : i / (leg.length - 1);
            const offset = from.OFFSET + (to.OFFSET - from.OFFSET) * t;
            shape.push([
                Math.round(leg[i][0] * 1e6) / 1e6,
                Math.round(leg[i][1] * 1e6) / 1e6,
                Math.round(offset * 10) / 10,
            ]);
        }
    }
    return shape;
}

// ---------------------------------------------------------------- CDTA
//
// Patterns are built straight from the GTFS text files so the planner data has
// exact trip stop times and needs no decoding tricks in the browser.
//
// A pattern is one stop sequence shared by many trips, e.g. "route 87,
// alighting-listed stops in order". Each pattern stores:
//   stops   — indexes into cdta.stops, in boarding order
//   offsets — departure minutes at each stop, relative to the first stop
//   trips   — [serviceIndex, firstDepartureMinute], sorted by departure
// The browser picks a trip by binary search, then checks the service calendar.
function round5(value) {
    return Math.round(Number(value) * 1e5) / 1e5;
}

async function buildCdta() {
    const routesTxt = await readGtfs('routes.txt');
    const stopsTxt = await readGtfs('stops.txt');
    const tripsTxt = await readGtfs('trips.txt');
    const calendarTxt = await readGtfs('calendar.txt');
    const calendarDatesTxt = await readGtfs('calendar_dates.txt');
    const stopTimesTxt = await readGtfs('stop_times.txt');

    // --- stops and routes (stable, readable ordering) ---
    const stopIndexByGtfsId = new Map();
    const stopsOut = [];
    for (const stop of stopsTxt) {
        stopIndexByGtfsId.set(stop.stop_id, stopsOut.length);
        stopsOut.push([
            stop.stop_id,
            stop.stop_name,
            round5(stop.stop_lat),
            round5(stop.stop_lon),
        ]);
    }

    const routeIndexByGtfsId = new Map();
    const routesOut = [];
    const sortedRoutes = [...routesTxt].sort((a, b) =>
        (Number(a.route_short_name) || 9999) - (Number(b.route_short_name) || 9999) ||
        a.route_short_name.localeCompare(b.route_short_name));
    for (const route of sortedRoutes) {
        routeIndexByGtfsId.set(route.route_id, routesOut.length);
        routesOut.push({
            id: route.route_id,
            short: route.route_short_name,
            name: route.route_long_name,
            color: route.route_color || '123573',
        });
    }

    // --- service calendar (same structure the map already uses) ---
    const serviceIndexById = new Map();
    const servicesOut = [];
    const allServiceIds = [
        ...new Set([
            ...calendarTxt.map((row) => row.service_id),
            ...calendarDatesTxt.map((row) => row.service_id),
        ]),
    ].sort();
    const calendarByService = new Map(calendarTxt.map((row) => [row.service_id, row]));
    for (const serviceId of allServiceIds) {
        serviceIndexById.set(serviceId, servicesOut.length);
        const cal = calendarByService.get(serviceId);
        if (cal) {
            const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
                .map((day) => cal[day]).join('');
            servicesOut.push([days, Number(cal.start_date), Number(cal.end_date)]);
        } else {
            // Service only exists through calendar_dates exceptions.
            servicesOut.push(['0000000', 0, 0]);
        }
    }
    const exceptionsOut = {};
    for (const row of calendarDatesTxt) {
        (exceptionsOut[row.date] ??= []).push([
            serviceIndexById.get(row.service_id),
            Number(row.exception_type),
        ]);
    }

    // --- stop times -> trips -> patterns ---
    // stop_times.txt is grouped by trip_id. Collect each trip's
    // [stopIndex, departureMinute] sequence, then fold trips into patterns.
    const headsignByTrip = new Map(tripsTxt.map((t) => [t.trip_id, t]));
    const patternsOut = [];
    const patternKeyToIndex = new Map();

    let currentTripId = null;
    let currentStops = [];
    let currentTimes = [];

    function flushTrip() {
        if (currentTripId === null) return;
        const trip = headsignByTrip.get(currentTripId);
        if (!trip) return; // defensive: trips.txt should cover every stop_times row

        const stopIndexes = currentStops;
        const firstMinute = currentTimes[0];
        const offsets = currentTimes.map((m) => m - firstMinute);

        // Trips that run past midnight still belong to this pattern; the
        // search handles minutes >= 1440 by checking the previous service day.
        const key = [trip.route_id, trip.trip_headsign, stopIndexes.join(',')].join('|');
        let patternIndex = patternKeyToIndex.get(key);
        if (patternIndex === undefined) {
            patternIndex = patternsOut.length;
            patternKeyToIndex.set(key, patternIndex);
            patternsOut.push({
                route: routeIndexByGtfsId.get(trip.route_id),
                headsign: trip.trip_headsign,
                stops: stopIndexes,
                offsets,
                trips: [],
            });
        }
        patternsOut[patternIndex].trips.push([
            serviceIndexById.get(trip.service_id),
            firstMinute,
        ]);
        currentStops = [];
        currentTimes = [];
    }

    for (const row of stopTimesTxt) {
        if (row.trip_id !== currentTripId) {
            flushTrip();
            currentTripId = row.trip_id;
        }
        const stopIndex = stopIndexByGtfsId.get(row.stop_id);
        if (stopIndex === undefined) continue; // stop not in stops.txt (should not happen)
        const clock = row.departure_time || row.arrival_time;
        const [h, m] = clock.split(':').map(Number);
        currentStops.push(stopIndex);
        currentTimes.push(h * 60 + m);
    }
    flushTrip();

    // Sort each pattern's trips by departure and drop duplicate departures
    // (the same service running twice under two trip ids).
    for (const pattern of patternsOut) {
        pattern.trips.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
        pattern.trips = pattern.trips.filter((trip, i) =>
            i === 0 || trip[1] !== pattern.trips[i - 1][1] || trip[0] !== pattern.trips[i - 1][0]);
    }

    const feedRow = (await readGtfs('feed_info.txt'))[0] ?? {};
    return {
        feed: {
            publisher: feedRow.feed_publisher_name || 'CDTA',
            start: feedRow.feed_start_date || '',
            end: feedRow.feed_end_date || '',
        },
        stops: stopsOut,
        routes: routesOut,
        services: servicesOut,
        exceptions: exceptionsOut,
        patterns: patternsOut,
    };
}

// ---------------------------------------------------------------- bike docks
function buildDocks(geojson) {
    return geojson.features
        .filter((feature) => feature.geometry?.type === 'Point')
        .map((feature) => ({
            name: feature.properties?.name || 'CDPHP rack',
            capacity: Number(feature.properties?.capacity) || null,
            lat: feature.geometry.coordinates[1],
            lon: feature.geometry.coordinates[0],
        }));
}

// ---------------------------------------------------------------- footpaths
// All stop pairs (shuttle↔CDTA, CDTA↔CDTA, shuttle↔shuttle) close enough to
// walk between. These let the search change vehicle at nearby stops, which is
// the whole trick behind "shuttle to downtown, then the bus onward".
function buildFootpaths(shuttle, cdta) {
    const allStops = [
        ...shuttle.stops.map((stop) => ({ kind: 'shuttle', id: stop.key, lat: stop.lat, lon: stop.lon })),
        ...cdta.stops.map((stop, index) => ({ kind: 'cdta', id: index, lat: stop[2], lon: stop[3] })),
    ];

    const footpaths = [];
    for (let i = 0; i < allStops.length; i++) {
        for (let j = i + 1; j < allStops.length; j++) {
            const a = allStops[i];
            const b = allStops[j];
            const meters = haversineMeters([a.lat, a.lon], [b.lat, b.lon]);
            if (meters > TRANSFER_WALK_M) continue;
            const minutes = Math.max(1, Math.round(meters / WALK_M_PER_MIN));
            footpaths.push({ from: `${a.kind}:${a.id}`, to: `${b.kind}:${b.id}`, meters: Math.round(meters), minutes });
            footpaths.push({ from: `${b.kind}:${b.id}`, to: `${a.kind}:${a.id}`, meters: Math.round(meters), minutes });
        }
    }
    return footpaths;
}

// ---------------------------------------------------------------- main
async function main() {
    const [schedule, routeShapes, bikeGeojson] = await Promise.all([
        readJson('data/shuttle_schedule.json'),
        readJson('data/shuttle_routes.json'),
        readJson('data/bikedata.geojson'),
    ]);

    console.log('Building shuttle timetables…');
    const shuttle = buildShuttle(schedule, routeShapes);

    console.log('Building CDTA patterns from GTFS…');
    const cdta = await buildCdta();

    console.log('Collecting bike docks…');
    const docks = buildDocks(bikeGeojson);

    console.log('Computing footpaths between nearby stops…');
    const footpaths = buildFootpaths(shuttle, cdta);

    const bundle = {
        generatedWith: 'planner/build-planner-data.mjs',
        shuttle,
        cdta,
        docks,
        footpaths,
        config: { TRANSFER_WALK_M, WALK_M_PER_MIN, BIKE_MIN_PER_KM },
    };

    await mkdir(path.dirname(OUT), { recursive: true });
    await writeFile(OUT, JSON.stringify(bundle));
    const mb = (await (await import('node:fs/promises')).stat(OUT)).size / 1e6;
    console.log(`Wrote ${path.relative(ROOT, OUT)} (${mb.toFixed(2)} MB)`);
    console.log(`  shuttle: ${shuttle.stops.length} stops, ` +
        `trips: ${shuttle.trips.weekday.length}/${shuttle.trips.saturday.length}/${shuttle.trips.sunday.length} (M-F/Sat/Sun)`);
    console.log(`  cdta: ${cdta.routes.length} routes, ${cdta.stops.length} stops, ${cdta.patterns.length} patterns`);
    console.log(`  docks: ${docks.length}, footpaths: ${footpaths.length}`);
}

// Only run when executed directly; importing for tests must stay side-effect free.
if (import.meta.url === `file://${process.argv[1]}` || import.meta.url === process.argv[1]) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
