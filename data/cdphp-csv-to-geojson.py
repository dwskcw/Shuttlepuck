import csv, json

rows = list(csv.DictReader(open("all-cdphp-racks.csv")))
features = [{
    "type": "Feature",
    "properties": {"station_id": r["station_id"]},
    "geometry": {
        "type": "Point",
        "coordinates": [float(r["longitude"]), float(r["latitude"])]
    }
} for r in rows]

json.dump({"type": "FeatureCollection", "features": features},
          open("racks.geojson", "w"), indent=2)
