// Directions panel: set origin/destination by clicking the map, pick a
// departure time, and render multimodal itineraries produced by journey.js.
//
// Interaction model:
//   - "Set origin" / "Set destination" buttons arm a click-catcher; the next
//     map click drops a draggable marker.
//   - Searching needs the planner bundle (fetch + buildIndex once) and, when
//     Mapbox is configured, real walking times from the Directions Matrix API
//     for the ~8 nearest stops to each endpoint (fall back to estimates).
//   - Chosen itineraries draw on the map: transit legs colored by their route,
//     walks as dashed grey, plus board/alight markers.

import {
    LayerGroup, Marker, DivIcon, Polyline, CircleMarker,
} from 'leaflet';
import {
    buildIndex, search, findWalkAccess, buildDirectOptions, findNearestBikeDocks,
} from './journey.js';
import { troyNow, formatClock } from './time.js';

const ACCESS_CANDIDATES = 8;   // stops upgraded with real Mapbox walk times
const ACCESS_RADIUS_M = 800;   // search radius around a clicked point
const ACCESS_DEFAULT_MIN = 1;  // fallback walk minutes when Mapbox is unavailable
const BUNDLE_TIMEOUT_MS = 15_000; // schedule bundle fetch deadline
const MAPBOX_PROFILE = 'mapbox/walking';
const MAPBOX_TRANSIT_PROFILE = 'mapbox/driving';
const MAPBOX_CYCLING_PROFILE = 'mapbox/cycling';

// --------------------------------------------------------------- state
const state = {
    bundle: null,        // planner-data.json, loaded once
    bundleError: null,   // set when the bundle failed to load
    loadingBundle: false, // a bundle fetch is in flight
    index: null,         // buildIndex(bundle), built once
    mapboxToken: null,   // from map.js config
    active: false,       // panel open?
    armed: null,         // 'origin' | 'destination' while awaiting a map click
    searching: false,    // a search request is in flight
    origin: null,        // {lat, lon, label}
    destination: null,   // {lat, lon, label}
    markers: { origin: null, destination: null },
    resultLayers: new LayerGroup(),
    walkRoutes: new Map(),
    transitRoutes: new Map(),
    drawVersion: 0,
    map: null,           // injected by initJourneyUi
    apiBase: '',         // same-origin or absolute, from map.js
};

