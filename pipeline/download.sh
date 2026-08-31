#!/usr/bin/env bash
# Downloads input data: ZTM Gdańsk + ZKM Gdynia GTFS feeds, OSM network
# (Overpass), MapLibre GL. Everything is cached — re-running only fetches
# what is missing.
#
# Tricity quirk: TWO feeds (two operators under the MZKZG umbrella) cover one
# agglomeration — ZTM Gdańsk (buses route_type 700, trams 900) and ZKM Gdynia
# (buses 3, trolleybuses 11 since the 18.08.2026 feed; 700/800 before that —
# build.mjs accepts both). build.mjs runs one cfg per feed; line numbers
# are coordinated between operators (only "171" exists in both).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/gtfs-gdansk data/gtfs-gdynia data/osm web/vendor

# A downloaded extract is only accepted if it PARSES and carries a plausible
# number of elements. `grep -q '"elements"'` — the guard this family used
# everywhere — passes on a truncated response too: Brașov's roads arrived as a
# 65 kB fragment that still contained the string, was taken for complete, and
# silently skipped the city (16.08.2026).
# The minimum differs by extract: a road network runs to tens of thousands of
# ways, a tram network to a few hundred, so the caller passes its own floor
# rather than sharing one.
# A rejected file is deleted rather than left behind — the `[ ! -f … ]` gates
# below only ask whether the file exists, so a fragment on disk would be taken
# for a finished download on the next run.
ok_json () { # $1=file  $2=minimum element count
  python3 - "$1" "$2" <<'PYEOF' 2>/dev/null
import json, sys
try:
    sys.exit(0 if len(json.load(open(sys.argv[1])).get("elements", [])) >= int(sys.argv[2]) else 1)
except Exception:
    sys.exit(1)
PYEOF
}

# 1a) GTFS — ZTM Gdańsk (buses + trams)
if [ ! -f data/gtfs-gdansk/routes.txt ]; then
  echo "== ZTM Gdańsk GTFS =="
  curl -fL --retry 3 --max-time 600 -o data/ztm_gdansk_gtfs.zip \
    "https://ckan.multimediagdansk.pl/dataset/c24aa637-3619-4dc2-a171-a23eec8f2172/resource/30e783e4-2bec-4a7d-bb22-ee3e3b26ca96/download/gtfsgoogle.zip"
  unzip -o data/ztm_gdansk_gtfs.zip -d data/gtfs-gdansk
fi

# 1b) GTFS — ZKM Gdynia (buses + trolleybuses)
if [ ! -f data/gtfs-gdynia/routes.txt ]; then
  echo "== ZKM Gdynia GTFS =="
  curl -fL --retry 3 --max-time 600 -o data/zkm_gdynia_gtfs.zip \
    "https://api.zdiz.gdynia.pl/pt/gtfs.zip"
  unzip -o data/zkm_gdynia_gtfs.zip -d data/gtfs-gdynia
fi

# 1c) GTFS — MZK Wejherowo (city buses of Wejherowo/Reda + villages west);
#     the operator publishes no GTFS of its own — mkuran.pl generates one
if [ ! -f data/gtfs-wejherowo/routes.txt ]; then
  echo "== MZK Wejherowo GTFS =="
  curl -fL --retry 3 --max-time 600 -o data/mzk_wejherowo_gtfs.zip \
    "https://mkuran.pl/gtfs/wejherowo.zip"
  unzip -o data/mzk_wejherowo_gtfs.zip -d data/gtfs-wejherowo
fi

# 2) OSM — roadways over the three networks (GTFS stops extent + margin: MZK
#    lines reach Gościcino, Orle, Kębłowo and Gowino west of Wejherowo, ZTM
#    lines reach Pruszcz Gdański in the south), incl. highway=construction
if [ ! -f data/osm/trojmiasto.json ]; then
  echo "== Overpass (roads) =="
  Q='[out:json][timeout:900];way(54.21,18.04,54.66,18.97)["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|busway|construction|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"];out geom;'
  ok=0
  for EP in "https://overpass-api.de/api/interpreter" \
            "https://maps.mail.ru/osm/tools/overpass/api/interpreter" \
            "https://overpass.kumi.systems/api/interpreter"; do
    echo "-- $EP"
    if curl -fsS --max-time 900 -o data/osm/trojmiasto.json --data-urlencode "data=$Q" "$EP" \
       && ok_json "data/osm/trojmiasto.json" 2000; then
      ok=1; break
    fi
  done
  [ "$ok" = 1 ] || { rm -f data/osm/trojmiasto.json; echo "Overpass: all mirrors failed" >&2; exit 1; }
fi

# 2b) OSM — tram tracks (separate network: railway=tram, not roadways). Trams
#     run only in Gdańsk; the bbox covers the network incl. the Nowa Wałowa
#     works and all depots.
if [ ! -f data/osm/trojmiasto-tram.json ]; then
  echo "== Overpass (trams) =="
  QT='[out:json][timeout:300];way(54.29,18.53,54.45,18.71)["railway"~"^(tram|light_rail)$"];out geom;'
  ok=0
  for EP in "https://overpass-api.de/api/interpreter" \
            "https://maps.mail.ru/osm/tools/overpass/api/interpreter" \
            "https://overpass.kumi.systems/api/interpreter"; do
    echo "-- $EP"
    if curl -fsS --max-time 300 -o data/osm/trojmiasto-tram.json --data-urlencode "data=$QT" "$EP" \
       && ok_json "data/osm/trojmiasto-tram.json" 40; then
      ok=1; break
    fi
  done
  [ "$ok" = 1 ] || { rm -f data/osm/trojmiasto-tram.json; echo "Overpass (tram): all mirrors failed" >&2; exit 1; }
fi

# 3) MapLibre GL (vendored, no CDN at runtime)
if [ ! -f web/vendor/maplibre-gl.js ]; then
  echo "== MapLibre GL =="
  curl -fL --retry 3 -o web/vendor/maplibre-gl.js  https://unpkg.com/maplibre-gl@5.6.1/dist/maplibre-gl.js
  curl -fL --retry 3 -o web/vendor/maplibre-gl.css https://unpkg.com/maplibre-gl@5.6.1/dist/maplibre-gl.css
fi

echo "OK — data ready:"
du -sh data/ztm_gdansk_gtfs.zip data/zkm_gdynia_gtfs.zip data/osm/trojmiasto.json data/osm/trojmiasto-tram.json web/vendor/maplibre-gl.js 2>/dev/null || true
