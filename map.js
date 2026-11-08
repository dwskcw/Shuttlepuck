// ---------------------------------------------------------------
// Map + base tiles
// ---------------------------------------------------------------
import {
    LeafletMap, TileLayer, Polyline, CircleMarker, Marker, DivIcon,
    LayerGroup, LatLngBounds
} from 'leaflet';
import * as Leaflet from 'leaflet';
import { initJourneyUi } from './js/journey-ui.js';

// ---------------------------------------------------------------
// leaflet-providers
//
// The plugin is a UMD script that hangs `TileLayer.Provider` off a
// global `L`. Leaflet is loaded here as an ES module, so expose the
// module namespace on `globalThis` first. If the plugin can't be
// loaded (CDN blocked, incompatible build, …) `providersAvailable`
// stays false and we fall back to the hand-written URLs below — the
// map still works.
// ---------------------------------------------------------------
if (!globalThis.L) globalThis.L = Leaflet;

let providersAvailable = false;
try {
    await import('leaflet-providers');
    providersAvailable = typeof TileLayer.Provider === 'function';
} catch (err) {
    console.warn('leaflet-providers unavailable; using built-in tile URLs.', err);
}

// ---------------------------------------------------------------
// Config
// ---------------------------------------------------------------
const params = new URLSearchParams(location.search);
const apiParam = params.get('api');
const API_BASE = !apiParam || apiParam === 'same-origin'
    ? ''
    : apiParam.replace(/\/$/, '');
const POLL_MS = 5000;            // same cadence as the Shubble frontend
const OFF_ROUTE_COLOR = '#666666';
const MOBILE_QUERY = '(max-width: 768px)';
const mobileMq = window.matchMedia(MOBILE_QUERY);

// ---------------------------------------------------------------
// Map + base tiles
// ---------------------------------------------------------------
const map = new LeafletMap('map', {
    center: [42.730, -73.677],
    zoom: 17
});

// The Mapbox token that loads the base tiles also drives the walking
// directions used by the trip planner (Directions + Matrix APIs).
const MAPBOX_TOKEN = 'pk.eyJ1IjoiZHdza2N3IiwiYSI6ImNtdzZyd3d3ZzBpY2IzMG9wc28weXNsbHgifQ.9zT3RQw_K7LbSSYeJXxPNg';

