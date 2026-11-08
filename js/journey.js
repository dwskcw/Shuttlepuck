// Multimodal journey search: walk + RPI shuttle + CDTA bus (+ CDPHP bike).
//
// The algorithm is a small RAPTOR-style search (round = ride one more
// vehicle). It is the standard schedule-aware transit algorithm because it is
// both correct (respects wait times) and easy to explain:
//
//   seed:    walking from the origin reaches nearby stops at depart+walk time
//   round r: board the earliest catchable trip at every stop reached so far,
//            ride it downstream, then relax short stop-to-stop footpaths
//
// Each round produces one itinerary option ("with up to r vehicles"), so the
// UI can show a walk-only option next to a one-shuttle option next to a
// shuttle+bus chain, sorted by arrival time. Riding always boards the
// earliest possible trip of a pattern — waiting for a later trip of the same
// pattern can never beat it.
//
// This module is pure: no DOM, no fetch. The caller supplies access walks
// (how to get from the clicked origin/destination to nearby stops) and gets
// back plain itinerary objects to render.

import { previousDate, serviceRuns, shuttleDayType } from './time.js';

const MAX_ROUNDS = 3;           // rounds = max vehicles used (walk → bus → shuttle)
const MAX_CANDIDATE_TRIPS = 40; // per pattern, safety cap when scanning departures
const WALK_M_PER_MIN = 75;      // ~4.5 km/h street walking (estimates only)
const BIKE_M_PER_MIN = 200;     // ~12 km/h riding speed for dock-to-dock estimates
const DOCK_ACCESS_M = 600;      // max walk to grab/leave a shared bike
const STREET_FACTOR = 1.45;     // straight-line distance underestimates street walks
const MAX_DIRECT_WALK_M = 2000; // offer the plain-walk option only under this (street m)

// --------------------------------------------------------------- index
// Preprocesses the bundle into the maps the search needs. Built once per page
// load and reused across searches as the user changes time/destination.
export function buildIndex(bundle) {
    const nodes = new Map();          // nodeKey -> {kind, label, lat, lon}
    for (const stop of bundle.shuttle.stops) {
        nodes.set(`shuttle:${stop.key}`, { kind: 'shuttle', label: stop.name, lat: stop.lat, lon: stop.lon });
    }
    bundle.cdta.stops.forEach((stop, i) => {
        nodes.set(`cdta:${i}`, { kind: 'cdta', label: stop[1], lat: stop[2], lon: stop[3] });
    });

    // Footpaths in lookup direction: from -> [{to, minutes}].
    const footpaths = new Map();
    for (const path of bundle.footpaths) {
        let list = footpaths.get(path.from);
        if (!list) {
            list = [];
            footpaths.set(path.from, list);
        }
        list.push({ to: path.to, minutes: path.minutes });
    }

    // Shuttle departures per stop per day type: {route, dep} sorted by dep.
    // dep is minutes since the service day's midnight; the stop's route offset
    // turns a bus's Student Union start time into this stop's time.
    const shuttleDeps = new Map();
    for (const stop of bundle.shuttle.stops) {
        const byDayType = { weekday: [], saturday: [], sunday: [] };
        for (const [dayType, trips] of Object.entries(bundle.shuttle.trips)) {
            for (const trip of trips) {
                const offset = stop.offsets[trip.route];
                if (offset === undefined) continue; // route does not serve this stop
                byDayType[dayType].push({ route: trip.route, dep: trip.start + offset });
            }
        }
        for (const list of Object.values(byDayType)) list.sort((a, b) => a.dep - b.dep);
        shuttleDeps.set(stop.key, byDayType);
    }

    // CDTA patterns touching each stop: {patternIdx, pos, offset}.
    const patternsByStop = new Map();
    bundle.cdta.patterns.forEach((pattern, patternIdx) => {
        pattern.stops.forEach((stopIdx, pos) => {
            const list = patternsByStop.get(stopIdx) ?? [];
            list.push({ patternIdx, pos, offset: pattern.offsets[pos] });
            patternsByStop.set(stopIdx, list);
        });
    });

    return { nodes, footpaths, shuttleDeps, patternsByStop, bundle };
}