function $(id) {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Trip planner element "#${id}" is missing from the page.`);
    return element;
}

function describeError(error) {
    return error instanceof Error && error.message
        ? error.message
        : String(error ?? 'Unknown error');
}

// --------------------------------------------------------------- init
export function initJourneyUi({ map, apiBase, mapboxToken }) {
    const requiredIds = [
        'journey-open', 'journey-close', 'journey-retry',
        'journey-set-origin', 'journey-set-destination', 'journey-search',
        'journey-when', 'journey-date', 'journey-panel', 'journey-hint',
        'journey-results', 'journey-mode-walk', 'journey-mode-bike',
        'journey-mode-shuttle', 'journey-mode-bus',
    ];
    const missingIds = requiredIds.filter((id) => !document.getElementById(id));
    if (missingIds.length > 0) {
        console.error(`Trip planner cannot start; missing DOM elements: ${missingIds.join(', ')}`);
        return;
    }

    state.map = map;
    state.apiBase = apiBase;
    state.mapboxToken = mapboxToken;

    $('journey-open').addEventListener('click', togglePanel);
    $('journey-close').addEventListener('click', togglePanel);
    $('journey-retry').addEventListener('click', () => {
        state.bundleError = null;
        loadBundleOnce();
    });
    $('journey-set-origin').addEventListener('click', () => armClick('origin'));
    $('journey-set-destination').addEventListener('click', () => armClick('destination'));
    $('journey-search').addEventListener('click', runSearch);
    $('journey-when').addEventListener('change', () => {
        // A manual time change should search again if both ends are set.
        if (state.origin && state.destination) runSearch();
    });
    for (const id of ['journey-mode-walk', 'journey-mode-bike', 'journey-mode-shuttle', 'journey-mode-bus']) {
        $(id).addEventListener('change', () => {
            if (state.origin && state.destination) runSearch();
        });
    }

    map.on('click', onMapClick);
    state.resultLayers.addTo(map);

    // Default the departure input to "right now" in Troy local time.
    const now = troyNow();
    $('journey-when').value = `${String(Math.floor(now.minute / 60)).padStart(2, '0')}:${String(now.minute % 60).padStart(2, '0')}`;
    $('journey-date').value = now.date;

    // Load the 1.2 MB schedule bundle when the map loads, not when the panel
    // is first opened: by the time someone taps Directions it is usually ready.
    loadBundleOnce();
    updateControls();
}

function openPanel() {
    state.active = true;
    $('journey-panel').hidden = false;
    $('journey-open').hidden = true;
    document.body.classList.add('journey-active');
    loadBundleOnce();
}

function closePanel() {
    state.active = false;
    state.armed = null;
    $('journey-panel').hidden = true;
    $('journey-open').hidden = false;
    document.body.classList.remove('journey-active');
    updateControls();
    clearResults();
}

function togglePanel() {
    if (state.active) closePanel();
    else openPanel();
}

async function loadBundleOnce() {
    if (state.bundle || state.loadingBundle) return;
    state.loadingBundle = true;
    state.bundleError = null;
    updateControls();

    // A hung request must not wedge the panel forever: abort after 15 s and
    // offer a retry button. (AbortSignal.timeout is supported in every
    // current browser; the guard keeps older ones functional.)
    const options = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? {signal: AbortSignal.timeout(BUNDLE_TIMEOUT_MS)}
        : {};
    try {
        const bundleUrl = new URL(
            state.apiBase
                ? `${state.apiBase}/planner/planner-data.json`
                : 'planner/planner-data.json',
            document.baseURI,
        );
        const response = await fetch(bundleUrl, options);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        state.bundle = await response.json();
        state.index = buildIndex(state.bundle);
    } catch (error) {
        state.bundleError = error instanceof Error && error.name === 'TimeoutError'
            ? 'timed out' : describeError(error);
    } finally {
        state.loadingBundle = false;
        updateControls();
    }
}

// Reflects the whole input state on the controls, so every dead end is
// visible: which endpoints are set, what is being waited for, and whether
// Find routes can do anything yet.
function updateControls() {
    const originBtn = $('journey-set-origin');
    const destBtn = $('journey-set-destination');
    const searchBtn = $('journey-search');
    const hint = $('journey-hint');

    originBtn.textContent = state.origin ? '✓ Origin set' : '1. Set origin';
    destBtn.textContent = state.destination ? '✓ Destination set' : '2. Set destination';
    originBtn.classList.toggle('set', Boolean(state.origin));
    destBtn.classList.toggle('set', Boolean(state.destination));
    originBtn.classList.toggle('armed', state.armed === 'origin');
    destBtn.classList.toggle('armed', state.armed === 'destination');

    const ready = Boolean(state.bundle && state.origin && state.destination);
    searchBtn.disabled = !ready || state.searching;
    searchBtn.textContent = state.searching ? 'Searching…' : 'Find routes';

    $('journey-retry').hidden = !state.bundleError;

    // Only write the hint when we have something to say; search results
    // manage it themselves.
    if (state.bundleError) {
        hint.textContent = `Could not load transit schedules (${state.bundleError}). ` +
            'Check that the dev server is running, then retry.';
    } else if (!state.bundle) {
        hint.textContent = 'Loading transit schedules…';
    } else if (state.armed) {
        hint.textContent = `Now click the map to place the ${state.armed}.`;
    } else if (!state.origin || !state.destination) {
        hint.textContent = 'Click “Set origin”, then click the map. Repeat for the destination.';
    } else if (!state.searching) {
        hint.textContent = 'Ready — press “Find routes”.';
    }
}

// --------------------------------------------------------------- input
function armClick(which) {
    state.armed = state.armed === which ? null : which; // toggle off on re-click
    updateControls();
}

function onMapClick(event) {
    if (!state.armed) return;
    const which = state.armed;
    state.armed = null;
    const latlng = [event.latlng.lat, event.latlng.lng];
    setEndpoint(which, latlng);
}

function setEndpoint(which, latlng) {
    if (state.markers[which]) {
        state.map.removeLayer(state.markers[which]);
        state.markers[which] = null;
    }
    state[which] = { lat: latlng[0], lon: latlng[1], label: which === 'origin' ? 'Origin' : 'Destination' };
    const marker = new Marker(latlng, {
        draggable: true,
        icon: new DivIcon({
            className: `journey-pin journey-pin-${which}`,
            html: `<div class="journey-pin-dot">${which === 'origin' ? 'A' : 'B'}</div>`,
            iconSize: [26, 26],
            iconAnchor: [13, 13],
        }),
        zIndexOffset: 2000,
    }).addTo(state.map);
    marker.on('dragend', () => {
        const pos = marker.getLatLng();
        state[which] = { lat: pos.lat, lon: pos.lng, label: which === 'origin' ? 'Origin' : 'Destination' };
        if (state.origin && state.destination) runSearch();
    });
    state.markers[which] = marker;

    // Sensible UX default: after the origin is set, arm the destination next.
    if (which === 'origin' && !state.destination) armClick('destination');
    updateControls();
    if (state.origin && state.destination) runSearch();
}

// --------------------------------------------------------------- search
async function runSearch() {
    // Backstop for anything updateControls could not prevent — never silent.
    if (!state.bundle) {
        $('journey-hint').textContent = 'Still loading schedules — try again in a moment.';
        loadBundleOnce();
        return;
    }
    if (!state.origin || !state.destination) {
        $('journey-hint').textContent = 'Set both endpoints first: press “Set origin”, click the map, then “Set destination”.';
        return;
    }

    state.searching = true;
    updateControls();

    try {
        const date = $('journey-date').value || troyNow().date;
        const [hour, minute] = $('journey-when').value.split(':').map(Number);
        const departMinute = (hour || 0) * 60 + (minute || 0);

        // Access walks: estimates first, then upgraded with Mapbox times.
        const originAccess = findWalkAccess(state.bundle, state.origin, ACCESS_RADIUS_M);
        const destAccess = findWalkAccess(state.bundle, state.destination, ACCESS_RADIUS_M);
        const walkOverride = await mapboxWalkOverride(state.origin, state.destination);
        const bikeAccess = await mapboxBikeAccess(state.origin, state.destination);
        const modes = getSelectedModes();
        const direct = buildDirectOptions(
            state.bundle, state.origin, state.destination, walkOverride, bikeAccess,
        );
        if (!modes.bike) delete direct.bike;
        if (direct.bike) {
            direct.bike.geometry = await mapboxBikeGeometry(
                state.origin, state.destination, direct.bike.docks,
            );
        }
        const [upgradedOriginAccess, upgradedDestAccess] = await Promise.all([
            upgradeAccess(originAccess, state.origin),
            upgradeAccess(destAccess, state.destination),
        ]);

        const itineraries = search(state.index, {
            origin: state.origin,
            destination: state.destination,
            date,
            departMinute,
            originAccess: upgradedOriginAccess,
            destAccess: upgradedDestAccess,
            direct,
            modes,
        });

        renderItineraries(itineraries);
        $('journey-hint').textContent = itineraries.length
            ? `${itineraries.length} option${itineraries.length === 1 ? '' : 's'} found`
            : 'No paths found.';
    } catch (error) {
        $('journey-hint').textContent = `Search failed: ${describeError(error)}`;
    } finally {
        state.searching = false;
        updateControls();
    }

    function getSelectedModes() {
        return {
            walk: true,
            bike: $('journey-mode-bike').checked,
            shuttle: $('journey-mode-shuttle').checked,
            bus: $('journey-mode-bus').checked,
        };
    }
}

// Ask Mapbox for a real walking time/distance between the two clicked points.
// Any failure keeps the estimate-based behavior (this is a demo nicety).
async function mapboxWalkOverride(origin, destination) {
    if (!state.mapboxToken) return undefined;
    try {
        const coords = `${origin.lon},${origin.lat};${destination.lon},${destination.lat}`;
        const url = `https://api.mapbox.com/directions/v5/${MAPBOX_PROFILE}/${coords}` +
            `?geometries=geojson&overview=full&access_token=${encodeURIComponent(state.mapboxToken)}`;
        const response = await fetch(url);
        if (!response.ok) return undefined;
        const data = await response.json();
        const route = data.routes?.[0];
        if (!route) return undefined;
        return {
            minutes: Math.max(1, Math.round(route.duration / 60)),
            meters: Math.round(route.distance),
            geometry: route.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
        };
    } catch {
        return undefined;
    }

}