// Hand-written Mapbox URL, used only if leaflet-providers didn't load.
const MAPBOX_TILES_URL = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/512/{z}/{x}/{y}@2x?access_token=${MAPBOX_TOKEN}`;

// Primary base layer: Mapbox, built through leaflet-providers when
// available so we get a maintained URL template and attribution.
const tiles = providersAvailable
    ? new TileLayer.Provider('Mapbox.Streets', { accessToken: MAPBOX_TOKEN })
    : new TileLayer(MAPBOX_TILES_URL, {
        tileSize: 512,
        zoomOffset: -1,
        maxZoom: 22,
        attribution:
            '© <a href="https://www.mapbox.com/about/maps/">Mapbox</a> ' +
            '© <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    });

// Standby layer. Not added to the map unless Mapbox starts failing.
const fallbackTiles = providersAvailable
    ? new TileLayer.Provider('OpenStreetMap.Mapnik')
    : new TileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        minZoom: 3,
        maxZoom: 19,
        attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    });

tiles.addTo(map);

// ---------------------------------------------------------------
// Automatic base-tile fallback
//
// Mapbox rate limits (403/429) and outages surface as `tileerror`
// events on the layer. leaflet-providers gives us a clean way to
// build the primary and standby layers, but it doesn't react to
// runtime failures — so we still count consecutive tile errors on
// the Mapbox layer and, once we cross the threshold, swap in the
// OSM standby layer. A successful `tileload` resets the counter so
// a single transient blip never triggers the switch.
// ---------------------------------------------------------------
const TILE_ERROR_THRESHOLD = 8;
let mapboxTileErrors = 0;
let usingFallbackTiles = false;

tiles.on('tileerror', () => {
    if (usingFallbackTiles) return;
    mapboxTileErrors++;
    if (mapboxTileErrors < TILE_ERROR_THRESHOLD) return;

    usingFallbackTiles = true;
    if (map.hasLayer(tiles)) map.removeLayer(tiles);
    fallbackTiles.addTo(map);
    console.warn(
        `Mapbox tiles failed ${mapboxTileErrors} times in a row; ` +
        'switched base layer to OpenStreetMap.'
    );
});

tiles.on('tileload', () => {
    if (!usingFallbackTiles) mapboxTileErrors = 0;
});

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
const $status = document.getElementById('status');
const routeTreeContainer = document.getElementById('route-tree');

// Only these two Shubble routes and two CDTA routes are initially visible.
const selectedShuttleRoutes = new Set(['NORTH', 'WEST']);
const selectedCdtaRoutes = new Set();
let bikeLocationsEnabled = true;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const safeColor = c => (/^#[0-9a-f]{3,8}$/i.test(c ?? '') ? c : OFF_ROUTE_COLOR);

// routes.json marks hidden routes (entry/exit paths) with a fully transparent
// color such as "#00000000". Those are not drawn.
const isVisibleColor = c => !(typeof c === 'string' && c.length === 9 && c.endsWith('00'));

const routeLabel = key => key.charAt(0) + key.slice(1).toLowerCase();

async function getJSON(path) {
    const res = await fetch(API_BASE + path);
    if (!res.ok) throw new Error(`${path} returned ${res.status}`);
    return res.json();
}

function setStatus(text, isError = false) {
    $status.textContent = text;
    $status.classList.toggle('error', isError);
}

// ---------------------------------------------------------------
// Routes: lines + stops from GET /api/routes
//
// Shape: { NORTH: { COLOR, STOPS: [key…], POLYLINE_STOPS: [key…],
//                   <stopKey>: { COORDINATES: [lat, lng], NAME, OFFSET },
//                   ROUTES: [ [[lat, lng], …], … ] }, WEST: {…}, … }
// ROUTES holds one polyline per leg between consecutive POLYLINE_STOPS.
// ---------------------------------------------------------------
let routeData = {};
let routesLoaded = false;
const routeColors = new Map();   // route key -> color (hidden routes get grey)
const shuttleRouteLayers = new Map(); // route key -> independently toggleable layer

function syncShuttleVisibility() {
    for (const [key, layer] of shuttleRouteLayers) {
        if (selectedShuttleRoutes.has(key)) {
            if (!map.hasLayer(layer)) map.addLayer(layer);
        } else if (map.hasLayer(layer)) {
            map.removeLayer(layer);
        }
    }
    syncVehicleVisibility();
}

async function loadRoutes() {
    routeData = await getJSON('/api/routes');

    const visibleBounds = new LatLngBounds();
    shuttleRouteLayers.clear();

    for (const [key, route] of Object.entries(routeData)) {
        const visible = isVisibleColor(route.COLOR);
        routeColors.set(key, visible ? safeColor(route.COLOR) : OFF_ROUTE_COLOR);
        if (!visible) continue;

        const color = routeColors.get(key);
        const routeLayer = new LayerGroup();

        for (const leg of route.ROUTES ?? []) {
            routeLayer.addLayer(new Polyline(leg, {
                color: '#ffffff', weight: 9, opacity: 0.9,
                lineCap: 'round', lineJoin: 'round', interactive: false
            }));
            routeLayer.addLayer(new Polyline(leg, {
                color, weight: 5, opacity: 0.95,
                lineCap: 'round', lineJoin: 'round', interactive: false
            }));
            if (selectedShuttleRoutes.has(key)) {
                for (const point of leg) visibleBounds.extend(point);
            }
        }

        // STOPS lists the real stops (POLYLINE_STOPS also has "ghost" stops
        // used only for shaping the line). A loop route repeats its first
        // stop at the end, so skip duplicate coordinates.
        const seen = new Set();
        for (const stopKey of route.STOPS ?? []) {
            const stop = route[stopKey];
            if (!stop?.COORDINATES) continue;
            const id = stop.COORDINATES.join(',');
            if (seen.has(id)) continue;
            seen.add(id);

            const marker = new CircleMarker(stop.COORDINATES, {
                radius: 5, color, weight: 3, fillColor: '#ffffff', fillOpacity: 1
            });
            marker.bindTooltip(stop.NAME);
            routeLayer.addLayer(marker);
        }
        shuttleRouteLayers.set(key, routeLayer);
    }

    syncShuttleVisibility();
    if (visibleBounds.isValid()) map.fitBounds(visibleBounds, { padding: [40, 40] });
    renderRouteTree(); // replace placeholder colors with API-provided shuttle colors

    routesLoaded = true;
}

// ---------------------------------------------------------------
// Shuttles: GET /api/locations (position) + GET /api/velocities (route match)
//
// /api/locations  -> { [vehicleId]: { name, latitude, longitude,
//                      heading_degrees, speed_mph, timestamp, … } }
// /api/velocities -> { [vehicleId]: { route_name, current_stop,
//                      is_at_stop, polyline_index, segment_index, … } }
// ---------------------------------------------------------------
const vehicleLayer = new LayerGroup();
map.addLayer(vehicleLayer);
const markers = new Map();   // vehicleId -> Marker
const vehicleRoutes = new Map(); // last matched route for each vehicle

function showVehicleForRoute(routeName) {
    // When velocities are unavailable, show grey markers as long as at
    // least one shuttle route is enabled.
    return routeName ? selectedShuttleRoutes.has(routeName) : selectedShuttleRoutes.size > 0;
}

function syncVehicleVisibility() {
    for (const [id, marker] of markers) {
        if (showVehicleForRoute(vehicleRoutes.get(id))) {
            if (!vehicleLayer.hasLayer(marker)) vehicleLayer.addLayer(marker);
        } else if (vehicleLayer.hasLayer(marker)) {
            vehicleLayer.removeLayer(marker);
        }
    }
}

function shuttleIcon(color, heading) {
    const deg = Number.isFinite(heading) ? heading : 0;
    return new DivIcon({
        className: 'shuttle-icon',
        html: `<div class="shuttle" style="--c:${safeColor(color)};transform:rotate(${deg}deg)"></div>`,
        iconSize: [36, 36],
        iconAnchor: [18, 18],
        popupAnchor: [0, -20]
    });
}

function styleShuttle(marker, color, heading) {
    const el = marker.getElement()?.querySelector('.shuttle');
    if (!el) return;
    el.style.setProperty('--c', safeColor(color));
    el.style.transform = `rotate(${Number.isFinite(heading) ? heading : 0}deg)`;
}

function popupHtml(v, vel) {
    const lines = [`<strong>${esc(v.name ?? 'Shuttle')}</strong>`];

    lines.push(vel.route_name
        ? `Route: ${esc(routeLabel(vel.route_name))}`
        : '<span class="muted">Not matched to a route</span>');

    if (vel.is_at_stop && vel.current_stop) {
        const name = routeData[vel.route_name]?.[vel.current_stop]?.NAME ?? vel.current_stop;
        lines.push(`At stop: ${esc(name)}`);
    }
    if (Number.isFinite(v.speed_mph)) lines.push(`Speed: ${Math.round(v.speed_mph)} mph`);
    if (v.timestamp) {
        const t = new Date(v.timestamp);
        if (!Number.isNaN(t.getTime())) {
            lines.push(`<span class="muted">Position at ${esc(t.toLocaleTimeString())}</span>`);
        }
    }
    return `<div class="shuttle-popup">${lines.join('<br>')}</div>`;
}

async function refreshVehicles() {
    // Velocities only add route info, so the markers still render without it.
    const [locResult, velResult] = await Promise.allSettled([
        getJSON('/api/locations'),
        getJSON('/api/velocities')
    ]);
    if (locResult.status === 'rejected') throw locResult.reason;

    const locations = locResult.value;
    const velocities = velResult.status === 'fulfilled' ? velResult.value : {};

    for (const [id, v] of Object.entries(locations)) {
        if (!Number.isFinite(v.latitude) || !Number.isFinite(v.longitude)) continue;

        const vel = velocities[id] ?? {};
        vehicleRoutes.set(id, vel.route_name ?? null);
        const color = routeColors.get(vel.route_name) ?? OFF_ROUTE_COLOR;
        const heading = v.heading_degrees;
        const latlng = [v.latitude, v.longitude];

        let marker = markers.get(id);
        if (marker) {
            marker.setLatLng(latlng);
            styleShuttle(marker, color, heading);
            marker.setPopupContent(popupHtml(v, vel));
        } else {
            marker = new Marker(latlng, {
                icon: shuttleIcon(color, heading),
                title: v.name ?? 'Shuttle',
                zIndexOffset: 1000
            });
            marker.bindPopup(popupHtml(v, vel));
            markers.set(id, marker);
        }
    }

    // Drop shuttles that have left the geofence.
    for (const [id, marker] of markers) {
        if (!(id in locations)) {
            vehicleLayer.removeLayer(marker);
            markers.delete(id);
            vehicleRoutes.delete(id);
        }
    }

    syncVehicleVisibility();

    return { count: markers.size, routeMatching: velResult.status === 'fulfilled' };
}

// ---------------------------------------------------------------
// Polling
// ---------------------------------------------------------------
let timer = null;
let inFlight = false;

async function tick() {
    if (inFlight) return;
    inFlight = true;
    let routeError = null;
    try {
        if (!routesLoaded) {
            try { await loadRoutes(); } catch (err) { routeError = err; }
        }

        const { count, routeMatching } = await refreshVehicles();
        const time = new Date().toLocaleTimeString();
        const base = count === 0
            ? 'No shuttles in service right now'
            : `${count} shuttle${count === 1 ? '' : 's'}`;

        if (routeError) {
            setStatus(`${base} · couldn’t load route lines (${routeError.message})`, true);
        } else if (!routeMatching) {
            setStatus(`${base} · route colors unavailable · ${time}`);
        } else {
            setStatus(`${base} · updated ${time}`);
        }
    } catch (err) {
        const networkHint = err instanceof TypeError
            ? ` Check that ${API_BASE || location.origin} is reachable and allows this page’s origin (CORS).`
            : '';
        setStatus(`Can’t load shuttles: ${err.message}.${networkHint}`, true);
    } finally {
        inFlight = false;
    }
}

function startPolling() {
    tick();
    timer = setInterval(tick, POLL_MS);
}

// Pause polling while the tab is hidden.
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        clearInterval(timer);
        timer = null;
    } else if (!timer) {
        startPolling();
    }
});

// ---------------------------------------------------------------
// CDTA: static GTFS-derived route geometry, stops, and departures.
// These two JSON files are served locally by dev-server.mjs; neither
// request goes through the Shubble /api/* proxy.
// ---------------------------------------------------------------
const cdtaDateInput = document.getElementById('cdta-date');
const cdtaStatus = document.getElementById('cdta-status');
const cdtaLineLayer = new LayerGroup().addTo(map);
const cdtaStopLayer = new LayerGroup().addTo(map);
const cdtaTimeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

let cdtaTransit = null;
let cdtaDepartures = null;
let cdtaSelectedStopIndex = null;
let cdtaSelectedMarker = null;

function cdtaSetStatus(message, isError = false) {
    cdtaStatus.textContent = message;
    cdtaStatus.classList.toggle('error', isError);
}

function cdtaNow() {
    const fields = Object.fromEntries(
        cdtaTimeFormatter.formatToParts(new Date()).map(part => [part.type, part.value])
    );
    return {
        date: `${fields.year}-${fields.month}-${fields.day}`,
        minute: Number(fields.hour) * 60 + Number(fields.minute)
    };
}

// Each line uses Google's encoded-polyline format (1e-5 degrees).
function cdtaDecodeLine(encoded) {
    const points = [];
    let offset = 0, latitude = 0, longitude = 0;
    while (offset < encoded.length) {
        const delta = [];
        for (let part = 0; part < 2; part++) {
            let value = 0, shift = 0, byte;
            do {
                if (offset >= encoded.length) throw new Error('Incomplete CDTA polyline');
                byte = encoded.charCodeAt(offset++) - 63;
                value |= (byte & 0x1f) << shift;
                shift += 5;
            } while (byte >= 0x20);
            delta.push(value & 1 ? ~(value >> 1) : value >> 1);
        }
        latitude += delta[0];
        longitude += delta[1];
        points.push([latitude / 1e5, longitude / 1e5]);
    }
    return points;
}

function cdtaColor(route) {
    const color = route?.color;
    return typeof color === 'string' && /^[0-9a-f]{6}$/i.test(color)
        ? `#${color}` : '#2563eb';
}

