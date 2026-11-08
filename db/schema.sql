-- Tiger Data schema for the RPI multimodal transit map.
--
-- Applied with:  psql "$TIGER_DATABASE_URL" -f db/schema.sql
--
-- Design notes:
--   * Static reference data (GTFS, shuttle routes/schedule, bike docks) uses
--     plain, readable tables. We keep CDTA's GTFS ids as TEXT so joins against
--     future feed refreshes stay stable.
--   * Live shuttle GPS pings go into a TimescaleDB hypertable: that is the
--     table that grows forever and the reason Tiger/TimescaleDB earns its
--     place here (time-partitioned storage, fast time-window queries).
--   * A continuous aggregate precomputes "how long does the shuttle take
--     between stop pairs at each hour of day" from accumulated pings — the
--     sponsor-visible analytics payoff, kept up to date automatically.

-- --------------------------------------------------------------- CDTA (GTFS)
CREATE TABLE IF NOT EXISTS cdta_routes (
    route_id     TEXT PRIMARY KEY,        -- GTFS route_id, e.g. '87'
    short_name   TEXT NOT NULL,           -- displayed number
    long_name    TEXT NOT NULL,
    color        TEXT NOT NULL DEFAULT '123573',
    sort_order   INTEGER
);

CREATE TABLE IF NOT EXISTS cdta_stops (
    stop_id      TEXT PRIMARY KEY,        -- GTFS stop_id, e.g. '07216'
    name         TEXT NOT NULL,
    lat          DOUBLE PRECISION NOT NULL,
    lon          DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS cdta_services (
    service_id   TEXT PRIMARY KEY,
    monday       BOOLEAN NOT NULL,        -- GTFS calendar flags...
    tuesday      BOOLEAN NOT NULL,
    wednesday    BOOLEAN NOT NULL,
    thursday     BOOLEAN NOT NULL,
    friday       BOOLEAN NOT NULL,
    saturday     BOOLEAN NOT NULL,
    sunday       BOOLEAN NOT NULL,
    start_date   INTEGER NOT NULL,        -- YYYYMMDD
    end_date     INTEGER NOT NULL
);

-- calendar_dates.txt exceptions: 1 = service added on this date,
-- 2 = service removed on this date.
CREATE TABLE IF NOT EXISTS cdta_service_exceptions (
    service_id    TEXT NOT NULL REFERENCES cdta_services(service_id),
    date          INTEGER NOT NULL,      -- YYYYMMDD
    exception_type INTEGER NOT NULL,
    PRIMARY KEY (service_id, date)
);

CREATE TABLE IF NOT EXISTS cdta_trips (
    trip_id      TEXT PRIMARY KEY,
    route_id     TEXT NOT NULL REFERENCES cdta_routes(route_id),
    service_id   TEXT NOT NULL REFERENCES cdta_services(service_id),
    headsign     TEXT NOT NULL,
    direction_id SMALLINT
);

CREATE TABLE IF NOT EXISTS cdta_stop_times (
    trip_id        TEXT NOT NULL REFERENCES cdta_trips(trip_id),
    stop_sequence  INTEGER NOT NULL,
    stop_id        TEXT NOT NULL REFERENCES cdta_stops(stop_id),
    departure_sec  INTEGER NOT NULL,     -- seconds since (service-day) midnight;
                                         -- GTFS allows values past 24h, so no
                                         -- timestamp type here on purpose
    PRIMARY KEY (trip_id, stop_sequence)
);
CREATE INDEX IF NOT EXISTS idx_stop_times_stop
    ON cdta_stop_times (stop_id, departure_sec);

-- --------------------------------------------------------------- shuttles
CREATE TABLE IF NOT EXISTS shuttle_routes (
    route_key    TEXT PRIMARY KEY,        -- 'NORTH' | 'WEST'
    name         TEXT NOT NULL,
    color        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shuttle_stops (
    stop_key     TEXT PRIMARY KEY,        -- e.g. 'STUDENT_UNION'
    name         TEXT NOT NULL,
    lat          DOUBLE PRECISION NOT NULL,
    lon          DOUBLE PRECISION NOT NULL,
    -- Minutes after the loop's Student Union departure, per route; a stop the
    -- route skips is simply absent from that route's row.
    north_offset_min INTEGER,
    west_offset_min INTEGER
);

-- One row per scheduled bus departure from Student Union.
CREATE TABLE IF NOT EXISTS shuttle_departures (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    route_key   TEXT NOT NULL REFERENCES shuttle_routes(route_key),
    day_type    TEXT NOT NULL CHECK (day_type IN ('weekday', 'saturday', 'sunday')),
    start_min   INTEGER NOT NULL         -- minutes since midnight, Troy time
);
CREATE INDEX IF NOT EXISTS idx_shuttle_departures
    ON shuttle_departures (day_type, start_min);

-- --------------------------------------------------------------- live GPS
-- The hypertable: one row per vehicle position report (about one per vehicle
-- per 5 s while shuttles run). This is the table TimescaleDB partitions by
-- time, and everything the demo queries flows through it.
--
-- near_stop is filled by the recorder (db/record-shuttles.mjs): the shuttle
-- stop the vehicle is closest to at that moment, or NULL when it is away from
-- any stop. Matching at ingest keeps the analytics below window-function-free
-- and therefore CAGG-compatible.
CREATE TABLE IF NOT EXISTS shuttle_positions (
    recorded_at  TIMESTAMPTZ NOT NULL,
    vehicle_id   TEXT NOT NULL,          -- shuttle API's opaque vehicle id
    vehicle_name TEXT,                   -- fleet number, e.g. '500'
    route_key    TEXT,                   -- 'NORTH'/'WEST' when matched, else NULL
    near_stop    TEXT,                   -- shuttle_stops.stop_key or NULL
    lat          DOUBLE PRECISION NOT NULL,
    lon          DOUBLE PRECISION NOT NULL,
    speed_mph    REAL,
    heading_deg  REAL
);
SELECT create_hypertable('shuttle_positions', 'recorded_at',
                         if_not_exists => TRUE, migrate_data => TRUE);
CREATE INDEX IF NOT EXISTS idx_positions_vehicle
    ON shuttle_positions (vehicle_id, recorded_at DESC);

-- --------------------------------------------------------------- bike docks
CREATE TABLE IF NOT EXISTS bike_docks (
    id        INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name      TEXT NOT NULL,
    capacity  INTEGER,
    lat       DOUBLE PRECISION NOT NULL,
    lon       DOUBLE PRECISION NOT NULL,
    UNIQUE (name, lat, lon)            -- geojson refreshes repeat the same racks
);

-- --------------------------------------------------------------- analytics
-- Two layers, kept simple on purpose:
--
-- 1. shuttle_position_stops (continuous aggregate): one row per vehicle per
--    minute with the last stop it was near. Continuous aggregates cannot
--    contain window functions, so the stop-to-stop segmentation happens one
--    layer up, where `last()` (a CAGG-supported hyperfunction) is enough.
-- 2. shuttle_travel_times (a normal view): LAG pairs consecutive minute rows
--    of the same vehicle, keeping only real stop-to-stop transitions, and
--    reports the median minutes per route/pair/hour. Query-time aggregation
--    is plenty at hackathon data volumes; if it ever grows, this view is
--    where an approximate-percentile CAGG would slot in.
CREATE MATERIALIZED VIEW IF NOT EXISTS shuttle_position_stops
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 minute', recorded_at) AS bucket,
    vehicle_id,
    last(route_key, recorded_at) AS route_key,
    last(near_stop, recorded_at) AS near_stop,
    last(lat, recorded_at) AS lat,
    last(lon, recorded_at) AS lon
FROM shuttle_positions
GROUP BY bucket, vehicle_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('shuttle_position_stops',
    start_offset      => INTERVAL '2 days',
    end_offset        => INTERVAL '1 minute',
    schedule_interval => INTERVAL '5 minutes',
    if_not_exists     => TRUE);

CREATE VIEW IF NOT EXISTS shuttle_travel_times AS
WITH pairs AS (
    SELECT
        route_key,
        near_stop AS from_stop,
        LEAD(near_stop) OVER (PARTITION BY vehicle_id ORDER BY bucket) AS to_stop,
        LEAD(bucket)    OVER (PARTITION BY vehicle_id ORDER BY bucket) AS next_bucket,
        bucket
    FROM shuttle_position_stops
    WHERE near_stop IS NOT NULL
)
SELECT
    route_key,
    from_stop,
    to_stop,
    EXTRACT(hour FROM bucket) AS hour_of_day,
    COUNT(*) AS samples,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY minutes) AS median_min
FROM (
    SELECT *,
        EXTRACT(epoch FROM (next_bucket - bucket)) / 60.0 AS minutes
    FROM pairs
) seg
WHERE to_stop IS NOT NULL
  AND to_stop <> from_stop
  AND minutes BETWEEN 0.2 AND 10   -- ignore gaps (parked, garage, signal loss)
GROUP BY route_key, from_stop, to_stop, hour_of_day;
