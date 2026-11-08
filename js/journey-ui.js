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
const MAPBOX_PROFILE = 'mapbox/walking';

// --------------------------------------------------------------- state
const state = {
    bundle: null,        // planner-data.json, loaded once
    index: null,         // buildIndex(bundle), built once
    mapboxToken: null,   // from map.js config
    active: false,       // panel open?
    armed: null,         // 'origin' | 'destination' while awaiting a map click
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
}

function togglePanel() {
    state.active = !state.active;
    $('journey-panel').hidden = !state.active;
    if (state.active) {
        $('journey-open').hidden = true;
        loadBundleOnce();
    } else {
        $('journey-open').hidden = false;
        state.armed = null;
        $('journey-hint').textContent = 'Click the map to set origin, then destination.';
        clearResults();
    }
}

async function loadBundleOnce() {
    if (state.bundle) return;
    try {
        $('journey-hint').textContent = 'Loading transit schedules…';
        const response = await fetch(`${state.apiBase}/planner/planner-data.json`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        state.bundle = await response.json();
        state.index = buildIndex(state.bundle);
        $('journey-hint').textContent = 'Click the map to set origin, then destination.';
    } catch (error) {
        $('journey-hint').textContent = `Could not load planner data: ${error.message}`;
    }
}

// --------------------------------------------------------------- input
function armClick(which) {
    state.armed = which;
    $('journey-hint').textContent = `Click the map to set the ${which}.`;
}

function onMapClick(event) {
    if (!state.armed) return;
    const which = state.armed;
    state.armed = null;
    const latlng = [event.latlng.lat, event.latlng.lng];
    setEndpoint(which, latlng);
}

function setEndpoint(which, latlng) {
    state[which] = { lat: latlng[0], lon: latlng[1], label: which === 'origin' ? 'Origin' : 'Destination' };
    if (state.markers[which]) state.markers[which].remove();
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
    if (state.origin && state.destination) runSearch();
}

// --------------------------------------------------------------- search
async function runSearch() {
    if (!state.bundle || !state.origin || !state.destination) return;
    const hint = $('journey-hint');
    hint.textContent = 'Finding routes…';

    try {
        const date = $('journey-date').value || troyNow().date;
        const [hour, minute] = $('journey-when').value.split(':').map(Number);
        const departMinute = (hour || 0) * 60 + (minute || 0);

        // Access walks: estimates first, then upgraded with Mapbox times.
        const originAccess = findWalkAccess(state.bundle, state.origin, ACCESS_RADIUS_M);
        const destAccess = findWalkAccess(state.bundle, state.destination, ACCESS_RADIUS_M);
        const walkOverride = await mapboxWalkOverride(state.origin, state.destination);
        const direct = buildDirectOptions(state.bundle, state.origin, state.destination, walkOverride);

        const itineraries = search(state.index, {
            origin: state.origin,
            destination: state.destination,
            date,
            departMinute,
            originAccess: upgradeAccess(originAccess, state.origin),
            destAccess: upgradeAccess(destAccess, state.destination),
            direct,
        });

        renderItineraries(itineraries);
        hint.textContent = itineraries.length
            ? `${itineraries.length} option${itineraries.length === 1 ? '' : 's'} found`
            : 'No itinerary found — try a nearer stop or another time.';
    } catch (error) {
        hint.textContent = `Search failed: ${error.message}`;
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
