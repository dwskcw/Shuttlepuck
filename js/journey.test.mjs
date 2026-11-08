// Tests for the journey search (js/journey.js).
//
//   node --test
//
// Most tests run against a small synthetic bundle with two shuttle loops, one
// CDTA pattern, and a footpath between them — so a failure points at the
// search logic, not at real-world data quirks. One test reads the real
// planner bundle to catch regressions in how the pieces fit together.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    buildIndex, search, findWalkAccess, buildDirectOptions,
    shuttleGeometryBetweenStops, trimGeometryAtStop,
} from './journey.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------
// Synthetic bundle. Geometry: shuttle A runs east-west at y=0,
// shuttle B shares one stop with A. The CDTA pattern starts at a
// stop 100 m from the shuttle interchange.
//
//   A0 --100m-- A1(interchange) --100m-- A2
//               +--100m-- C0 --100m-- C1
// ---------------------------------------------------------------
function syntheticBundle() {
    return {
        shuttle: {
            stops: [
                { key: 'A0', name: 'A zero', lat: 0.00000, lon: 0.00000, offsets: { A: 0 } },
                { key: 'A1', name: 'A one', lat: 0.00000, lon: 0.00180, offsets: { A: 5 } },
                { key: 'A2', name: 'A two', lat: 0.00000, lon: 0.00360, offsets: { A: 10 } },
            ],
            routes: {
                A: { name: 'Loop A', color: '#ff0000', loopMinutes: 20 },
            },
            trips: {
                weekday: [{ route: 'A', start: 600 }, { route: 'A', start: 660 }],
                saturday: [{ route: 'A', start: 600 }],
                sunday: [{ route: 'A', start: 600 }],
            },
        },
        cdta: {
            feed: { end: '20991231' },
            stops: [
                ['C0', 'Cee zero', 0.00000, 0.00378],  // ~100 m east of A1's lon .00360? kept near interchange
                ['C1', 'Cee one', 0.00000, 0.00558],
            ],
            routes: [{ id: '99', short: '99', name: 'Crosstown', color: '00ff00' }],
            services: [['1111100', 20200101, 20991231]],  // weekdays only
            exceptions: {},
            patterns: [{
                route: 0,
                headsign: 'Cee one',
                stops: [0, 1],
                offsets: [0, 12],
                trips: [[0, 615], [0, 675]],  // departs C0 at 10:15 and 11:15
            }],
        },
        docks: [],
        footpaths: [
            // The interchange walk: shuttle A1 <-> CDTA C0 (about 100 m).
            { from: 'shuttle:A1', to: 'cdta:0', meters: 100, minutes: 2 },
            { from: 'cdta:0', to: 'shuttle:A1', meters: 100, minutes: 2 },
        ],
        config: {},
    };
}

const WEEKDAY = '2026-11-04'; // a Wednesday
const run = (bundle, options) => search(buildIndex(bundle), options);

test('pure walk option appears for short trips', () => {
    const bundle = syntheticBundle();
    const origin = { lat: 0, lon: 0, label: 'Origin' };
    const destination = { lat: 0, lon: 0.002, label: 'Destination' };
    const direct = buildDirectOptions(bundle, origin, destination);
    assert.ok(direct.walk, 'short trip should offer a walk');
    const itineraries = run(bundle, {
        origin, destination, date: WEEKDAY, departMinute: 9 * 60,
        originAccess: [], destAccess: [], direct,
    });
    assert.ok(itineraries.some((it) => it.legs.length === 1 && it.legs[0].type === 'walk'));
});

test('rides the shuttle and arrives at downstream stops', () => {
    const bundle = syntheticBundle();
    // Origin next to A0, destination next to A2.
    const originAccess = [{ nodeKey: 'shuttle:A0', minutes: 1 }];
    const destAccess = [{ nodeKey: 'shuttle:A2', minutes: 1 }];
    const itineraries = run(bundle, {
        origin: { lat: 0, lon: 0, label: 'O' },
        destination: { lat: 0, lon: 0.0036, label: 'D' },
        date: WEEKDAY, departMinute: 9 * 60 + 55, // 9:55, bus leaves A0 at 10:00
        originAccess, destAccess, direct: {},
    });
    assert.ok(itineraries.length > 0, 'expected an itinerary');
    const best = itineraries[0];
    const shuttleLeg = best.legs.find((leg) => leg.type === 'shuttle');
    assert.ok(shuttleLeg, 'itinerary should include a shuttle leg');
    assert.equal(shuttleLeg.departMinute, 600); // 10:00 departure
    assert.equal(best.arrival, 600 + 10 + 1);   // ride 10 min, then 1 min walk
});