function cdtaDrawLines() {
    cdtaLineLayer.clearLayers();
    if (!cdtaTransit) return;

    for (const index of selectedCdtaRoutes) {
        const route = cdtaTransit.routes[index];
        if (!route) continue;
        for (const encoded of route.lines) {
            const points = cdtaDecodeLine(encoded);
            if (points.length < 2) continue;
            new Polyline(points, {
                color: cdtaColor(route), weight: 3, opacity: 0.65
            }).bindPopup(`${esc(route.short)} — ${esc(route.name)}`)
                .addTo(cdtaLineLayer);
        }
    }
}

// GTFS service mask is Monday..Sunday. Exceptions: 1=added, 2=removed.
function cdtaServiceRuns(serviceIndex, date) {
    const service = cdtaTransit.services[serviceIndex];
    if (!service) return false;
    const numericDate = Number(date.replaceAll('-', ''));
    const exception = (cdtaTransit.exceptions?.[String(numericDate)] || [])
        .find(([index]) => index === serviceIndex);
    if (exception) return exception[1] === 1;

    const [weekdays, start, end] = service;
    const sundayBasedDay = new Date(`${date}T12:00:00Z`).getUTCDay();
    const mondayBasedDay = (sundayBasedDay + 6) % 7;
    return numericDate >= start && numericDate <= end &&
        weekdays[mondayBasedDay] === '1';
}

