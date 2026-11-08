// Tests for planner/build-planner-data.mjs helpers and the generated bundle.
//
//   node --test
//
// The bundle test reads planner/planner-data.json, which must exist first
// (run `node planner/build-planner-data.mjs` to regenerate it).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { haversineMeters, parseClock12 } from './build-planner-data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('parseClock12 reads the shuttle schedule format', () => {
    assert.equal(parseClock12('7:05 PM'), 19 * 60 + 5);
    assert.equal(parseClock12('12:30 AM'), 30);        // 12 AM is midnight hour
    assert.equal(parseClock12('12:00 PM'), 12 * 60);   // 12 PM is noon
    assert.equal(parseClock12(' 9:00 AM '), 9 * 60);   // tolerant of stray spaces
    assert.throws(() => parseClock12('25:00'), /Unreadable shuttle time/);
});

test('haversineMeters gives plausible Troy distances', () => {
    // Student Union to City Station is roughly 900 m as the crow flies.
    const studentUnion = [42.730711, -73.676737];
    const cityStation = [42.727673, -73.687228];
    const meters = haversineMeters(studentUnion, cityStation);
    assert.ok(meters > 700 && meters < 1100, `expected ~900 m, got ${meters}`);
    assert.equal(haversineMeters(studentUnion, studentUnion), 0);
});

test('generated bundle is complete and internally consistent', async () => {
    const bundle = JSON.parse(await readFile(path.join(ROOT, 'planner', 'planner-data.json'), 'utf8'));

    // Shuttle: every stop has coordinates and at least one route offset.
    assert.ok(bundle.shuttle.stops.length >= 15, 'expected the full shuttle stop list');
    for (const stop of bundle.shuttle.stops) {
        assert.ok(Number.isFinite(stop.lat) && Number.isFinite(stop.lon), `${stop.key} missing coords`);
        assert.ok(Object.keys(stop.offsets).length > 0, `${stop.key} has no route offsets`);
    }

    // Shuttle trips: sorted by start minute, all on known routes.
    for (const [dayType, trips] of Object.entries(bundle.shuttle.trips)) {
        assert.ok(['weekday', 'saturday', 'sunday'].includes(dayType));
        for (let i = 1; i < trips.length; i++) {
            assert.ok(trips[i].start >= trips[i - 1].start, `${dayType} trips not sorted`);
        }
        for (const trip of trips) {
            assert.ok(bundle.shuttle.routes[trip.route], `unknown route ${trip.route}`);
        }
    }

    // CDTA: patterns reference real stops/routes and have sorted trips.
    assert.ok(bundle.cdta.patterns.length > 250);
    const stopCount = bundle.cdta.stops.length;
    for (const pattern of bundle.cdta.patterns) {
        assert.ok(pattern.stops.length >= 2, 'pattern with fewer than 2 stops');
        assert.ok(pattern.offsets.length === pattern.stops.length);
        for (const stopIdx of pattern.stops) {
            assert.ok(stopIdx >= 0 && stopIdx < stopCount, 'pattern references missing stop');
        }
        assert.ok(pattern.trips.length > 0, 'pattern without trips');
        for (let i = 1; i < pattern.trips.length; i++) {
            assert.ok(pattern.trips[i][1] >= pattern.trips[i - 1][1], 'pattern trips not sorted');
        }
        // Offsets must start at zero (first stop defines the trip start).
        assert.equal(pattern.offsets[0], 0);
    }

    // Footpaths are stored in both directions and carry sane values.
    assert.ok(bundle.footpaths.length > 0);
    assert.equal(bundle.footpaths.length % 2, 0, 'footpaths should come in both directions');
    for (const path of bundle.footpaths) {
        assert.ok(path.meters >= 0 && path.minutes >= 1);
        assert.ok(path.meters <= 250, 'footpath exceeds the transfer walk limit');
    }

    // Bike docks parsed from the geojson.
    assert.ok(bundle.docks.length >= 15);
    for (const dock of bundle.docks) {
        assert.ok(Number.isFinite(dock.lat) && Number.isFinite(dock.lon));
    }
});