async function mapboxBikeAccess(origin, destination) {
    const docks = findNearestBikeDocks(state.bundle, origin, destination);
    if (!docks.origin || !docks.destination || !state.mapboxToken) return undefined;
    const originDock = state.bundle.docks[docks.origin.index];
    const destinationDock = state.bundle.docks[docks.destination.index];
    const [toOriginDock, fromDestinationDock] = await Promise.all([
        fetchMapboxRoute(origin, originDock),
        fetchMapboxRoute(destinationDock, destination),
    ]);
    if (!toOriginDock || !fromDestinationDock) return undefined;
    return {
        origin: {minutes: toOriginDock.minutes, meters: toOriginDock.meters},
        destination: {minutes: fromDestinationDock.minutes, meters: fromDestinationDock.meters},
    };
}

async function fetchMapboxRoute(from, to) {
    try {
        const coords = `${from.lon},${from.lat};${to.lon},${to.lat}`;
        const url = `https://api.mapbox.com/directions/v5/${MAPBOX_PROFILE}/${coords}` +
            `?overview=false&access_token=${encodeURIComponent(state.mapboxToken)}`;
        const response = await fetch(url);
        if (!response.ok) return undefined;
        const route = (await response.json()).routes?.[0];
        if (!route || !Number.isFinite(route.duration) || !Number.isFinite(route.distance)) {
            return undefined;
        }

        return {
            minutes: Math.max(1, Math.round(route.duration / 60)),
            meters: Math.round(route.distance),
        };
    } catch {
        return undefined;
    }
}