function cdtaPreviousDate(date) {
    const day = new Date(`${date}T12:00:00Z`);
    day.setUTCDate(day.getUTCDate() - 1);
    return day.toISOString().slice(0, 10);
}

function cdtaClockTime(minute) {
    const hour = Math.floor(minute / 60);
    return `${hour % 12 || 12}:${String(minute % 60).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

function cdtaStopDepartures(stopIndex, date) {
    if (!cdtaDepartures) return [];
    // IMPORTANT: departures.stops keys are indexes into transit.stops,
    // NOT public CDTA stop IDs (e.g. "07216").
    const entries = cdtaDepartures.stops[String(stopIndex)] || [];
    const yesterday = cdtaPreviousDate(date);
    const times = [];

    for (const [serviceIndex, routeIndex, headsignIndex, compressed] of entries) {
        if (!selectedCdtaRoutes.has(routeIndex)) continue;
        const activeToday = cdtaServiceRuns(serviceIndex, date);
        const activeYesterday = cdtaServiceRuns(serviceIndex, yesterday);
        if (!activeToday && !activeYesterday) continue;

        // First value is minutes since midnight; remaining values
        // are successive gaps, also in minutes.
        let minute = 0;
        for (let i = 0; i < compressed.length; i++) {
            minute = i === 0 ? compressed[i] : minute + compressed[i];
            if (activeToday && minute < 1440) {
                times.push({minute, routeIndex, headsignIndex});
            }
            // A previous service day's 24:xx trip belongs to today.
            if (activeYesterday && minute >= 1440 && minute < 2880) {
                times.push({minute: minute - 1440, routeIndex, headsignIndex});
            }
        }
    }
    return times.sort((a, b) => a.minute - b.minute || a.routeIndex - b.routeIndex);
}

function cdtaPopup(stop, index) {
    const root = document.createElement('div');
    root.className = 'cdta-popup';
    const heading = document.createElement('h3');
    heading.textContent = stop[1];
    const subtitle = document.createElement('div');
    subtitle.className = 'muted';
    subtitle.textContent = `CDTA stop #${stop[0]} · ${cdtaDateInput.value}`;
    root.append(heading, subtitle);

    if (!cdtaDepartures) {
        const message = document.createElement('p');
        message.textContent = 'Departure data is unavailable.';
        root.append(message);
        return root;
    }

    const now = cdtaNow();
    const afterMinute = cdtaDateInput.value === now.date ? now.minute : 0;
    const next = cdtaStopDepartures(index, cdtaDateInput.value)
        .filter(item => item.minute >= afterMinute).slice(0, 12);

    if (!next.length) {
        const message = document.createElement('p');
        message.textContent = 'No remaining scheduled departures for this date/route.';
        root.append(message);
        return root;
    }

    const list = document.createElement('ul');
    for (const departure of next) {
        const route = cdtaTransit.routes[departure.routeIndex];
        const item = document.createElement('li');
        const time = document.createElement('strong');
        time.textContent = cdtaClockTime(departure.minute);
        const chip = document.createElement('span');
        chip.className = 'cdta-route-chip';
        chip.style.backgroundColor = cdtaColor(route);
        const rgb = cdtaColor(route).slice(1);
        const brightness = 0.299 * parseInt(rgb.slice(0, 2), 16) +
            0.587 * parseInt(rgb.slice(2, 4), 16) +
            0.114 * parseInt(rgb.slice(4, 6), 16);
        chip.style.color = brightness > 155 ? '#1c1c1c' : '#fff';
        chip.textContent = route.short;
        const destination = document.createElement('div');
        destination.textContent = cdtaDepartures.headsigns[departure.headsignIndex] || route.name;
        item.append(time, chip, destination);
        list.append(item);
    }
    root.append(list);
    return root;
}