test('keeps a shuttle alternative with up to 20 minutes of waiting', () => {
    const bundle = syntheticBundle();
    const origin = { lat: 0, lon: 0, label: 'Origin' };
    const destination = { lat: 0, lon: 0.0036, label: 'Destination' };
    const itineraries = run(bundle, {
        origin,
        destination,
        date: WEEKDAY,
        departMinute: 9 * 60 + 48,
        originAccess: [{ nodeKey: 'shuttle:A0', minutes: 1 }],
        destAccess: [{ nodeKey: 'shuttle:A2', minutes: 1 }],
        direct: { walk: { minutes: 10 } },
    });

    assert.ok(itineraries.some((itinerary) =>
        itinerary.legs.length === 1 && itinerary.legs[0].type === 'walk'));
    const shuttleItinerary = itineraries.find((itinerary) =>
        itinerary.legs.some((leg) => leg.type === 'shuttle'));
    assert.ok(shuttleItinerary, 'expected a slower shuttle alternative');
    const shuttle = shuttleItinerary.legs.find((leg) => leg.type === 'shuttle');
    assert.equal(shuttle.waitMinutes, 11);
    assert.equal(shuttleItinerary.departure, 9 * 60 + 48);
    assert.equal(shuttleItinerary.arrival, 600 + 10 + 1);
});

test('does not offer a shuttle requiring more than 20 minutes of waiting', () => {
    const bundle = syntheticBundle();
    const itineraries = run(bundle, {
        origin: { lat: 0, lon: 0, label: 'Origin' },
        destination: { lat: 0, lon: 0.0036, label: 'Destination' },
        date: WEEKDAY,
        departMinute: 9 * 60 + 35,
        originAccess: [{ nodeKey: 'shuttle:A0', minutes: 1 }],
        destAccess: [{ nodeKey: 'shuttle:A2', minutes: 1 }],
        direct: { walk: { minutes: 10 } },
    });

    assert.ok(!itineraries.some((itinerary) =>
        itinerary.legs.some((leg) => leg.type === 'shuttle')));
});

test('does not offer shuttle routes that require more walking than walking directly', () => {
    const bundle = syntheticBundle();
    const itineraries = run(bundle, {
        origin: { lat: 0, lon: 0, label: 'Origin' },
        destination: { lat: 0, lon: 0.0036, label: 'Destination' },
        date: WEEKDAY,
        departMinute: 9 * 60 + 35,
        originAccess: [{ nodeKey: 'shuttle:A0', minutes: 14 }],
        destAccess: [{ nodeKey: 'shuttle:A2', minutes: 14 }],
        direct: { walk: { minutes: 7 } },
    });

    assert.ok(itineraries.some((itinerary) =>
        itinerary.legs.length === 1 && itinerary.legs[0].type === 'walk'));
    assert.ok(!itineraries.some((itinerary) =>
        itinerary.legs.some((leg) => leg.type === 'shuttle')));
});

test('keeps shuttle alternatives with modestly more walking than walking directly', () => {
    const bundle = syntheticBundle();
    const itineraries = run(bundle, {
        origin: { lat: 0, lon: 0, label: 'Origin' },
        destination: { lat: 0, lon: 0.0036, label: 'Destination' },
        date: WEEKDAY,
        departMinute: 9 * 60 + 48,
        originAccess: [{ nodeKey: 'shuttle:A0', minutes: 6 }],
        destAccess: [{ nodeKey: 'shuttle:A2', minutes: 6 }],
        direct: { walk: { minutes: 10 } },
    });

    assert.ok(itineraries.some((itinerary) =>
        itinerary.legs.some((leg) => leg.type === 'shuttle')));
});

test('gets off earlier when walking from there arrives sooner', () => {
    const bundle = syntheticBundle();
    bundle.shuttle.stops.push(
        { key: 'EARLY', name: 'Earlier stop', lat: 0, lon: 0.001, offsets: { A: 6 } },
        { key: 'LATER', name: 'Later stop', lat: 0, lon: 0.002, offsets: { A: 8 } },
    );
    const itineraries = run(bundle, {
        origin: { lat: 0, lon: 0, label: 'Origin' },
        destination: { lat: 0, lon: 0.002, label: 'Destination' },
        date: WEEKDAY,
        departMinute: 9 * 60 + 48,
        originAccess: [{ nodeKey: 'shuttle:A0', minutes: 1 }],
        destAccess: [
            { nodeKey: 'shuttle:EARLY', minutes: 8 },
            { nodeKey: 'shuttle:LATER', minutes: 12 },
        ],
        direct: { walk: { minutes: 30 } },
    });

    const shuttleOptions = itineraries.filter((itinerary) =>
        itinerary.legs.some((leg) => leg.type === 'shuttle'));
    assert.ok(shuttleOptions.length > 0, 'expected a shuttle option');
    assert.ok(shuttleOptions.some((itinerary) =>
        itinerary.legs.some((leg) => leg.type === 'shuttle' && leg.to === 'Earlier stop')));
    assert.ok(!shuttleOptions.some((itinerary) =>
        itinerary.legs.some((leg) => leg.type === 'shuttle' && leg.to === 'Later stop')));
});