async function fetchMapboxGeometry(from, to, profile, waypoint) {
    try {
        const routePoints = [from, waypoint, to].filter(Boolean);
        const coords = routePoints.map((point) => `${point.lon},${point.lat}`).join(';');
        const url = `https://api.mapbox.com/directions/v5/${profile}/${coords}` +
            `?geometries=geojson&overview=full&access_token=${encodeURIComponent(state.mapboxToken)}`;
        const response = await fetch(url);
        if (!response.ok) return undefined;
        const route = (await response.json()).routes?.[0];
        const geometryPoints = route?.geometry?.coordinates;
        if (!Array.isArray(geometryPoints) || geometryPoints.length < 2) return undefined;
        return geometryPoints
            .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat))
            .map(([lon, lat]) => [lat, lon]);
    } catch {
        return undefined;
    }
}

async function mapboxBikeGeometry(origin, destination, docks) {
    const [originDockIndex, destinationDockIndex] = docks;
    const originDock = state.bundle.docks[originDockIndex];
    const destinationDock = state.bundle.docks[destinationDockIndex];
    if (!originDock || !destinationDock) return undefined;

    const segments = await Promise.all([
        fetchMapboxGeometry(origin, originDock, MAPBOX_PROFILE),
        fetchMapboxGeometry(originDock, destinationDock, MAPBOX_CYCLING_PROFILE),
        fetchMapboxGeometry(destinationDock, destination, MAPBOX_PROFILE),
    ]);
    if (segments.some((segment) => !segment || segment.length < 2)) return undefined;
    return segments.flatMap((segment, index) =>
        index === 0 ? segment : segment.slice(1));
}

