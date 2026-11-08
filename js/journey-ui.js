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
import { buildIndex, search, findWalkAccess, buildDirectOptions } from './journey.js';
import { troyNow, formatClock } from './time.js';

const ACCESS_CANDIDATES = 8;   // stops upgraded with real Mapbox walk times
const ACCESS_RADIUS_M = 800;   // search radius around a clicked point
const ACCESS_DEFAULT_MIN = 1;  // fallback walk minutes when Mapbox is unavailable
const BUNDLE_TIMEOUT_MS = 15_000; // schedule bundle fetch deadline
const MAPBOX_PROFILE = 'mapbox/walking';

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
    map: null,           // injected by initJourneyUi
    apiBase: '',         // same-origin or absolute, from map.js
};

const $ = (id) => document.getElementById(id);

// --------------------------------------------------------------- init
export function initJourneyUi({ map, apiBase, mapboxToken }) {
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
        const response = await fetch(`${state.apiBase}/planner/planner-data.json`, options);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        state.bundle = await response.json();
        state.index = buildIndex(state.bundle);
    } catch (error) {
        state.bundleError = error.name === 'TimeoutError'
            ? 'timed out' : error.message;
    } finally {
        state.loadingBundle = false;
        updateControls();
    }
}

// Reflects the whole input state on the controls, so every dead end is
// visible: which endpoints are set, what is being waited for, and whether
// Find routes can do anything yet.
function updateControls() {
    updateButtonStates();
    updateHint();
}

function updateButtonStates() {
    const originBtn = $('journey-set-origin');
    const destBtn = $('journey-set-destination');
    const searchBtn = $('journey-search');

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
}

function updateHint() {
    const hint = $('journey-hint');
    if (state.bundleError) {
        hint.textContent = `Could not load transit schedules (${state.bundleError}). ` +
            'Check that the dev server is running, then retry.';
    } else if (!state.bundle) {
        hint.textContent = 'Loading transit schedules…';
    } else if (state.armed) {
        hint.textContent = `Now click the map to place the ${state.armed}.`;
    } else if (!state.origin || !state.destination) {
        hint.textContent = 'Click "Set origin", then click the map. Repeat for the destination.';
    } else if (!state.searching) {
        hint.textContent = 'Ready — press "Find routes".';
    }
}

// --------------------------------------------------------------- input
function armClick(which) {
    if (state.armed === which) return;
    state.armed = which;
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
    state[which] = { lat: latlng[0], lon: latlng[1],
                     label: which === 'origin' ? 'Origin' : 'Destination' };
    const marker = new Marker(latlng, { /* …unchanged… */ });
    // …unchanged marker setup…
    state.markers[which] = marker;

    // Removed: if (which === 'origin' && !state.destination) armClick('destination');
    updateControls();
    if (state.origin && state.destination) runSearch();
}

