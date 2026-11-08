# Proposed HackRPI 2026 Project
By Stanley Liu, Akshat Prakash, Evan Snyder, and James Tarantino

Our project aims to provide RPI students with a unified interface for locally available alternate modes of transportation. Its target audience is both students that don't have a car on campus, and anyone looking to reduce their carbon footprint by avoiding driving.

Our idea is original in that nobody else has attempted to combine the routes and live locations of RPI shuttles with CDTA buses. (CDTA live location is not supported, as their process for getting API keys is not automated.) We combine these options with the CDPHP bike rack locations to better demonstrate the range of locations students can get to for free.

Another interesting angle is our navigation that combines modes of transportation. It's now easier for students, for example, to plan on taking the shuttle to a downtown bus stop. 

## Running it

```bash
npm install                          # once (only dependency: pg, for Tiger Data)
node planner/build-planner-data.mjs  # rebuild the trip-planner data bundle
node dev-server.mjs                  # then open http://localhost:3001/
```

## Trip planner (multimodal navigation)

The 🧭 Directions button on the map opens the planner:

1. Click **Set origin**, then click the map; repeat for **Set destination** (markers are draggable).
2. Optionally change the departure time (defaults to now, Troy time).
3. **Find routes** lists itineraries that chain walking, RPI shuttles, and CDTA buses — with real departure times, wait times, and transfers — and draws the chosen one on the map.

How it works, in one paragraph each:

- `planner/build-planner-data.mjs` precomputes `planner/planner-data.json` from the raw sources in `data/` (GTFS text files, shuttle schedule/routes, bike docks). Shuttle stop times come from each stop's documented route offset in minutes; CDTA trips are grouped into readable "patterns" (same stop sequence ⇒ one pattern with a list of departure times and service days).
- `js/journey.js` runs a small RAPTOR-style search in the browser: each round boards one more vehicle, short stop-to-stop footpaths connect the shuttle network to the CDTA network (e.g. City Station shuttle stop ↔ the CDTA stop 57 m away), and every round yields one option so a 14-minute walk can be compared against a wait-for-the-shuttle option honestly.
- `js/journey-ui.js` handles the panel: click-to-set endpoints, Mapbox walking times for the nearest stops (Directions Matrix API, same token as the base tiles; falls back to straight-line estimates offline), leg-by-leg cards, and map drawing.

Tests: `node --test` covers the time helpers, the build script, and the search (a synthetic two-route scenario plus a real-data sanity check).

## Tiger Data (sponsor integration)

The same data lives in a managed Tiger Data Postgres service, and the live shuttle feed accumulates there as time-series data:

- `db/schema.sql` — CDTA GTFS tables, shuttle routes/stops/departures, bike docks, plus a `shuttle_positions` **hypertable** (one row per GPS ping, time-partitioned) and analytics on top: a continuous aggregate collapses pings to one row per vehicle-minute, and a `shuttle_travel_times` view derives *median travel minutes between shuttle stop pairs by hour of day* from real accumulated GPS history.
- `db/load.mjs` — loads the repo data into your service (idempotent; re-runs truncate and reload).
- `db/record-shuttles.mjs` — polls the public shuttle locations API and records pings; leave it running during the hackathon and the travel-time view fills in with real history.

Setup:

```bash
cp .env.example .env                 # then paste your service's connection string
node --env-file=.env db/apply-schema.mjs           # create tables + hypertable + analytics (no psql needed)
node --env-file=.env db/load.mjs                   # load GTFS, shuttles, docks (idempotent)
node --env-file=.env db/record-shuttles.mjs &      # start accumulating GPS history
node --env-file=.env dev-server.mjs                # enables /api/db/* read endpoints
```

(Equivalently, `psql "$TIGER_DATABASE_URL" -f db/schema.sql` applies the schema if you prefer psql. The loader refuses to run before the schema exists and tells you so.)

With credentials set, `GET /api/db/shuttle-travel-times` serves the hour-by-hour travel-time table and `GET /api/db/shuttle-activity?hours=2` the recent pings-per-minute sparkline data — the demo line for judges: *"the planner knows how long the shuttle actually takes to downtown at this hour, because it has been watching."* Without credentials everything still works from local JSON; the map degrades gracefully.