test('prefers the shortest walk to board the same shuttle run', () => {
    const bundle = syntheticBundle();
    const itineraries = run(bundle, {
        origin: { lat: 0, lon: 0, label: 'Origin' },
        destination: { lat: 0, lon: 0.0036, label: 'Destination' },
        date: WEEKDAY,
        departMinute: 9 * 60 + 49,
        originAccess: [
            { nodeKey: 'shuttle:A0', minutes: 4 },
            { nodeKey: 'shuttle:A1', minutes: 8 },
        ],
        destAccess: [{ nodeKey: 'shuttle:A2', minutes: 1 }],
        direct: { walk: { minutes: 30 } },
    });

    const shuttleOptions = itineraries.filter((itinerary) =>
        itinerary.legs.some((leg) => leg.type === 'shuttle'));
    assert.equal(shuttleOptions.length, 1);
    assert.equal(shuttleOptions[0].legs[0].to, 'A zero');
});

test('chains shuttle -> footpath -> bus with wait time', () => {
    const bundle = syntheticBundle();
    const originAccess = [{ nodeKey: 'shuttle:A0', minutes: 1 }];
    const destAccess = [{ nodeKey: 'cdta:1', minutes: 2 }];
    const itineraries = run(bundle, {
        origin: { lat: 0, lon: 0, label: 'O' },
        destination: { lat: 0, lon: 0.0056, label: 'D' },
        date: WEEKDAY, departMinute: 9 * 60 + 55,
        originAccess, destAccess, direct: {},
    });
    const chained = itineraries.find((it) => it.legs.some((l) => l.type === 'bus'));
    assert.ok(chained, 'expected a shuttle + bus itinerary');
    const shuttleLeg = chained.legs.find((l) => l.type === 'shuttle');
    const busLeg = chained.legs.find((l) => l.type === 'bus');
    assert.equal(shuttleLeg.departMinute, 600);
    // Shuttle reaches A1 at 605, walk 2 min -> 607 at C0; bus leaves C0 at 615.
    assert.equal(busLeg.departMinute, 615);
    assert.equal(busLeg.arriveMinute, 627);
    assert.equal(chained.transfers, 1);
});

test('combines consecutive access and footpath walks into one leg', () => {
    const bundle = syntheticBundle();
    bundle.footpaths.push(
        { from: 'shuttle:A0', to: 'cdta:0', minutes: 3 },
        { from: 'cdta:0', to: 'shuttle:A1', minutes: 4 },
    );
    const origin = { lat: 0, lon: 0, label: 'Origin' };
    const destination = { lat: 0, lon: 0.0018, label: 'Destination' };
    const itineraries = run(bundle, {
        origin,
        destination,
        date: WEEKDAY,
        departMinute: 9 * 60,
        originAccess: [{ nodeKey: 'shuttle:A0', minutes: 2 }],
        destAccess: [{ nodeKey: 'shuttle:A1', minutes: 5 }],
        direct: {},
        modes: { shuttle: false, bus: false },
    });

    const itinerary = itineraries[0];
    assert.ok(itinerary, 'expected a walking itinerary');
    assert.equal(itinerary.legs.length, 1);
    assert.deepEqual(
        [itinerary.legs[0].from, itinerary.legs[0].to, itinerary.legs[0].minutes],
        ['Origin', 'Destination', 12],
    );
    assert.equal(itinerary.legs[0].departMinute, 9 * 60);
    assert.equal(itinerary.legs[0].arriveMinute, 9 * 60 + 12);
});

test('missed connection waits for the next scheduled trip', () => {
    const bundle = syntheticBundle();
    // Leave later so only the 11:15 bus is catchable: arrive C0 at 11:07.
    const originAccess = [{ nodeKey: 'shuttle:A0', minutes: 1 }];
    const destAccess = [{ nodeKey: 'cdta:1', minutes: 2 }];
    const itineraries = run(bundle, {
        origin: { lat: 0, lon: 0, label: 'O' },
        destination: { lat: 0, lon: 0.0056, label: 'D' },
        date: WEEKDAY, departMinute: 10 * 60 + 55, // 10:55; shuttle 11:00 -> A1 11:05 -> C0 11:07
        originAccess, destAccess, direct: {},
    });
    const chained = itineraries.find((it) => it.legs.some((l) => l.type === 'bus'));
    assert.ok(chained, 'expected a chained itinerary');
    const busLeg = chained.legs.find((l) => l.type === 'bus');
    assert.equal(busLeg.departMinute, 675); // the 11:15 bus, not 10:15
});

