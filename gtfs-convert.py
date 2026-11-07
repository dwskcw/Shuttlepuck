#!/usr/bin/env python3
"""Helper script converting CDTA's GTFS data into JSON for shubble-map.html

    Usage: python3 build_cdta.py [optional path/to/gtfs] [optional path/to/output]
        By default the unzipped gtfs folder from CDTA should be in data, 
            and output appears in the current directory

Produces:
    cdta-transit.json: route lines, stops, service calendar
        Smaller file loaded at startup
    cdta-departures.json: scheduled departures per stop
        Loaded when the stops checkbox is selected

CDTA states they update this data around 4-6 times a year.
"""
import csv
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

GTFS_DIR = Path(sys.argv[1] if len(sys.argv) > 1 else 'data2')
OUT_DIR = Path(sys.argv[2] if len(sys.argv) > 2 else '.')

# Point used to order routes by how close they run to campus (RPI Student Union).
CAMPUS = (42.730, -73.677)

SIMPLIFY_M = 2.0     # Douglas-Peucker tolerance for route lines, in meters
COVER_M = 30.0       # a shape point within this distance of a kept shape counts as "already drawn"
MIN_NEW_POINTS = 8   # a shape is kept if at least this many of its points are not already drawn


def read(name):
    with open(GTFS_DIR / name, newline='', encoding='utf-8-sig') as f:
        yield from csv.DictReader(f)


# Latitude and longitude to xy-coordinates
def to_xy(lat, lon, lat0):
    return ((lon * math.cos(math.radians(lat0)) * 111320.0), lat * 110540.0)

# Provides the distance between two points
def distance_km(a, b):
    lat0 = (a[0] + b[0]) / 2
    ax, ay = to_xy(a[0], a[1], lat0)
    bx, by = to_xy(b[0], b[1], lat0)
    return math.hypot(ax - bx, ay - by) / 1000.0


def simplify(points, tol_m):
    """Douglas-Peucker on [(lat, lon), ...], iterative."""
    if len(points) < 3:
        return points
    lat0 = points[0][0]
    xy = [to_xy(la, lo, lat0) for la, lo in points]
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        (x1, y1), (x2, y2) = xy[i], xy[j]
        dx, dy = x2 - x1, y2 - y1
        seg = dx * dx + dy * dy
        far, far_d = -1, 0.0
        for k in range(i + 1, j):
            px, py = xy[k]
            if seg == 0:
                d = math.hypot(px - x1, py - y1)
            else:
                t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / seg))
                d = math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
            if d > far_d:
                far, far_d = k, d
        if far_d > tol_m:
            keep[far] = True
            stack += [(i, far), (far, j)]
    return [p for p, k in zip(points, keep) if k]


def encode_polyline(points):
    """Google encoded polyline, precision 5."""
    out, prev_lat, prev_lon = [], 0, 0
    for lat, lon in points:
        ilat, ilon = round(lat * 1e5), round(lon * 1e5)
        for v in (ilat - prev_lat, ilon - prev_lon):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        prev_lat, prev_lon = ilat, ilon
    return ''.join(out)