// --------------------------------------------------------------- access
// Stops within walking distance of a point, estimated from straight-line
// distance. The UI replaces `minutes` with real Mapbox walking times for the
// best candidates before searching; estimates are the offline fallback.
export function findWalkAccess(bundle, point, maxMeters) {
    const limit = maxMeters ?? 800;
    const candidates = [];
    for (const stop of bundle.shuttle.stops) {
        candidates.push({
            nodeKey: `shuttle:${stop.key}`,
            meters: haversineMeters(point, [stop.lat, stop.lon]),
        });
    }
    bundle.cdta.stops.forEach((stop, i) => {
        candidates.push({
            nodeKey: `cdta:${i}`,
            meters: haversineMeters(point, [stop[2], stop[3]]),
        });
    });
    return candidates
        .filter((c) => c.meters <= limit)
        .map((c) => ({ ...c, minutes: Math.max(1, Math.round(c.meters * STREET_FACTOR / WALK_M_PER_MIN)) }))
        .sort((a, b) => a.meters - b.meters);
}

// Direct (no transit) options between two points: a plain walk and/or a
// dock-to-dock CDPHP bike ride. `walkOverride` lets the UI inject a
// Mapbox-measured walk {minutes, meters} instead of the estimate.
export function findNearestBikeDocks(bundle, origin, destination) {
    const nearestDock = (point) => {
        let best = null;
        for (const [index, dock] of bundle.docks.entries()) {
            const meters = haversineMeters(point, [dock.lat, dock.lon]);
            if (meters <= DOCK_ACCESS_M && (!best || meters < best.meters)) {
                best = { index, meters };
            }
        }
        return best;
    };
    return { origin: nearestDock(origin), destination: nearestDock(destination) };
}

export function buildDirectOptions(bundle, origin, destination, walkOverride, bikeAccess) {
    const options = {};

    const straightM = haversineMeters(origin, destination);
    const walkMeters = walkOverride?.meters ?? Math.round(straightM * STREET_FACTOR);
    // A real walking route is authoritative, even beyond the offline
    // straight-line threshold. Keep the threshold only for estimates.
    if (walkOverride || walkMeters <= MAX_DIRECT_WALK_M) {
        options.walk = {
            mode: 'walk',
            minutes: walkOverride?.minutes ?? Math.max(1, Math.round(walkMeters / WALK_M_PER_MIN)),
            meters: walkMeters,
	    geometry: walkOverride?.geometry,
        };
    }

    // Bike: walk to nearest dock, ride to dock nearest the destination, walk on.
    const { origin: dockA, destination: dockB } = findNearestBikeDocks(bundle, origin, destination);
    if (dockA && dockB) {
        const dockAxy = bundle.docks[dockA.index];
        const dockBxy = bundle.docks[dockB.index];
        const rideMeters = haversineMeters([dockAxy.lat, dockAxy.lon], [dockBxy.lat, dockBxy.lon]);
        const originWalk = bikeAccess?.origin ?? {
            meters: dockA.meters,
            minutes: Math.max(1, Math.round(dockA.meters * STREET_FACTOR / WALK_M_PER_MIN)),
        };
        const destinationWalk = bikeAccess?.destination ?? {
            meters: dockB.meters,
            minutes: Math.max(1, Math.round(dockB.meters * STREET_FACTOR / WALK_M_PER_MIN)),
        };
        const minutes = originWalk.minutes + 1 +
            Math.max(1, Math.round(rideMeters / BIKE_M_PER_MIN)) + 1 +
            destinationWalk.minutes;
        // A bike that is slower than walking is noise, not an option.
        if (!options.walk || minutes < options.walk.minutes) {
            options.bike = {
                mode: 'bike',
                minutes,
                meters: Math.round(originWalk.meters + rideMeters + destinationWalk.meters),
                docks: [dockA.index, dockB.index],
            };
        }
    }
    return options;
}

// --------------------------------------------------------------- departures
// Earliest CDTA trip of `pattern` departing at stop position `pos` at or after
// `fromMinute`, scanning today's service day and (for trips past midnight)
// yesterday's. Returns {dep, tripStart} or null.
function earliestCdtaTrip(bundle, pattern, offset, date, fromMinute) {
    const yesterday = previousDate(date);
    const trips = pattern.trips; // sorted by tripStart
    let best = null;

    // Binary search the first trip that departs late enough, then check the
    // service calendar; if that trip is not running today, later ones of the
    // same pattern are not necessarily skipped, so step forward a few.
    const scan = (serviceDate, minStart, dayShift) => {
        let lo = 0, hi = trips.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (trips[mid][1] < minStart) lo = mid + 1; else hi = mid;
        }
        for (let i = lo; i < trips.length && i - lo < MAX_CANDIDATE_TRIPS; i++) {
            const [serviceIdx, tripStart] = trips[i];
            if (!serviceRuns(bundle.cdta.services, bundle.cdta.exceptions, serviceIdx, serviceDate)) continue;
            const dep = tripStart + offset - dayShift * 1440;
            if (!best || dep < best.dep) best = { dep, tripStart };
            break; // first running trip of this scan is its earliest departure
        }
    };

    scan(date, fromMinute - offset, 0);              // today's service day
    scan(yesterday, fromMinute + 1440 - offset, 1);  // yesterday's past-midnight trips
    return best;
}