// --------------------------------------------------------------- search
async function runSearch() {
    if (!state.bundle) {
        $('journey-hint').textContent = 'Still loading schedules — try again in a moment.';
        loadBundleOnce();
        return;
    }
    if (!state.origin || !state.destination) {
        $('journey-hint').textContent =
            'Set both endpoints first: press "Set origin", click the map, then "Set destination".';
        return;
    }

    state.searching = true;
    updateButtonStates();          // NOT updateControls — must not touch the hint

    try {
        const date = $('journey-date').value || troyNow().date;
        const [hour, minute] = $('journey-when').value.split(':').map(Number);
        const departMinute = (hour || 0) * 60 + (minute || 0);

        const originAccess = findWalkAccess(state.bundle, state.origin, ACCESS_RADIUS_M);
        const destAccess = findWalkAccess(state.bundle, state.destination, ACCESS_RADIUS_M);

        // Mapbox lookups run in parallel; each falls back to local estimates
        // on failure, so a bad token never blocks the search.
        const [walkOverride, originUpgraded, destUpgraded] = await Promise.all([
            mapboxWalkOverride(state.origin, state.destination),
            upgradeAccess(originAccess, state.origin),
            upgradeAccess(destAccess, state.destination),
        ]);
        const direct = buildDirectOptions(state.bundle, state.origin, state.destination, walkOverride);

        const itineraries = search(state.index, {
            origin: state.origin,
            destination: state.destination,
            date,
            departMinute,
            originAccess: originUpgraded,
            destAccess: destUpgraded,
            direct,
        });

        renderItineraries(itineraries);
        $('journey-hint').textContent = itineraries.length
            ? `${itineraries.length} option${itineraries.length === 1 ? '' : 's'} found`
            : 'No itinerary found — try a nearer stop or another time.';
    } catch (error) {
        console.error('Trip search failed:', error);
        $('journey-hint').textContent = `Search failed: ${error.message}`;
    } finally {
        state.searching = false;
        updateButtonStates();      // hint is deliberately not touched here
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

// Replace estimated walk minutes for the nearest stops with real Mapbox
// matrix times. Returns a fresh list; falls back to estimates per candidate.
async function upgradeAccess(access, point) {
    if (!state.mapboxToken || access.length === 0) return access;
    const candidates = access.slice(0, ACCESS_CANDIDATES);
    try {
        const coords = [point, ...candidates.map((c) => nodeCoords(state.bundle, c.nodeKey))]
            .map((p) => `${p.lon},${p.lat}`).join(';');
        const url = `https://api.mapbox.com/directions-matrix/v1/${MAPBOX_PROFILE}` +
            `?coordinates=${encodeURIComponent(coords)}` +
            `&sources=0&destinations=${candidates.map((_, i) => i + 1).join(';')}` +
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

    itineraries.forEach((itinerary, index) => {
        const card = document.createElement('article');
        card.className = 'journey-option';

        const header = document.createElement('button');
        header.type = 'button';
        header.className = 'journey-option-head';
	const badges = itinerary.legs.map((leg) => {
    	    if (leg.type === 'walk') return '<span class="journey-chip journey-chip-walk">Walk</span>';
            if (leg.type === 'bike') return '<span class="journey-chip journey-chip-bike">Bike</span>';
            if (leg.type === 'shuttle') return `<span class="journey-chip" style="background:${leg.color}">Shuttle</span>`;
            return `<span class="journey-chip" style="background:${leg.color}">${escapeHtml(leg.routeShort)}</span>`;
            }).join('<span class="journey-arrow">›</span>');
        header.innerHTML = `
            <span class="journey-time">${formatClock(itinerary.departure)} – ${formatClock(itinerary.arrival)}</span>
            <span class="journey-badges">${badges}</span>
            <span class="journey-total">${formatClock(itinerary.departure)} departure</span>`;
        header.addEventListener('click', () => {
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

    if (itineraries.length > 0) drawItinerary(itineraries[0]);
}

function legLine(leg) {
    const time = `${formatClock(leg.departMinute)} – ${formatClock(leg.arriveMinute)}`;
    if (leg.type === 'walk') {
        return `<span class="leg-label">Walk</span>
            <strong>${escapeHtml(leg.from)}</strong> →
            <strong>${escapeHtml(leg.to)}</strong>
            <span class="leg-meta">${leg.minutes} min · ${time}</span>`;
    }
    if (leg.type === 'bike') {
        return `<span class="leg-label">Bike</span> CDPHP bike via docks
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
function drawItinerary(itinerary) {
    state.resultLayers.clearLayers();
    const bounds = [];

    for (const leg of itinerary.legs) {
        if (leg.type === 'walk' || leg.type === 'bike') {
            // Straight dashed connector (Mapbox geometry is added when available).
            const from = endpointCoords(leg.from);
            const to = endpointCoords(leg.to);
            if (from && to) {
                new Polyline([from, to], {
                    color: leg.type === 'bike' ? '#1a9641' : '#555555',
                    weight: 3, dashArray: '2 8', opacity: 0.9,
                }).addTo(state.resultLayers);
                bounds.push(from, to);
            }
            continue;
        }

        // Transit legs: draw the vehicle's real geometry between the two stops.
        const points = transitLegGeometry(state.bundle, leg);
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
        bounds.push([from.lat, from.lon], [to.lat, to.lon]);
        for (const [coords, kind] of [[from, 'board'], [to, 'alight']]) {
            new CircleMarker([coords.lat, coords.lon], {
                radius: 6, color: '#ffffff', weight: 2,
                fillColor: leg.color ?? '#2563eb', fillOpacity: 1,
            }).bindTooltip(`${kind === 'board' ? 'Board' : 'Alight'} · ${leg.routeName ?? 'CDTA ' + leg.routeShort}`)
                .addTo(state.resultLayers);
        }
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
        return shape.filter((point) => point.offset >= fromOffset && point.offset <= toOffset)
            .map((point) => point.coords);
    }
    // CDTA: decode the route's precomputed polylines is overkill per leg; draw
    // a straight board→alight connector instead, colored like the route.
    const from = nodeCoords(bundle, leg.fromNode);
    const to = nodeCoords(bundle, leg.toNode);
    return [[from.lat, from.lon], [to.lat, to.lon]];
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