// Only create CDTA stop markers within the viewport, at zoom 13+.
// Drawing thousands of off-screen markers would slow down Leaflet.
function cdtaDrawStops() {
    cdtaStopLayer.clearLayers();
    cdtaSelectedMarker = null;
    if (!cdtaTransit || selectedCdtaRoutes.size === 0 || map.getZoom() < 13) return;

    const bounds = map.getBounds().pad(0.15);
    cdtaTransit.stops.forEach((stop, index) => {
        const [id, name, lat, lon, routeIndexes] = stop;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        if (!bounds.contains([lat, lon])) return;
        if (!routeIndexes.some(routeIndex => selectedCdtaRoutes.has(routeIndex))) return;

        const marker = new CircleMarker([lat, lon], {
            radius: 4, color: '#fff', weight: 1.5,
            fillColor: '#2563eb', fillOpacity: 0.95
        });
        const tooltip = document.createElement('span');
        tooltip.textContent = name;
        marker.bindTooltip(tooltip);
        marker.on('click', () => {
            cdtaSelectedStopIndex = index;
            cdtaSelectedMarker = marker;
            marker.bindPopup(cdtaPopup(stop, index), {maxWidth: 340}).openPopup();
        });
        marker.addTo(cdtaStopLayer);
    });
}

async function cdtaGetJSON(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.json();
}