// Earliest shuttle boarding per route at a stop at/after fromMinute. A stop
// can be served by both loops, and the fastest overall departure is not always
// the best ride, so return one boarding per route.
function shuttleBoardings(index, stopKey, date, fromMinute) {
    const byDayType = index.shuttleDeps.get(stopKey);
    if (!byDayType) return [];
    const yesterday = previousDate(date);
    const boardings = [];
    const boardedRoutes = new Set();

    const scan = (dayType, dayShift) => {
        for (const { route, dep } of byDayType[dayType]) {
            const adjusted = dep - dayShift * 1440; // yesterday's late trips
            if (adjusted < fromMinute || boardedRoutes.has(route)) continue;
            boardedRoutes.add(route);
            boardings.push({ route, dep: adjusted });
        }
    };

    scan(shuttleDayType(date), 0);
    scan(shuttleDayType(yesterday), 1);
    return boardings;
}

// --------------------------------------------------------------- search
// origin/destination: {lat, lon, label}
// originAccess/destAccess: [{nodeKey, minutes}] from findWalkAccess (upgraded
//   with Mapbox times by the UI when available)
// direct: {walk?, bike?} from buildDirectOptions
// Returns [{legs, departure, arrival, transfers}] sorted by arrival time.
export function search(index, {
    origin, destination, date, departMinute, originAccess, destAccess, direct = {},
    modes = {},
}) {
    const allowWalk = true;
    const allowBike = modes.bike !== false;
    const allowShuttle = modes.shuttle !== false;
    const allowBus = modes.bus !== false;
    const destAccessMin = new Map(destAccess.map((a) => [a.nodeKey, a.minutes]));

    // bestArrival: nodeKey -> earliest known arrival minute.
    const bestArrival = new Map();
    // parents: nodeKey -> how we got there:
    //   {from: nodeKey|null, via: {type:'walk', minutes} |
    //                         {type:'ride', kind, departMinute, arriveMinute, ...}}
    // via.arriveMinute is stored for rides so reconstruction needs no lookup.
    const parents = new Map();
    // newlyReached: stops improved this round — the only ones whose footpaths
    // still need relaxing.
    let newlyReached = new Map();

    const improve = (nodeKey, minute, parent) => {
        const known = bestArrival.get(nodeKey);
        if (known !== undefined && known <= minute) return;
        bestArrival.set(nodeKey, minute);
        parents.set(nodeKey, parent);
        newlyReached.set(nodeKey, minute);
    };

    // Seed: walking from the origin to nearby stops.
    if (allowWalk) {
        for (const access of originAccess) {
            improve(access.nodeKey, departMinute + access.minutes, {
                from: null, via: { type: 'walk', minutes: access.minutes },
            });
        }
    }

    // Per-round best arrival at the destination (see snapshot loop below).
    const rounds = [];

    for (let round = 1; round <= MAX_ROUNDS; round++) {
        // --- ride phase: board at every stop reached so far ---
        for (const [stopKey, arrivalMin] of [...bestArrival]) {
            if (stopKey.startsWith('shuttle:') && allowShuttle) {
                rideShuttle(index, stopKey, arrivalMin, date, improve);
            } else if (stopKey.startsWith('cdta:') && allowBus) {
                rideCdta(index, stopKey, arrivalMin, date, improve);
            }
        }

        // --- footpath phase: spread this round's new arrivals across short
        // stop-to-stop walks; they become boardable next round ---
        const spreadFrom = [...newlyReached.entries()];
        newlyReached = new Map();
        if (allowWalk) {
            for (const [stopKey, arrivalMin] of spreadFrom) {
                for (const path of index.footpaths.get(stopKey) ?? []) {
                    improve(path.to, arrivalMin + path.minutes, {
                        from: stopKey, via: { type: 'walk', minutes: path.minutes },
                    });
                }
            }
        }

        // --- destination check: final walk from any reached stop ---
        // (Runs on the full bestArrival because footpaths from earlier rounds
        // may still beat this round's rides.)
        let bestArrivalAtDest = allowWalk && direct.walk
            ? departMinute + direct.walk.minutes : Infinity;
        let arrivalAt = allowWalk && direct.walk ? { direct: 'walk' } : null;
        if (allowWalk) {
            for (const [stopKey, arrivalMin] of bestArrival) {
                const walkMin = destAccessMin.get(stopKey);
                if (walkMin === undefined) continue;
                if (arrivalMin + walkMin < bestArrivalAtDest) {
                    bestArrivalAtDest = arrivalMin + walkMin;
                    arrivalAt = { stopKey, walkMin };
                }
            }
        }
        if (allowBike && direct.bike && departMinute + direct.bike.minutes < bestArrivalAtDest) {
            bestArrivalAtDest = departMinute + direct.bike.minutes;
            arrivalAt = { direct: 'bike' };
        }
        rounds.push({ arrival: bestArrivalAtDest, arrivalAt });
    }

    // --- reconstruct one option per round, drop duplicates, sort by arrival ---
    const itineraries = [];
    const seen = new Set();
    for (const roundResult of rounds) {
        if (!Number.isFinite(roundResult.arrival)) continue;
        const legs = reconstruct(index, roundResult, parents, {
            origin, destination, departMinute, direct, destAccessMin,
            allowWalk,
        });
        const signature = JSON.stringify(legs.map((leg) => [leg.type, leg.fromNode ?? leg.from, leg.toNode ?? leg.to, leg.departMinute]));
        if (seen.has(signature)) continue;
        seen.add(signature);
        itineraries.push({
            legs,
            departure: legs[0].departMinute ?? departMinute,
            arrival: roundResult.arrival,
            transfers: Math.max(0,
                legs.filter((leg) => leg.type === 'shuttle' || leg.type === 'bus').length - 1),
        });
    }
    itineraries.sort((a, b) => a.arrival - b.arrival);
    return itineraries;
}