class Coverage:
    """Spatial hash of points already drawn for one route."""
    def __init__(self):
        self.cells = defaultdict(list)

    @staticmethod
    def _key(x, y):
        return int(x // COVER_M), int(y // COVER_M)

    def add(self, xy):
        for x, y in xy:
            self.cells[self._key(x, y)].append((x, y))

    def covered(self, x, y):
        cx, cy = self._key(x, y)
        for i in (cx - 1, cx, cx + 1):
            for j in (cy - 1, cy, cy + 1):
                for px, py in self.cells.get((i, j), ()):
                    if math.hypot(px - x, py - y) <= COVER_M:
                        return True
        return False


# ---------------------------------------------------------------- load
print(f'Reading GTFS from {GTFS_DIR.resolve()}')
routes_txt = {r['route_id']: r for r in read('routes.txt')}
trips = {t['trip_id']: t for t in read('trips.txt')}
stops_txt = {s['stop_id']: s for s in read('stops.txt')}

shapes = defaultdict(list)
for r in read('shapes.txt'):
    shapes[r['shape_id']].append((int(r['shape_pt_sequence']), float(r['shape_pt_lat']), float(r['shape_pt_lon'])))
for sid in shapes:
    shapes[sid].sort()
    shapes[sid] = [(la, lo) for _, la, lo in shapes[sid]]

# ---------------------------------------------------------------- stop times -> departures
def secs(s):
    h, m, x = s.split(':')
    return int(h) * 3600 + int(m) * 60 + int(x)

groups = defaultdict(list)             # (stop_id, service_id, route_id, headsign) -> [minutes]
route_stops = defaultdict(set)         # route_id -> {stop_id}

def flush(rows):
    for i, (trip_id, stop_id, dep, pickup) in enumerate(rows):
        t = trips[trip_id]
        route_stops[t['route_id']].add(stop_id)
        # The last stop of a trip, or a stop with no pickup, isn't a departure.
        if i == len(rows) - 1 or pickup == '1':
            continue
        groups[(stop_id, t['service_id'], t['route_id'], t['trip_headsign'])].append(dep // 60)

rows, current = [], None
trips_seen = set()
for r in read('stop_times.txt'):
    tid = r['trip_id']
    if tid != current:
        assert tid not in trips_seen, 'stop_times.txt is not grouped by trip_id'
        if rows:
            flush(rows)
        rows, current = [], tid
        trips_seen.add(tid)
    rows.append((tid, r['stop_id'], secs(r['departure_time'] or r['arrival_time']), r['pickup_type']))
if rows:
    flush(rows)
print(f'{len(groups):,} departure groups from {len(trips_seen):,} trips')

# ---------------------------------------------------------------- routes + lines
trip_count = defaultdict(Counter)      # route_id -> Counter(shape_id)
for t in trips.values():
    if t['shape_id']:
        trip_count[t['route_id']][t['shape_id']] += 1

def route_lines(route_id):
    cover, lines = Coverage(), []
    for shape_id, _ in trip_count[route_id].most_common():
        pts = shapes.get(shape_id)
        if not pts:
            continue
        # One shared projection origin so the coverage hash is consistent across shapes.
        xy = [to_xy(la, lo, CAMPUS[0]) for la, lo in pts]
        new = sum(1 for x, y in xy if not cover.covered(x, y))
        if lines and new < MIN_NEW_POINTS:
            continue
        cover.add(xy)
        lines.append(encode_polyline(simplify(pts, SIMPLIFY_M)))
    return lines

def route_distance_km(route_id):
    best = min(distance_km(CAMPUS, (float(stops_txt[s]['stop_lat']), float(stops_txt[s]['stop_lon'])))
               for s in route_stops[route_id])
    return round(best, 2)

route_ids = [rid for rid in routes_txt if rid in route_stops]
route_ids.sort(key=lambda rid: (route_distance_km(rid), int(routes_txt[rid]['route_sort_order'] or 0)))
route_idx = {rid: i for i, rid in enumerate(route_ids)}

routes_out = []
for rid in route_ids:
    r = routes_txt[rid]
    routes_out.append({
        'id': rid,
        'short': r['route_short_name'],
        'name': r['route_long_name'],
        'color': r['route_color'] or '123573',
        'km': route_distance_km(rid),
        'lines': route_lines(rid),
    })

# ---------------------------------------------------------------- stops
stop_ids = sorted(s for s in stops_txt if any(s in rs for rs in route_stops.values()))
stop_idx = {sid: i for i, sid in enumerate(stop_ids)}
stop_routes = defaultdict(set)
for rid, ss in route_stops.items():
    for sid in ss:
        stop_routes[sid].add(route_idx[rid])
stops_out = [[sid, stops_txt[sid]['stop_name'],
              round(float(stops_txt[sid]['stop_lat']), 5), round(float(stops_txt[sid]['stop_lon']), 5),
              sorted(stop_routes[sid])] for sid in stop_ids]

# ---------------------------------------------------------------- service calendar
calendar = {r['service_id']: r for r in read('calendar.txt')}
exceptions_raw = list(read('calendar_dates.txt'))
service_ids = sorted(set(calendar) | {e['service_id'] for e in exceptions_raw} | {t['service_id'] for t in trips.values()})
service_idx = {s: i for i, s in enumerate(service_ids)}
services_out = []
for sid in service_ids:
    c = calendar.get(sid)
    if c:
        days = ''.join(c[d] for d in ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'))
        services_out.append([days, int(c['start_date']), int(c['end_date'])])
    else:  # only ever added by an exception
        services_out.append(['0000000', 0, 0])
exceptions_out = defaultdict(list)
for e in exceptions_raw:
    exceptions_out[e['date']].append([service_idx[e['service_id']], int(e['exception_type'])])

feed = next(iter(read('feed_info.txt')), {})
transit = {
    'feed': {
        'publisher': feed.get('feed_publisher_name', 'CDTA'),
        'url': feed.get('feed_publisher_url', 'https://www.cdta.org/developer'),
        'start': feed.get('feed_start_date', ''),
        'end': feed.get('feed_end_date', ''),
    },
    'routes': routes_out,
    'stops': stops_out,
    'services': services_out,
    'exceptions': exceptions_out,
}

# ---------------------------------------------------------------- departures file
headsigns = sorted({k[3] for k in groups})
headsign_idx = {h: i for i, h in enumerate(headsigns)}
by_stop = defaultdict(list)
for (stop_id, service_id, route_id, headsign), minutes in groups.items():
    minutes.sort()
    deltas = [minutes[0]] + [b - a for a, b in zip(minutes, minutes[1:])]
    by_stop[stop_idx[stop_id]].append([service_idx[service_id], route_idx[route_id], headsign_idx[headsign], deltas])
departures = {'headsigns': headsigns, 'stops': by_stop}

# Write cdta-transit and cdta-departures
OUT_DIR.mkdir(parents=True, exist_ok=True)
for name, data in (('cdta-transit.json', transit), ('cdta-departures.json', departures)):
    path = OUT_DIR / name
    path.write_text(json.dumps(data, separators=(',', ':'), ensure_ascii=False), encoding='utf-8')
    print(f'wrote {path}  ({path.stat().st_size / 1e6:.2f} MB)')

print(f'{len(routes_out)} routes, {len(stops_out):,} stops, '
      f'{sum(len(r["lines"]) for r in routes_out)} line shapes')