import csv, json, math, sys

OLD_PATH = "bikedata.geojson"
MATCH_METERS = 30          # tune to 20 for stricter, 40 for looser
R_EARTH = 6371000.0

def haversine(a, b):
    lat1, lon1 = a; lat2, lon2 = b
    p = math.pi / 180
    dlat = (lat2 - lat1) * p
    dlon = (lon2 - lon1) * p
    h = math.sin(dlat/2)**2 + math.cos(lat1*p)*math.cos(lat2*p)*math.sin(dlon/2)**2
    return 2 * R_EARTH * math.asin(math.sqrt(h))

def load_new(path):
    if path.endswith(".csv"):
        with open(path) as f:
            return [(float(r["longitude"]), float(r["latitude"]))
                    for r in csv.DictReader(f)]
    return [tuple(x) for x in json.load(open(path))]

def load_old(path):
    data = json.load(open(path))
    return [(f["geometry"]["coordinates"], f) for f in data["features"]
            if f.get("geometry", {}).get("type") == "Point"]

def main(new_path, out_path):
    new = load_new(new_path)
    old = load_old(OLD_PATH)
    assert len(new) == 107, f"expected 107 new points, got {len(new)}"

    features = []
    matched = 0
    for i, (lon, lat) in enumerate(new):
        best = None
        for (ocoords, ofeat) in old:
            d = haversine((lat, lon), (ocoords[1], ocoords[0]))
            if best is None or d < best[0]:
                best = (d, ofeat)
        props = {"amenity": "bicycle_rental"}
        fid = f"mapbox/{i}"
        if best and best[0] <= MATCH_METERS:
            matched += 1
            src = best[1]
            # copy every old property, then stamp provenance
            props = dict(src.get("properties") or {})
            props.setdefault("amenity", "bicycle_rental")
            props["source"] = "osm+mapbox"
            props["matched_osm_id"] = src.get("id") or props.get("@id", "")
            fid = src.get("id") or fid
        else:
            props["source"] = "mapbox"
        features.append({
            "type": "Feature",
            "id": fid,
            "properties": props,
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
        })

    fc = {
        "type": "FeatureCollection",
        "generator": "merge_bikes.py",
        "features": features,
    }
    json.dump(fc, open(out_path, "w"), indent=2)
    print(f"wrote {len(features)} features, {matched} matched to old, "
          f"{len(features) - matched} new stubs")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "bikedata.geojson")