// Ride phase for one shuttle stop: board the earliest departure of each route
// serving this stop and mark arrivals at every later stop on that loop.
// stopKey arrives in prefixed form ("shuttle:A0"); lookups use the raw key.
function rideShuttle(index, stopKey, arrivalMin, date, improve) {
    const { bundle } = index;
    const rawKey = stopKey.slice('shuttle:'.length);
    const stop = bundle.shuttle.stops.find((s) => s.key === rawKey);
    if (!stop) return;

    for (const boarding of shuttleBoardings(index, rawKey, date, arrivalMin)) {
        const routeStops = bundle.shuttle.stops
            .filter((s) => s.offsets[boarding.route] !== undefined)
            .sort((a, b) => a.offsets[boarding.route] - b.offsets[boarding.route]);
        const myOffset = stop.offsets[boarding.route];
        for (const later of routeStops) {
            if (later.offsets[boarding.route] <= myOffset) continue; // strictly downstream
            const arrive = boarding.dep + (later.offsets[boarding.route] - myOffset);
            improve(`shuttle:${later.key}`, arrive, {
                from: stopKey,
                via: {
                    type: 'ride', kind: 'shuttle', route: boarding.route,
                    fromNode: stopKey, toNode: `shuttle:${later.key}`,
                    departMinute: boarding.dep, arriveMinute: arrive,
                },
            });
        }
    }
}

// Ride phase for one CDTA stop: for every pattern through this stop, board the
// earliest running trip and ride it downstream.
function rideCdta(index, stopIdxKey, arrivalMin, date, improve) {
    const stopIdx = Number(stopIdxKey.split(':')[1]);
    const entries = index.patternsByStop.get(stopIdx) ?? [];
    for (const { patternIdx, pos, offset } of entries) {
        const pattern = index.bundle.cdta.patterns[patternIdx];
        const trip = earliestCdtaTrip(index.bundle, pattern, offset, date, arrivalMin);
        if (!trip) continue;
        for (let q = pos + 1; q < pattern.stops.length; q++) {
            const arrive = trip.dep + (pattern.offsets[q] - offset);
            improve(`cdta:${pattern.stops[q]}`, arrive, {
                from: stopIdxKey,
                via: {
                    type: 'ride', kind: 'cdta', patternIdx,
                    boardPos: pos, alightPos: q,
                    fromNode: stopIdxKey, toNode: `cdta:${pattern.stops[q]}`,
                    departMinute: trip.dep, arriveMinute: arrive,
                },
            });
        }
    }
}