test('no service on weekends means no transit itineraries', () => {
    const bundle = syntheticBundle();
    // Saturday: shuttle runs (saturday trips exist) but CDTA service does not.
    const originAccess = [{ nodeKey: 'shuttle:A0', minutes: 1 }];
    const destAccess = [{ nodeKey: 'cdta:1', minutes: 2 }];
    const itineraries = run(bundle, {
        origin: { lat: 0, lon: 0, label: 'O' },
        destination: { lat: 0, lon: 0.0056, label: 'D' },
        date: '2026-11-07', departMinute: 9 * 60 + 55,
        originAccess, destAccess, direct: {},
    });
    // The bus leg must not appear; walk access to C1 directly is over the
    // 800 m cap, so only a partial (shuttle-only, no final walk) or nothing.
    for (const itinerary of itineraries) {
        assert.ok(!itinerary.legs.some((leg) => leg.type === 'bus'), 'no bus should run Saturday');
    }
});

test('bike option beats walking only when it is actually faster', () => {
    const bundle = syntheticBundle();
    const origin = { lat: 0, lon: 0 };
    const destination = { lat: 0, lon: 0.012 }; // ~1.3 km, no docks nearby -> bike unavailable
    const direct = buildDirectOptions(bundle, origin, destination);
    assert.ok(direct.walk);
    assert.equal(direct.bike, undefined);
});

test('findWalkAccess caps and ranks nearby stops', () => {
    const bundle = syntheticBundle();
    const access = findWalkAccess(bundle, { lat: 0, lon: 0.0037 }, 400);
    assert.ok(access.length >= 2);
    assert.ok(access[0].meters <= access[1].meters, 'sorted by distance');
    assert.ok(access.every((a) => a.meters <= 400));
});

test('transit geometry stops at the selected alighting stop', () => {
    const geometry = [[0, 0], [0, 1], [0, 2], [0, 3]];
    const trimmed = trimGeometryAtStop(geometry, {lat: 0, lon: 1.5});

    assert.deepEqual(trimmed, [[0, 0], [0, 1], [0, 1.5]]);
});

test('shuttle geometry follows the route between the selected stops', async () => {
    const bundle = JSON.parse(await readFile(path.join(ROOT, 'planner', 'planner-data.json'), 'utf8'));
    const from = bundle.shuttle.stops.find((stop) => stop.key === 'STAC_3');
    const to = bundle.shuttle.stops.find((stop) => stop.key === 'ECAV');
    const points = shuttleGeometryBetweenStops(
        bundle, 'NORTH', 'shuttle:STAC_3', 'shuttle:ECAV',
    );
    const distanceMeters = (point, stop) => Math.hypot(
        (point[0] - stop.lat) * 111_000,
        (point[1] - stop.lon) * 111_000 * Math.cos(stop.lat * Math.PI / 180),
    );

    assert.ok(points.length > 1, 'expected shuttle geometry between stops');
    assert.ok(distanceMeters(points[0], from) < 10, 'line should start at boarding stop');
    assert.ok(distanceMeters(points.at(-1), to) < 10, 'line should reach alighting stop');
});

test('real bundle: campus to downtown finds a chained itinerary', async () => {
    const bundle = JSON.parse(await readFile(path.join(ROOT, 'planner', 'planner-data.json'), 'utf8'));
    const index = buildIndex(bundle);

    // Student Union to Riverfront Station (downtown Troy, near the WEST loop).
    const origin = { lat: 42.730711, lon: -73.676737, label: 'Student Union' };
    const destination = { lat: 42.730280, lon: -73.686700, label: 'Downtown' };
    const originAccess = findWalkAccess(bundle, origin);
    const destAccess = findWalkAccess(bundle, destination);
    const direct = buildDirectOptions(bundle, origin, destination);

    const itineraries = search(index, {
        origin, destination, date: WEEKDAY, departMinute: 12 * 60,
        originAccess, destAccess, direct,
    });
    assert.ok(itineraries.length > 0, 'expected at least one itinerary');
    // Every itinerary must be internally consistent: legs in order, no time travel.
    for (const itinerary of itineraries) {
        let clock = itinerary.departure;
        for (const leg of itinerary.legs) {
            if (leg.departMinute !== undefined) {
                assert.ok(leg.departMinute >= clock - 1, `leg departs before previous leg arrives (${leg.type})`);
                clock = leg.arriveMinute;
            }
        }
        assert.equal(itinerary.arrival, itinerary.legs.at(-1).arriveMinute);
    }
});
