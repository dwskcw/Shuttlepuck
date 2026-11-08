import {
    LeafletMap, TileLayer, Polyline, CircleMarker, Marker, DivIcon,
    LayerGroup, LatLngBounds
} from 'leaflet';
import { initJourneyUi } from './js/journey-ui.js';

// ---------------------------------------------------------------
// Config
// ---------------------------------------------------------------
// By default, call /api/* on the server that served this page (use with
// dev-server.mjs, which proxies to Shubble). Set ?api=<url> to override it.
const params = new URLSearchParams(location.search);
const apiParam = params.get('api');
const API_BASE = !apiParam || apiParam === 'same-origin'
    ? ''
    : apiParam.replace(/\/$/, '');
const POLL_MS = 5000;            // same cadence as the Shubble frontend
const OFF_ROUTE_COLOR = '#666666';

// ---------------------------------------------------------------
// Map + base tiles
// ---------------------------------------------------------------
const map = new LeafletMap('map', {
    center: [42.730, -73.677],
    zoom: 17
});

const MAPBOX_TILES_URL = 'https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/512/{z}/{x}/{y}@2x?access_token=pk.eyJ1IjoiZHdza2N3IiwiYSI6ImNtdzZyd3d3ZzBpY2IzMG9wc28weXNsbHgifQ.9zT3RQw_K7LbSSYeJXxPNg';

// The Mapbox token that loads the base tiles also drives the walking
// directions used by the trip planner (Directions + Matrix APIs).
const MAPBOX_TOKEN = new URLSearchParams(MAPBOX_TILES_URL.split('?')[1] ?? '').get('access_token') ?? '';

// Standby OSM layer. Not added to the map unless Mapbox starts failing.
const fallbackTiles = new TileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    minZoom: 3,
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
});

const tiles = new TileLayer(MAPBOX_TILES_URL, {
    tileSize: 512,
    zoomOffset: -1,
    maxZoom: 22,
    attribution:
        '© <a href="https://www.mapbox.com/about/maps/">Mapbox</a> ' +
        '© <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>'
});
tiles.addTo(map);

// ---------------------------------------------------------------
// Automatic base-tile fallback
//
// Mapbox rate limits (403/429) and outages surface as `tileerror`
// events on the layer. The old leaflet.tilelayer.fallback plugin
// only reacts to HTTP 404, so it can't help here — and it also
// requires a global `L`, which we don't have (Leaflet is loaded via
// an import map as an ES module).
//
// Instead: count consecutive tile errors on the Mapbox layer and,
// once we cross the threshold, swap in the OSM standby layer. A
// successful `tileload` resets the counter so a single transient
// blip never triggers the switch.
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
