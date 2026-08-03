# trojmiasto-bus-map

Interactive web map of Tricity (Gdańsk–Sopot–Gdynia) public transport in the
visual logic of a classic printed network map: **163 bus lines,
17 trolleybus lines and 11 tram lines (ZTM Gdańsk + ZKM
Gdynia)** drawn exactly along roadways and tram tracks (own HMM/Viterbi map
matching on an OSM graph), line numbers written parallel to every street they
use, labeled stops, true roundabout arcs.

Sixth city of the family, alongside
[krakow-bus-map](https://github.com/Miqell24/krakow-bus-map),
[athens-bus-map](https://github.com/Miqell24/athens-bus-map),
[thessaloniki-bus-map](https://github.com/Miqell24/thessaloniki-bus-map),
[poznan-bus-map](https://github.com/Miqell24/poznan-bus-map) and
[gzm-bus-map](https://github.com/Miqell24/gzm-bus-map) — same pipeline and same
visual system, different city and feeds.

## Features

- GTFS matched onto the OSM road and tram network — weighted mean error
  **1.21 m** over 4 820 km of drawn route.
- **Two operators, one map**: ZTM Gdańsk (buses `route_type` 700, trams 900)
  and ZKM Gdynia (buses 700, trolleybuses 800) are separate feeds under the
  MZKZG umbrella; the pipeline runs one cfg per feed into the same shared
  files, and geometric stop/badge clustering fuses the operators at the Sopot
  seam. Line numbering is coordinated between them (only "171" exists in both).
  Trolleybus lines are drawn green; trams match on `railway=tram`.
- KMK-style rendering: one stroke per roadway, aggregated line numbers rotated
  parallel to streets, shared bus+tram corridors get a two-color number row,
  half-disc stops turned to their side of the street, termini with boxed line
  badges that fuse into one complex when they would collide at the current zoom.
- "Paper map" recolor of the base map: warm districts, green parks, real-blue
  water, pale-yellow motorways.
- Panel with mode visibility filters and a clickable line list (click a line to
  see its route with all stops).
- Three PNG exports: current view (WYSIWYG), selected area (poster-grade), and
  the whole network as one print-quality poster.
- GTFS shapes.txt quality report (`npm run report` → `data/gtfs-gaps-report.md`).

## Requirements

Node ≥ 18 (no npm dependencies), `curl`, `unzip`, internet on first run.

## Usage

```bash
npm run download   # ZTM Gdańsk + ZKM Gdynia GTFS + OSM (Overpass) + MapLibre
npm run build      # extraction + map matching + GeoJSON files into data/out/
npm run serve      # http://localhost:8129
```

To pull fresh feeds:

```bash
rm -rf data/gtfs-gdansk data/gtfs-gdynia data/*.zip && npm run download && npm run build
```

## Structure

- `pipeline/download.sh` — input data download
- `pipeline/build.mjs` — GTFS → OSM graph → HMM/Viterbi → `data/out/*.geojson`
- `pipeline/lib/` — csv (streaming), geo (local projection), graph (graph + Dijkstra), hmm (Viterbi)
- `pipeline/report-gaps.mjs` — GTFS shapes.txt gap report
- `web/` — MapLibre GL frontend (vendored, OpenFreeMap positron tiles)
- `docs/` — static bundle published via GitHub Pages (web + data/out copies)

## Data attribution

Map data © OpenStreetMap contributors · tiles by OpenFreeMap · timetables: GTFS
ZTM Gdańsk (ckan.multimediagdansk.pl) · ZKM Gdynia (api.zdiz.gdynia.pl).