async function loadCDTA() {
    cdtaDateInput.value = cdtaNow().date;
    try {
        cdtaTransit = await cdtaGetJSON('/cdta-transit.json');
        if (!Array.isArray(cdtaTransit.routes) || !Array.isArray(cdtaTransit.stops) ||
            !Array.isArray(cdtaTransit.services)) throw new Error('Invalid CDTA transit JSON');

        for (const [index, route] of cdtaTransit.routes.entries()) {
            if (route.short === '87' || route.short === '286') selectedCdtaRoutes.add(index);
        }
        renderRouteTree();
        cdtaDrawLines();
        cdtaDrawStops();
        cdtaSetStatus(`${cdtaTransit.routes.length} routes · ${cdtaTransit.stops.length.toLocaleString()} stops · loading schedules…`);

        try {
            cdtaDepartures = await cdtaGetJSON('/cdta-departures.json');
            if (!cdtaDepartures.stops || !Array.isArray(cdtaDepartures.headsigns)) {
                throw new Error('Invalid CDTA departure JSON');
            }
            const end = String(cdtaTransit.feed.end);
            cdtaSetStatus(`Static timetable through ${end.slice(0, 4)}-${end.slice(4, 6)}-${end.slice(6)} · not live ETAs`);
        } catch (error) {
            console.error(error);
            cdtaSetStatus(`CDTA routes loaded; departures failed: ${error.message}`, true);
        }
    } catch (error) {
        console.error(error);
        cdtaSetStatus(`CDTA data failed: ${error.message}. Check Node's JSON routes.`, true);
    }
}

// ---------------------------------------------------------------
// Bike locations: GeoJSON Point coordinates are [longitude, latitude].
// This is a static overlay and does not affect the route or vehicle APIs.
// ---------------------------------------------------------------
const bikeLayer = new LayerGroup();
const bikeStatus = document.getElementById('bike-status');
let bikeLocationsLoaded = false;

function syncBikeVisibility() {
    if (bikeLocationsEnabled && bikeLocationsLoaded) {
        if (!map.hasLayer(bikeLayer)) map.addLayer(bikeLayer);
    } else if (map.hasLayer(bikeLayer)) {
        map.removeLayer(bikeLayer);
    }
}

async function loadBikeLocations() {
    try {
        const response = await fetch('/bikedata.geojson');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
            throw new Error('Expected a GeoJSON FeatureCollection');
        }

        bikeLayer.clearLayers();
        let plotted = 0;
        for (const feature of data.features) {
            if (feature?.geometry?.type !== 'Point') continue;
            const [longitude, latitude] = feature.geometry.coordinates ?? [];
            if (!Number.isFinite(longitude) || !Number.isFinite(latitude) ||
                Math.abs(longitude) > 180 || Math.abs(latitude) > 90) continue;

            const properties = feature.properties ?? {};
            const name = properties.name || 'Bike location';
            const popup = document.createElement('div');
            const heading = document.createElement('strong');
            heading.textContent = name;
            popup.append(heading);
            if (properties.network) {
                const network = document.createElement('div');
                network.textContent = `Network: ${properties.network}`;
                popup.append(network);
            }
            if (properties.capacity !== undefined && properties.capacity !== '') {
                const capacity = document.createElement('div');
                capacity.textContent = `Station capacity: ${properties.capacity}`;
                popup.append(capacity);
            }

            new CircleMarker([latitude, longitude], {
                radius: 6, color: '#fff', weight: 1.5,
                fillColor: '#9333ea', fillOpacity: 0.95
            }).bindPopup(popup).addTo(bikeLayer);
            plotted++;
        }

        bikeLocationsLoaded = true;
        syncBikeVisibility();
        bikeStatus.textContent = `${plotted} bike locations`;
        bikeStatus.classList.remove('error');
    } catch (error) {
        console.error(error);
        bikeStatus.textContent = `Bike locations unavailable: ${error.message}`;
        bikeStatus.classList.add('error');
    }
}

// ---------------------------------------------------------------
// Unified nested route picker. These categories are UI groupings, not
// official CDTA route classifications. Every route remains available.
// ---------------------------------------------------------------
const CDTA_ROUTE_GROUPS = {
    featured: ['87', '286', '22', '85', '289', '802'],
    moreTroy: ['815', '182', '224', '370', '922', '923', '808', '821', '524'],
    albany: ['190', '801', '805', '803', '806', '737', '214', '812', '100',
        '106', '872', '117', '125', '114', '93', '10', '12', '107', '519',
        '540', '560', '1', '712', '807', '905', '13', '18', '910', '233', '155', '813'],
    schenectady: ['355', '763', '810', '605', '351', '353', '450'],
    saratoga: ['840', '452', '713', '600', '601'],
    glensFalls: ['404', '407', '402', '804', '411', '412', '419', '876', '877']
};