// --------------------------------------------------------------- itinerary
// Walk the parent chain from the arrival stop back to the origin, then emit
// legs in forward order. Walk times accumulate forward; ride times come from
// the stored via (exact, since the search knew the trip it boarded).
function reconstruct(index, roundResult, parents, {
    origin, destination, departMinute, direct, destAccessMin, allowWalk = true,
}) {
    const nodes = index.nodes;

    // Pure walk or bike itinerary: a single leg, no stops involved.
    if (roundResult.arrivalAt?.direct) {
        const mode = roundResult.arrivalAt.direct;
        const option = direct[mode];
        return [{
            type: mode,
            from: origin.label ?? 'Origin',
            to: destination.label ?? 'Destination',
            minutes: option.minutes,
            meters: option.meters,
	    geometry: option.geometry,
            departMinute,
            arriveMinute: departMinute + option.minutes,
            docks: option.docks,
            geometry: option.geometry,
            fromPoint: { lat: origin.lat, lon: origin.lon },
            toPoint: { lat: destination.lat, lon: destination.lon },
        }];
    }

    // Collect hops backwards: [{nodeKey (arrived at), parent}].
    const hops = [];
    let cursor = roundResult.arrivalAt.stopKey;
    while (cursor) {
        const parent = parents.get(cursor);
        if (!parent) break;
        hops.push({ nodeKey: cursor, parent });
        cursor = parent.from; // null on the seed hop stops the loop next pass
    }
    hops.reverse();

    const legs = [];
    let clock = departMinute;
    for (const hop of hops) {
        const via = hop.parent.via;
        if (via.type === 'walk') {
            const isSeed = hop.parent.from === null;
            const fromLabel = isSeed
                ? (origin.label ?? 'Origin')
                : (nodes.get(hop.parent.from)?.label ?? hop.parent.from);
            const fromPoint = isSeed
                ? { lat: origin.lat, lon: origin.lon }
                : nodes.get(hop.parent.from);
            const toPoint = nodes.get(hop.nodeKey);
            legs.push({
                type: 'walk',
                from: fromLabel,
                to: nodes.get(hop.nodeKey)?.label ?? hop.nodeKey,
                minutes: via.minutes,
                departMinute: clock,
                arriveMinute: clock + via.minutes,
                fromPoint,
                toPoint,
            });
            clock += via.minutes;
        } else { // ride
            legs.push(rideLeg(index, via));
            clock = via.arriveMinute;
        }
    }

    // Final walk from the last stop to the destination.
    const lastStopKey = roundResult.arrivalAt.stopKey;
    const finalWalk = allowWalk ? destAccessMin.get(lastStopKey) : undefined;
    if (finalWalk !== undefined && Number.isFinite(finalWalk)) {
        const fromPoint = nodes.get(lastStopKey);
        legs.push({
            type: 'walk',
            from: nodes.get(lastStopKey)?.label ?? lastStopKey,
            to: destination.label ?? 'Destination',
            minutes: finalWalk,
            departMinute: clock,
            arriveMinute: clock + finalWalk,
            fromPoint,
            toPoint: { lat: destination.lat, lon: destination.lon },
        });
    }
    return legs;
}

// Build one transit leg descriptor from a ride via pointer.
function rideLeg(index, via) {
    const from = index.nodes.get(via.fromNode)?.label ?? via.fromNode;
    const to = index.nodes.get(via.toNode)?.label ?? via.toNode;
    if (via.kind === 'shuttle') {
        const route = index.bundle.shuttle.routes[via.route];
        return {
            type: 'shuttle',
            route: via.route,
            routeName: route?.name ?? via.route,
            color: route?.color ?? '#c04040',
            headsign: route?.name ?? via.route,
            from,
            to,
            fromNode: via.fromNode,
            toNode: via.toNode,
            departMinute: via.departMinute,
            arriveMinute: via.arriveMinute,
        };
    }
    const pattern = index.bundle.cdta.patterns[via.patternIdx];
    const route = index.bundle.cdta.routes[pattern.route];
    return {
        type: 'bus',
        routeShort: route.short,
        routeName: route.name,
        color: `#${route.color}`,
        headsign: pattern.headsign,
        from,
        to,
        fromNode: via.fromNode,
        toNode: via.toNode,
        departMinute: via.departMinute,
        arriveMinute: via.arriveMinute,
        stops: via.alightPos - via.boardPos,
    };
}

function haversineMeters(a, b) {
    const [lat1, lon1] = Array.isArray(a) ? a : [a.lat, a.lon];
    const [lat2, lon2] = Array.isArray(b) ? b : [b.lat, b.lon];
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