// Replace estimated walk minutes for the nearest stops with real Mapbox
// matrix times. Returns a fresh list; falls back to estimates per candidate.
async function upgradeAccess(access, point) {
    if (!state.mapboxToken || access.length === 0) return access;
    const candidates = access.slice(0, ACCESS_CANDIDATES);
    try {
        const coords = [point, ...candidates.map((c) => nodeCoords(state.bundle, c.nodeKey))]
            .map((p) => `${p.lon},${p.lat}`).join(';');
        const url = `https://api.mapbox.com/directions-matrix/v1/${MAPBOX_PROFILE}/${coords}` +
            `?sources=0&destinations=${candidates.map((_, i) => i + 1).join(';')}` +
            `&access_token=${encodeURIComponent(state.mapboxToken)}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`matrix HTTP ${response.status}`);
        const data = await response.json();
        const upgraded = candidates.map((candidate, i) => {
            const seconds = data.durations?.[0]?.[i];
            if (!Number.isFinite(seconds)) return { ...candidate, minutes: Math.max(1, Math.round(candidate.minutes)) };
            return { ...candidate, minutes: Math.max(1, Math.round(seconds / 60)) };
        });
        // Keep the rest (beyond the first ACCESS_CANDIDATES) with estimates.
        return [...upgraded, ...access.slice(ACCESS_CANDIDATES)];
    } catch {
        return access; // estimates are fine
    }
}

function nodeCoords(bundle, nodeKey) {
    const [kind, id] = nodeKey.split(':');
    if (kind === 'shuttle') {
        const stop = bundle.shuttle.stops.find((s) => s.key === id);
        return { lat: stop.lat, lon: stop.lon };
    }
    const stop = bundle.cdta.stops[Number(id)];
    return { lat: stop[2], lon: stop[3] };
}

// --------------------------------------------------------------- rendering
function renderItineraries(itineraries) {
    clearResults();
    const list = $('journey-results');
    list.replaceChildren();

    if (itineraries.length === 0) {
        selectItineraryOverlays({legs: []});
        const empty = document.createElement('p');
        empty.className = 'journey-empty';
        empty.textContent = 'No paths found.';
        list.append(empty);
        return;
    }

    itineraries.forEach((itinerary, index) => {
        const card = document.createElement('article');
        card.className = 'journey-option';

        const header = document.createElement('button');
        header.type = 'button';
        header.className = 'journey-option-head';
        const badges = itinerary.legs.map((leg) => {
            if (leg.type === 'walk') return '🚶';
            if (leg.type === 'bike') return '🚲';
            if (leg.type === 'shuttle') return `<span class="journey-chip" style="background:${leg.color}">Shuttle</span>`;
            return `<span class="journey-chip" style="background:${leg.color}">${escapeHtml(leg.routeShort)}</span>`;
        }).join('<span class="journey-arrow">›</span>');
        header.innerHTML = `
            <span class="journey-time">${formatClock(itinerary.departure)} – ${formatClock(itinerary.arrival)}</span>
            <span class="journey-badges">${badges}</span>
            <span class="journey-total">${formatClock(itinerary.departure)} departure</span>`;
        header.addEventListener('click', () => {
            selectItineraryOverlays(itinerary);
            drawItinerary(itinerary);
            for (const sibling of list.children) sibling.classList.remove('selected');
            card.classList.add('selected');
        });
        card.append(header);

        // Leg-by-leg detail, always visible (it is short).
        const detail = document.createElement('ul');
        detail.className = 'journey-legs';
        for (const leg of itinerary.legs) {
            const item = document.createElement('li');
            item.innerHTML = legLine(leg);
            detail.append(item);
        }
        card.append(detail);
        list.append(card);
    });

    if (itineraries.length > 0) {
        selectItineraryOverlays(itineraries[0]);
        drawItinerary(itineraries[0]);
        list.firstElementChild?.classList.add('selected');
    }
}

function selectItineraryOverlays(itinerary) {
    window.dispatchEvent(new CustomEvent('journey:select', {
        detail: {
            shuttleRoutes: [...new Set(itinerary.legs
                .filter((leg) => leg.type === 'shuttle' && leg.route)
                .map((leg) => leg.route))],
            cdtaRoutes: [...new Set(itinerary.legs
                .filter((leg) => leg.type === 'bus' && leg.routeShort)
                .map((leg) => leg.routeShort))],
        },
    }));
}

function legLine(leg) {
    const time = `${formatClock(leg.departMinute)} – ${formatClock(leg.arriveMinute)}`;
    if (leg.type === 'walk') {
        return `<span class="leg-icon">🚶</span> <strong>${escapeHtml(leg.from)}</strong> →
            <strong>${escapeHtml(leg.to)}</strong>
            <span class="leg-meta">${leg.minutes} min walk · ${time}</span>`;
    }
    if (leg.type === 'bike') {
        return `<span class="leg-icon">🚲</span> CDPHP bike via docks
            <span class="leg-meta">${leg.minutes} min · ${time}</span>`;
    }
    if (leg.type === 'shuttle') {
        return `<span class="leg-icon" style="background:${leg.color}"></span>
            <strong>${escapeHtml(leg.routeName)}</strong> toward campus loop
            <span class="leg-meta">${escapeHtml(String(leg.from))} → ${escapeHtml(String(leg.to))} · ${time}</span>`;
    }
    return `<span class="leg-icon" style="background:${leg.color}"></span>
        <strong>CDTA ${escapeHtml(leg.routeShort)}</strong> to ${escapeHtml(leg.headsign ?? '')}
        <span class="leg-meta">${escapeHtml(String(leg.from))} → ${escapeHtml(String(leg.to))} · ${time}</span>`;
}

// --------------------------------------------------------------- map drawing
async function drawItinerary(itinerary) {
    const drawVersion = ++state.drawVersion;
    state.resultLayers.clearLayers();
    const bounds = [];
    const walkLegs = itinerary.legs.filter((leg) =>
        leg.type === 'walk' && leg.fromPoint && leg.toPoint);
    const walkGeometries = await Promise.all(walkLegs.map((leg) => getWalkGeometry(leg)));
    const transitLegs = itinerary.legs.filter((leg) => leg.type === 'bus' || leg.type === 'shuttle');
    const transitGeometries = await Promise.all(transitLegs.map((leg) => getTransitGeometry(leg)));
    if (drawVersion !== state.drawVersion) return;

    for (const leg of itinerary.legs) {
        if (leg.type === 'walk' || leg.type === 'bike') {
            const from = leg.fromPoint
                ? [leg.fromPoint.lat, leg.fromPoint.lon]
                : endpointCoords(leg.from);
            const to = leg.toPoint
                ? [leg.toPoint.lat, leg.toPoint.lon]
                : endpointCoords(leg.to);
            const geometry = leg.geometry ?? walkGeometries[walkLegs.indexOf(leg)];
            if (from && to) {
                const walkingLine = new Polyline(geometry ?? [from, to], {
                    color: leg.type === 'bike' ? '#1a9641' : '#555555',
                    weight: 3, dashArray: '2 8', opacity: 0.9,
                }).addTo(state.resultLayers);
                if (leg.type === 'walk') {
                    addWalkingPathHandle(walkingLine, leg, geometry ?? [from, to]);
                }
                bounds.push(from, to);
            }
            continue;
        }

        // Transit legs: draw the vehicle's real geometry between the two stops.
        const transitIndex = transitLegs.indexOf(leg);
        const points = transitGeometries[transitIndex] ?? [];
        if (points.length > 1) {
            new Polyline(points, {
                color: '#ffffff', weight: 7, opacity: 0.85, lineCap: 'round',
            }).addTo(state.resultLayers);
            new Polyline(points, {
                color: leg.color ?? '#2563eb', weight: 4, opacity: 1,
                lineCap: 'round',
            }).addTo(state.resultLayers);
            bounds.push(...points);
        }
        const from = nodeCoords(state.bundle, leg.fromNode);
        const to = nodeCoords(state.bundle, leg.toNode);
        if (!from || !to) continue;
        bounds.push([from.lat, from.lon], [to.lat, to.lon]);
        for (const [coords, kind] of [[from, 'board'], [to, 'alight']]) {
            new CircleMarker([coords.lat, coords.lon], {
                radius: 6, color: '#ffffff', weight: 2,
                fillColor: leg.color ?? '#2563eb', fillOpacity: 1,
            }).bindTooltip(`${kind === 'board' ? 'Board' : 'Alight'} · ${leg.routeName ?? 'CDTA ' + leg.routeShort}`)
                .addTo(state.resultLayers);
        }
    }

    async function getWalkGeometry(leg) {
        if (leg.geometry || !leg.fromPoint || !leg.toPoint) return leg.geometry;
        const key = `${leg.fromPoint.lon},${leg.fromPoint.lat};${leg.toPoint.lon},${leg.toPoint.lat}`;
        if (state.walkRoutes.has(key)) return state.walkRoutes.get(key);
        if (!state.mapboxToken) return undefined;

        const request = fetchWalkGeometry(leg.fromPoint, leg.toPoint);
        state.walkRoutes.set(key, request);
        const geometry = await request;
        state.walkRoutes.set(key, geometry);
        return geometry;
    }

    async function fetchWalkGeometry(from, to) {
        return fetchMapboxGeometry(from, to, MAPBOX_PROFILE);
    }

    function addWalkingPathHandle(line, leg, geometry) {
        if (geometry.length < 2) return;
        const midpoint = geometry[Math.floor(geometry.length / 2)];
        const handle = new Marker(midpoint, {
            draggable: true,
            opacity: 0,
            icon: new DivIcon({
                className: 'journey-walk-handle',
                html: '<div></div>',
                iconSize: [18, 18],
                iconAnchor: [9, 9],
            }),
        }).addTo(state.resultLayers);
        let hideTimer = null;
        const showHandle = () => {
            clearTimeout(hideTimer);
            handle.setOpacity(1);
        };
        const hideHandle = () => {
            hideTimer = setTimeout(() => {
                if (!handle.dragging?._dragging) handle.setOpacity(0);
            }, 250);
        };
        line.on('mouseover', showHandle);
        line.on('mouseout', hideHandle);
        handle.on('mouseover', showHandle);
        handle.on('mouseout', hideHandle);
        handle.on('dragstart', showHandle);
        handle.on('dragend', async () => {
            showHandle();
            const point = handle.getLatLng();
            const from = leg.fromPoint;
            const to = leg.toPoint;
            const routed = await fetchMapboxGeometry(
                from, to, MAPBOX_PROFILE, { lat: point.lat, lon: point.lng },
            );
            if (routed?.length > 1) {
                line.setLatLngs(routed);
                handle.setLatLng(routed[Math.floor(routed.length / 2)]);
            } else {
                handle.setLatLng(point);
            }
        });
    }

    async function getTransitGeometry(leg) {
        if (leg.type === 'shuttle') return transitLegGeometry(state.bundle, leg);
        const from = nodeCoords(state.bundle, leg.fromNode);
        const to = nodeCoords(state.bundle, leg.toNode);
        if (!from || !to || !state.mapboxToken) return undefined;
        const key = `bus:${from.lon},${from.lat};${to.lon},${to.lat}`;
        if (state.transitRoutes.has(key)) return state.transitRoutes.get(key);
        const request = fetchMapboxGeometry(from, to, MAPBOX_TRANSIT_PROFILE);
        state.transitRoutes.set(key, request);
        const geometry = await request;
        state.transitRoutes.set(key, geometry);
        return geometry;
    }

    if (bounds.length > 0) {
        state.map.fitBounds(bounds, { padding: [60, 60], maxZoom: 17 });
    }
}

// Coordinates for labels used by access/direct legs ('Origin', stop names).
function endpointCoords(label) {
    if (label === 'Origin' && state.origin) return [state.origin.lat, state.origin.lon];
    if (label === 'Destination' && state.destination) return [state.destination.lat, state.destination.lon];
    const node = [...state.index.nodes.values()].find((n) => n.label === label);
    return node ? [node.lat, node.lon] : null;
}

// Real geometry for a transit leg: shuttle loop slice or CDTA pattern shape.
function transitLegGeometry(bundle, leg) {
    if (leg.type === 'shuttle') {
        const route = bundle.shuttle.routes[leg.route];
        const shape = route?.shape;
        if (!shape) return [];
        const fromOffset = shuttleStopOffset(bundle, leg.route, leg.fromNode);
        const toOffset = shuttleStopOffset(bundle, leg.route, leg.toNode);
        if (fromOffset === null || toOffset === null) return [];
        return shape
            .filter((point) => point[2] >= fromOffset && point[2] <= toOffset)
            .map(([lat, lon]) => [lat, lon]);
    }
    return [];
}

function shuttleStopOffset(bundle, route, nodeKey) {
    const key = nodeKey?.split(':')[1];
    const stop = bundle.shuttle.stops.find((s) => s.key === key);
    return stop?.offsets[route] ?? null;
}

function escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function clearResults() {
    state.resultLayers.clearLayers();
    $('journey-results').replaceChildren();
}