const expandedRouteGroups = new Map();
let routeTreeNodes = [];

function routeGroup(id, label, children, open = false) {
    if (mobileMq.matches && !expandedRouteGroups.has(id)) open = false;
    return {kind: 'group', id, label, children, open};
}

function createRouteTreeModel() {
    const shuttles = routeGroup('shuttles', 'Shuttles', [
        {kind: 'shuttle', id: 'NORTH', label: 'North Shuttle', color: routeColors.get('NORTH') || '#2563eb'},
        {kind: 'shuttle', id: 'WEST', label: 'West Shuttle', color: routeColors.get('WEST') || '#b45309'}
    ], true);
    const bikes = {kind: 'bikes', id: 'bikes', label: 'Bike locations', color: '#9333ea'};

    if (!cdtaTransit) return [shuttles, routeGroup('cdta', 'CDTA (loading…)', [], true), bikes];

    const byShort = new Map(cdtaTransit.routes.map((route, index) => [route.short, index]));
    const assigned = new Set();
    const routeLeaves = shortNames => shortNames.flatMap(short => {
        const index = byShort.get(short);
        if (index === undefined || assigned.has(index)) return [];
        assigned.add(index);
        const route = cdtaTransit.routes[index];
        return [{kind: 'cdta', id: index, label: `${route.short} · ${route.name}`, color: cdtaColor(route)}];
    });

    const featured = routeLeaves(CDTA_ROUTE_GROUPS.featured);
    const moreTroy = routeLeaves(CDTA_ROUTE_GROUPS.moreTroy);
    const albany = routeLeaves(CDTA_ROUTE_GROUPS.albany);
    const schenectady = routeLeaves(CDTA_ROUTE_GROUPS.schenectady);
    const saratoga = routeLeaves(CDTA_ROUTE_GROUPS.saratoga);
    const glensFalls = routeLeaves(CDTA_ROUTE_GROUPS.glensFalls);
    const remaining = cdtaTransit.routes.flatMap((route, index) => {
        if (assigned.has(index)) return [];
        return [{kind: 'cdta', id: index, label: `${route.short} · ${route.name}`, color: cdtaColor(route)}];
    });

    const nonTroy = [
        routeGroup('albany', 'Albany area', albany),
        routeGroup('schenectady', 'Schenectady area', schenectady),
        routeGroup('saratoga', 'Saratoga / Amsterdam', saratoga),
        routeGroup('glens-falls', 'Glens Falls / North', glensFalls)
    ];
    if (remaining.length) nonTroy.push(routeGroup('other', 'Other routes', remaining));

    return [shuttles, routeGroup('cdta', 'CDTA', [
        ...featured,
        routeGroup('troy-more', 'More Troy / nearby routes', moreTroy),
        routeGroup('non-troy', 'Non-Troy routes', nonTroy)
    ], true), bikes];
}

function routeLeafEnabled(node) {
    if (node.kind === 'bikes') return bikeLocationsEnabled;
    return node.kind === 'shuttle'
        ? selectedShuttleRoutes.has(node.id)
        : selectedCdtaRoutes.has(node.id);
}

function setRouteLeaf(node, enabled) {
    if (node.kind === 'bikes') {
        bikeLocationsEnabled = enabled;
        return;
    }
    const selected = node.kind === 'shuttle' ? selectedShuttleRoutes : selectedCdtaRoutes;
    if (enabled) selected.add(node.id);
    else selected.delete(node.id);
}

function setGroupDescendants(group, enabled) {
    for (const child of group.children) {
        if (child.kind === 'group') setGroupDescendants(child, enabled);
        else setRouteLeaf(child, enabled);
    }
}

function syncRouteTreeCheckboxes() {
    function countSelected(node) {
        if (node.kind !== 'group') {
            node.checkbox.checked = routeLeafEnabled(node);
            return {selected: Number(node.checkbox.checked), total: 1};
        }
        const counts = node.children.map(countSelected);
        const selected = counts.reduce((sum, count) => sum + count.selected, 0);
        const total = counts.reduce((sum, count) => sum + count.total, 0);
        node.checkbox.checked = total > 0 && selected === total;
        node.checkbox.indeterminate = selected > 0 && selected < total;
        node.checkbox.disabled = total === 0;
        node.count.textContent = `${selected}/${total}`;
        return {selected, total};
    }
    routeTreeNodes.forEach(countSelected);
}

