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

## Two views of the same network

The panel's first control switches how the strokes are drawn. Both views are
built from the same files and the switch is layers and paint, never a reload —
position, zoom, the picked line and the label sizes all survive it.

- **Corridors** (default, the map as it has always been) — one stroke per
  roadway whatever rides there, the whole network in three mode colours, with
  the aggregated number row beside every street.
- **Lines** — the same data drawn line by line, on a flat grey base: a roadway
  carrying **up to 4 lines** is drawn once **per line**, four coloured strands
  side by side with each number beside its own strand; a roadway carrying
  **5 or more** collapses to **one grey trunk** whose numbers still keep each
  line's colour, because that is where the reader loses the strands. On this
  network that is 77 % of the length coloured (1259 bundles) and 23 % grey
  (611 trunks); 191 of the 192 lines appear as their own strand somewhere.
  Picking a line repaints the trunks it rides through in its colour, so it stays
  traceable end to end.

`npm run lines` builds the second view (`pipeline/lines.mjs`, ~20 s, reads the
finished network and writes only new `lines-*` files — it never rewrites
anything `build.mjs` produced). `npm run audit` checks the result against the
source: coverage per line, offsets at every handover, strokes that stop where the
line goes on, corners an offset stroke would fold over, and whether everything is
named.

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