function applyRouteSelection() {
    syncShuttleVisibility();
    cdtaDrawLines();
    cdtaDrawStops();
    syncBikeVisibility();
    syncRouteTreeCheckboxes();
}

function renderRouteTree() {
    routeTreeNodes = createRouteTreeModel();
    routeTreeContainer.replaceChildren();

    function buildNode(node) {
        const container = document.createElement('div');
        container.className = `route-tree-node ${node.kind === 'group' ? 'route-tree-group' : ''}`;
        const row = document.createElement('div');
        row.className = 'route-tree-row';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        node.checkbox = checkbox;

        if (node.kind === 'group') {
            const children = document.createElement('div');
            children.className = 'route-tree-children';
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'route-tree-disclosure';
            const isOpen = expandedRouteGroups.get(node.id) ?? node.open;
            children.hidden = !isOpen;
            button.textContent = isOpen ? '▾' : '▸';
            button.setAttribute('aria-expanded', String(isOpen));
            button.setAttribute('aria-label', `Expand or collapse ${node.label}`);
            button.addEventListener('click', () => {
                children.hidden = !children.hidden;
                const expanded = !children.hidden;
                expandedRouteGroups.set(node.id, expanded);
                button.textContent = expanded ? '▾' : '▸';
                button.setAttribute('aria-expanded', String(expanded));
            });
            row.append(button);

            checkbox.addEventListener('change', () => {
                setGroupDescendants(node, checkbox.checked);
                applyRouteSelection();
            });

            const label = document.createElement('label');
            const name = document.createElement('span');
            name.className = 'route-name';
            name.textContent = node.label;
            label.append(checkbox, name);
            row.append(label);

            const count = document.createElement('span');
            count.className = 'route-tree-count';
            node.count = count;
            row.append(count);
            container.append(row);
            node.children.forEach(child => children.append(buildNode(child)));
            container.append(children);
        } else {
            const spacer = document.createElement('span');
            spacer.className = 'route-tree-leaf-spacer';
            row.append(spacer);
            const label = document.createElement('label');
            const color = document.createElement('span');
            color.className = 'route-swatch';
            color.style.backgroundColor = node.color;
            const name = document.createElement('span');
            name.className = 'route-name';
            name.textContent = node.label;
            label.append(checkbox, color, name);
            row.append(label);
            container.append(row);

            checkbox.addEventListener('change', () => {
                setRouteLeaf(node, checkbox.checked);
                applyRouteSelection();
            });
        }
        return container;
    }

    routeTreeNodes.forEach(node => routeTreeContainer.append(buildNode(node)));
    syncRouteTreeCheckboxes();
}

cdtaDateInput.addEventListener('change', () => {
    if (cdtaSelectedMarker && cdtaStopLayer.hasLayer(cdtaSelectedMarker)) {
        cdtaSelectedMarker.setPopupContent(
            cdtaPopup(cdtaTransit.stops[cdtaSelectedStopIndex], cdtaSelectedStopIndex)
        );
    }
});
map.on('moveend zoomend', cdtaDrawStops);

// ---------------------------------------------------------------
// Mobile route-panel drawer (bottom sheet)
// ---------------------------------------------------------------
const panel = document.getElementById('panel');
const routesOpenBtn = document.getElementById('routes-open');
const routesCloseBtn = document.getElementById('routes-close');

function setPanelOpen(open) {
    if (!mobileMq.matches) return;           // no-op on desktop
    
    panel.classList.toggle('open', open);
    document.body.classList.toggle('panel-open', open); // <-- ADD THIS
    
    panel.setAttribute('aria-hidden', String(!open));
    routesOpenBtn.setAttribute('aria-expanded', String(open));
    (open ? routesCloseBtn : routesOpenBtn).focus();

    // If opening routes, close journey panel to avoid overlap
    if (open) {
        const journeyCloseBtn = document.getElementById('journey-close');
        if (journeyCloseBtn) journeyCloseBtn.click();
    }
}

routesOpenBtn.addEventListener('click', () => setPanelOpen(true));
routesCloseBtn.addEventListener('click', () => setPanelOpen(false));
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && mobileMq.matches && panel.classList.contains('open')) {
        setPanelOpen(false);
    }
});
mobileMq.addEventListener('change', () => {
    panel.classList.remove('open');
    routesOpenBtn.setAttribute('aria-expanded', 'false');
    if (mobileMq.matches) panel.setAttribute('aria-hidden', 'true');
    else panel.removeAttribute('aria-hidden');
});
if (mobileMq.matches) panel.setAttribute('aria-hidden', 'true');

renderRouteTree();
initJourneyUi({ map, apiBase: API_BASE, mapboxToken: MAPBOX_TOKEN });
startPolling();
loadCDTA();
loadBikeLocations();
