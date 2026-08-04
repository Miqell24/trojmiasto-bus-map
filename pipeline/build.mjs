// GTFS → OSM graph → map matching (HMM) → GeoJSON files for the frontend.
// Modes: buses (OSM roadways, navy) and trams (railway=tram tracks, red).
// Usage: node pipeline/build.mjs [--all | lines...] [--tram all|1,4]
// Feeds without shapes.txt are supported: the stop sequence becomes sparse HMM
// observations and Viterbi routes between stops along the rail graph (unused by
// the ZTM feed, which ships shapes for everything).
// Each mode has its own graph and color; a mode may have its own GTFS feed, or —
// as in the Tricity — one cfg per operator feed, separated by route_type.
// Results land in shared files with properties.color/mode, so the frontend styles
// them data-driven.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { iterCsv, readCsv } from './lib/csv.mjs';
import { makeProj, resample, nearestOnPolyline, polylineLength } from './lib/geo.mjs';
import { buildGraph } from './lib/graph.mjs';
import { matchShape } from './lib/hmm.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// m — longer jumps between shape points are GTFS data gaps. The Tricity feeds
// sample shapes at ~13 m median (p90 56 m, holes up to 5.7 km), so the threshold
// sits above the normal spacing; inside a real gap the HMM bridges by routing
// instead of interpolating observations, which would fabricate straight-line
// detours through side streets.
const GAP_MIN = 250;

const TROLLEY_GREEN = '#149a3f';
const TROLLEY_DARK = '#0a5121';

const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const numSort = (a, b) => (Number(a) - Number(b)) || a.localeCompare(b);
function round6(v) { return Math.round(v * 1e6) / 1e6; }

// ---------- CLI ----------
const ARGS = process.argv.slice(2);
let tramLines = [];
const ti = ARGS.indexOf('--tram');
const busArgs = [...ARGS];
if (ti >= 0) {
  tramLines = (ARGS[ti + 1] || '').split(',').filter(Boolean);
  busArgs.splice(ti, 2);
}
const busAll = busArgs.includes('--all');
const busList = busArgs.filter((a) => a !== '--all');

// Both feeds use extended GTFS route types: 700 = bus, 800 = trolleybus
// (Gdynia), 900 = tram (Gdańsk). One bus cfg per operator — the results land
// in the same shared files, and badge/stop clustering downstream is geometric,
// so the two operators fuse at the Sopot seam like any two lines would.
const MODES = [{
  mode: 'bus', label: 'buses (ZTM Gdańsk)', gtfsDir: 'data/gtfs-gdansk', osmFile: 'data/osm/trojmiasto.json',
  graphMode: 'road', color: '#0059a9', colorDark: '#00294f', routeTypes: ['700'],
  all: busAll, lines: busList.length ? busList : (busAll ? [] : ['112']),
}, {
  mode: 'bus', label: 'buses & trolleybuses (ZKM Gdynia)', gtfsDir: 'data/gtfs-gdynia', osmFile: 'data/osm/trojmiasto.json',
  graphMode: 'road', color: '#0059a9', colorDark: '#00294f', routeTypes: ['700', '800'],
  all: busAll, lines: busList.length ? busList : (busAll ? [] : ['170']),
}];
const tramAll = tramLines.length === 1 && tramLines[0] === 'all';
if (tramLines.length) MODES.push({
  mode: 'tram', label: 'trams (ZTM Gdańsk)', gtfsDir: 'data/gtfs-gdansk', osmFile: 'data/osm/trojmiasto-tram.json',
  graphMode: 'tram', color: '#d6212b', colorDark: '#7c1116', routeTypes: ['900'],
  all: tramAll, lines: tramAll ? [] : tramLines,
});

function mergeRuns(all) {
  const merged = [];
  const byKey = new Map();
  for (const r of all) {
    if (r.roundabout) { merged.push(r); continue; }
    let arr = byKey.get(r.linesKey);
    if (!arr) byKey.set(r.linesKey, (arr = []));
    arr.push(r);
  }
  const pk = (c) => c[0] + ',' + c[1];
  for (const arr of byKey.values()) {
    const ends = new Map();
    arr.forEach((r, i) => {
      for (const [k, end] of [[pk(r.coords[0]), 0], [pk(r.coords[r.coords.length - 1]), 1]]) {
        let l = ends.get(k);
        if (!l) ends.set(k, (l = []));
        l.push({ i, end });
      }
    });
    const used = new Array(arr.length).fill(false);
    const free = (k) => (ends.get(k) || []).filter((e) => !used[e.i]);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < arr.length; i++) {
        if (used[i]) continue;
        const r = arr[i];
        const k0 = pk(r.coords[0]), k1 = pk(r.coords[r.coords.length - 1]);
        let coords;
        if (pass === 0) {
          if (free(k0).length === 1) coords = [...r.coords];
          else if (free(k1).length === 1) coords = [...r.coords].reverse();
          else continue;
        } else coords = [...r.coords];
        used[i] = true;
        const names = new Set(r.name ? [r.name] : []);
        for (;;) {
          const cands = free(pk(coords[coords.length - 1]));
          if (cands.length !== 1) break; // fork/end — we do not guess
          const { i: ni, end } = cands[0];
          const nr = arr[ni];
          used[ni] = true;
          const add = end === 0 ? nr.coords : [...nr.coords].reverse();
          for (let p = 1; p < add.length; p++) coords.push(add[p]);
          if (nr.name) names.add(nr.name);
        }
        merged.push({ coords, name: [...names][0] || '', linesKey: r.linesKey, roundabout: 0 });
      }
    }
  }
  return merged;
}

async function processMode(cfg) {
  log(`== ${cfg.label} ==`);
  // per-line colors (metro/tram/trolleybus): a run keeps a line color only when
  // EVERY line of the set shares it (an all-trolleybus street is green); any mix
  // falls back to the mode color (a bus+trolleybus street stays navy — the green
  // is added there as a dashed overlay by the frontend)
  const colorOf = (lines) => {
    if (!cfg.lineColors) return cfg.color;
    const c = cfg.lineColors[lines[0]] || cfg.color;
    for (const l of lines) if ((cfg.lineColors[l] || cfg.color) !== c) return cfg.color;
    return c;
  };
  const colorDarkOf = (lines) => {
    if (!cfg.lineColorsDark) return cfg.colorDark;
    const c = cfg.lineColorsDark[lines[0]] || cfg.colorDark;
    for (const l of lines) if ((cfg.lineColorsDark[l] || cfg.colorDark) !== c) return cfg.colorDark;
    return c;
  };
  // a feed without shapes.txt — geometry is reconstructed from stop sequences
  const hasShapes = existsSync(join(ROOT, cfg.gtfsDir, 'shapes.txt'));
  if (!hasShapes) log('no shapes.txt in this feed — stop sequences become the HMM observations');
  // more trips sampled when stop sequences ARE the geometry: the longest run must
  // win over short-turn variants
  const tripCap = hasShapes ? 40 : 200;

  // ---------- 1) routes.txt → line list and route_ids ----------
  const allRoutes = await readCsv(join(ROOT, cfg.gtfsDir, 'routes.txt'));
  // one feed, two modes: keep only this mode's route_type (see MODES above), so a
  // tram and a bus that share a line number never end up in the same mode either
  const routes = cfg.routeTypes
    ? allRoutes.filter((r) => cfg.routeTypes.includes(r.route_type))
    : allRoutes;
  // feed quirk: some short names carry stray whitespace ("14 " vs "14")
  for (const r of routes) r.route_short_name = (r.route_short_name || '').trim();
  // trolleybuses (GTFS route_type 11) ride the same roads but get their own color;
  // the set also flags shared bus+trolleybus roadways for the dashed overlay
  if (cfg.mode === 'bus') {
    cfg.trolleySet = new Set(routes.filter((r) => ['11', '800'].includes(r.route_type)).map((r) => r.route_short_name));
    if (cfg.trolleySet.size) {
      cfg.lineColors = {}; cfg.lineColorsDark = {};
      for (const L of cfg.trolleySet) { cfg.lineColors[L] = TROLLEY_GREEN; cfg.lineColorsDark[L] = TROLLEY_DARK; }
      log(`trolleybus lines (${cfg.trolleySet.size}): ${[...cfg.trolleySet].sort(numSort).join(', ')}`);
    }
  }
  let LINES = cfg.all
    ? [...new Set(routes.map((r) => r.route_short_name))].sort(numSort)
    : cfg.lines;
  const routeToLine = new Map();
  const missing = [];
  for (const L of LINES) {
    const ids = routes.filter((r) => r.route_short_name === L).map((r) => r.route_id);
    if (!ids.length) { missing.push(L); continue; }
    for (const id of ids) routeToLine.set(id, L);
  }
  if (missing.length) log(`SKIPPED (absent from routes.txt): ${missing.join(', ')}`);
  LINES = LINES.filter((L) => !missing.includes(L));
  log(`Lines (${LINES.length}): ${LINES.join(', ')}`);

  // ---------- 2) trips.txt → representative variant (shape) per line+direction ----------
  const byLineDir = new Map();
  for await (const t of iterCsv(join(ROOT, cfg.gtfsDir, 'trips.txt'))) {
    const L = routeToLine.get(t.route_id);
    if (!L) continue;
    let dirs = byLineDir.get(L);
    if (!dirs) byLineDir.set(L, (dirs = new Map()));
    const dir = t.direction_id || '0';
    let m = dirs.get(dir);
    if (!m) dirs.set(dir, (m = new Map()));
    let e = m.get(t.shape_id);
    if (!e) m.set(t.shape_id, (e = { count: 0, trips: [] }));
    e.count++;
    if (e.trips.length < tripCap) e.trips.push({ trip_id: t.trip_id, headsign: t.trip_headsign });
  }
  let reps = [];
  for (const L of LINES) {
    const dirs = byLineDir.get(L);
    if (!dirs) { log(`SKIPPED line ${L}: no trips in trips.txt`); continue; }
    for (const dir of [...dirs.keys()].sort()) {
      const m = dirs.get(dir);
      let best = null;
      for (const [shapeId, e] of m) if (!best || e.count > best.e.count) best = { shapeId, e };
      reps.push({
        line: L, dir, shapeId: best.shapeId,
        headsign: best.e.trips[0]?.headsign || '',
        candTrips: new Set(best.e.trips.map((x) => x.trip_id)),
        variants: m.size, tripCount: best.e.count,
      });
    }
  }

  // ---------- 3) stop_times.txt (streaming) → stop sequences ----------
  const allTripIds = new Set();
  for (const r of reps) for (const id of r.candTrips) allTripIds.add(id);
  const tripStops = new Map();
  for await (const st of iterCsv(join(ROOT, cfg.gtfsDir, 'stop_times.txt'))) {
    if (!allTripIds.has(st.trip_id)) continue;
    let arr = tripStops.get(st.trip_id);
    if (!arr) tripStops.set(st.trip_id, (arr = []));
    arr.push({ seq: Number(st.stop_sequence), stopId: st.stop_id });
  }
  for (const r of reps) {
    let bestTrip = null, bestLen = -1;
    for (const id of r.candTrips) {
      const n = tripStops.get(id)?.length ?? 0;
      if (n > bestLen) { bestLen = n; bestTrip = id; }
    }
    r.stopSeq = (tripStops.get(bestTrip) || []).sort((a, b) => a.seq - b.seq);
  }

  // ---------- 4) stops.txt (before shapes — stop coords may BE the geometry) ----------
  const stopsById = new Map();
  for (const s of await readCsv(join(ROOT, cfg.gtfsDir, 'stops.txt'))) {
    // feed names carry double spaces here and there — collapse for clean labels.
    // Both Tricity feeds name every pole individually ("Oliwa 07", "Śląska 02");
    // the trailing two-digit pole number is dropped so the poles of one stop
    // share a label and cluster like on the printed map.
    const name = (s.stop_name || '').replace(/\s+/g, ' ').trim().replace(/\s\d{2}$/, '')
      // ZTM Gdańsk city-prefixes Sopot stops whose names already start with
      // "Sopot" ("Sopot Sopot PKP") — collapse the doubled word
      .replace(/^(\S+) \1( |$)/, '$1$2');
    stopsById.set(s.stop_id, { name, lat: Number(s.stop_lat), lon: Number(s.stop_lon) });
  }

  // ---------- 5) route polylines: shapes.txt, or the stop sequence itself ----------
  if (hasShapes) {
    const shapeIds = new Set(reps.map((r) => r.shapeId));
    const shapePts = new Map();
    for await (const s of iterCsv(join(ROOT, cfg.gtfsDir, 'shapes.txt'))) {
      if (!shapeIds.has(s.shape_id)) continue;
      let arr = shapePts.get(s.shape_id);
      if (!arr) shapePts.set(s.shape_id, (arr = []));
      arr.push([Number(s.shape_pt_sequence), Number(s.shape_pt_lat), Number(s.shape_pt_lon)]);
    }
    for (const r of reps) {
      const pts = (shapePts.get(r.shapeId) || []).sort((a, b) => a[0] - b[0]);
      r.shapeLatLon = pts.map((p) => [p[1], p[2]]);
      if (r.shapeLatLon.length < 2) log(`SKIPPED ${r.line}/${r.dir}: empty shape ${r.shapeId}`);
    }
  } else {
    for (const r of reps) {
      r.pseudo = true;
      r.shapeLatLon = r.stopSeq
        .map((s) => stopsById.get(s.stopId))
        .filter(Boolean)
        .map((st) => [st.lat, st.lon]);
      if (r.shapeLatLon.length < 2) log(`SKIPPED ${r.line}/${r.dir}: not enough stops for a pseudo-shape`);
    }
  }
  reps = reps.filter((r) => r.shapeLatLon.length >= 2);

  // ---------- 6) local projection + graph ----------
  let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity;
  for (const r of reps) for (const [lat, lon] of r.shapeLatLon) {
    if (lat < latMin) latMin = lat; if (lat > latMax) latMax = lat;
    if (lon < lonMin) lonMin = lon; if (lon > lonMax) lonMax = lon;
  }
  const proj = makeProj((latMin + latMax) / 2, (lonMin + lonMax) / 2);
  const osm = JSON.parse(readFileSync(join(ROOT, cfg.osmFile), 'utf8'));
  const graph = buildGraph(osm.elements, proj, cfg.graphMode);
  log(`Graph (${cfg.graphMode}): ${graph.nodes.size} nodes, ${graph.segs.length} segments, ${graph.ways.size} ways`);

  // ---------- 7) map matching per line+direction ----------
  const segLines = new Map();
  const rawRunsAll = [];
  for (const r of reps) {
    const xy = r.shapeLatLon.map(([lat, lon]) => proj.toXY(lat, lon));
    let sampled, opts;
    if (r.pseudo) {
      // stations as sparse observations: wider candidate net (platform centroids
      // sit beside the track axis), softer emission/transition — the routing
      // between consecutive stations does the geometric work. ONE wide radius:
      // the radii array is a fallback (a wider net is cast only when the narrow
      // one is empty), and at interchange stations the other line's trackage
      // fills the narrow net so this line's tunnel would never be seen (M1 vs M3
      // at Monastiraki). perWay keeps the list diverse despite dense station tracks.
      sampled = xy;
      opts = { sigma: 20, beta: 64, radii: [150], maxCand: 24, perWay: 2 };
    } else {
      let gaps = 0, maxGap = 0;
      for (let i = 1; i < xy.length; i++) {
        const L = Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]);
        if (L > GAP_MIN) { gaps++; if (L > maxGap) maxGap = L; }
      }
      if (gaps) log(`  shape gap ${r.line}/${r.dir}: ${gaps} × >${GAP_MIN} m (max ${Math.round(maxGap)} m) — bridged by routing`);
      sampled = resample(xy, 20, GAP_MIN);
      opts = {};
    }
    const res = matchShape(graph, sampled, opts);
    if (!res) { log(`SKIPPED ${r.line}/${r.dir}: matching failed`); continue; }
    r.matchedXY = res.coords;
    r.usedSegs = res.usedSegs;
    r.stats = res.stats;
    r.lengthKm = polylineLength(res.coords) / 1000;
    for (const si of res.usedSegs) {
      let set = segLines.get(si);
      if (!set) segLines.set(si, (set = new Set()));
      set.add(r.line);
    }
    for (const raw of res.rawStretches) {
      if (raw.length < 2) continue;
      let len = 0;
      for (let i = 1; i < raw.length; i++) len += Math.hypot(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1]);
      const mid = raw[Math.floor(raw.length / 2)];
      let g = rawRunsAll.find((g) => Math.hypot(g.x - mid[0], g.y - mid[1]) < 60 && Math.abs(g.len - len) < Math.max(60, len * 0.3));
      if (g) g.lines.add(r.line);
      else rawRunsAll.push({
        x: mid[0], y: mid[1], len,
        lines: new Set([r.line]),
        coords: raw.map(([x, y]) => { const [lon, lat] = proj.toLonLat(x, y); return [round6(lon), round6(lat)]; }),
      });
    }
    log(`line ${r.line} dir ${r.dir}: ${r.lengthKm.toFixed(2)} km, mean error ${res.stats.meanError.toFixed(1)} m, ` +
        `breaks=${res.stats.viterbiBreaks} (bridged=${res.stats.bridged}, raw=${res.stats.rawStretchCount}/${res.stats.rawMeters} m), ` +
        `roundabouts=${res.stats.roundaboutSegs}, no candidates=${res.stats.noCandidates}`);
    for (const [bx, by] of res.breakPts) {
      const [lon, lat] = proj.toLonLat(bx, by);
      log(`  BREAK ${r.line}/${r.dir} @ ${lat.toFixed(5)},${lon.toFixed(5)}`);
    }
  }
  reps = reps.filter((r) => r.matchedXY);

  // Trams take the IDENTICAL path as buses: we draw every traversed segment of
  // every direction. The two directional tracks (~3 m apart) are the analog of the
  // two carriageways of a dual carriageway for buses — both strokes, zero selection.
  // The earlier per-line "base track" selection + seam welding produced stubs at
  // every base handoff between lines (reported by the user at 23 lines).

  // ---------- 8) stops: merge by stop_id, line list, snap to routes ----------
  const stopAgg = new Map();
  for (const r of reps) {
    r.stopSeq.forEach((s, i) => {
      const st = stopsById.get(s.stopId);
      if (!st) return;
      let e = stopAgg.get(s.stopId);
      if (!e) stopAgg.set(s.stopId, (e = { name: st.name, lat: st.lat, lon: st.lon, lines: new Set(), terminus: 0 }));
      e.lines.add(r.line);
      if (i === 0 || i === r.stopSeq.length - 1) e.terminus = 1;
    });
  }
  // A metro STATION is one place: merge the per-direction (and per-line, at
  // interchanges) platform records into a single entry keyed by name — one disc,
  // one label (user report: Irini drawn twice, once off the tracks).
  if (cfg.mode === 'tram') {
    const isMetroEntry = (e) => [...e.lines].every((l) => l.startsWith('M'));
    const byStation = new Map();
    for (const [id, e] of stopAgg) {
      if (!isMetroEntry(e)) continue;
      let g = byStation.get(e.name);
      if (!g) byStation.set(e.name, (g = []));
      g.push([id, e]);
    }
    for (const g of byStation.values()) {
      if (g.length < 2) continue;
      const base = g[0][1];
      let latS = base.lat, lonS = base.lon;
      for (let i = 1; i < g.length; i++) {
        const [id, e] = g[i];
        for (const L of e.lines) base.lines.add(L);
        base.terminus = base.terminus || e.terminus;
        latS += e.lat; lonS += e.lon;
        stopAgg.delete(id);
      }
      base.lat = latS / g.length;
      base.lon = lonS / g.length;
    }
  }
  const stopFeatures = [];
  let stopsFar = 0;
  for (const e of stopAgg.values()) {
    const [sx, sy] = proj.toXY(e.lat, e.lon);
    const isMetroStop = cfg.mode === 'tram' && [...e.lines].every((l) => l.startsWith('M'));
    let best = null, bestRun = null;
    for (const r of reps) {
      if (!e.lines.has(r.line)) continue;
      const near = nearestOnPolyline(sx, sy, r.matchedXY);
      if (near && (!best || near.d < best.d)) { best = near; bestRun = r; }
    }
    // metro gets a wide snap net: station coords in STASY are entrance-based and
    // can sit well off the track axis (Irini: >80 m) — the disc belongs ON the line
    const useSnap = best && best.d <= (isMetroStop ? 250 : 80);
    if (!useSnap) stopsFar++;
    const [lon, lat] = useSnap ? proj.toLonLat(best.x, best.y) : [e.lon, e.lat];
    // half-disc orientation: flat edge along the street, bulge toward the pole's
    // side of the roadway (side = sign of the cross product between the street
    // direction and the snap→pole vector; the GTFS pole stands beside the road)
    let angle = 0;
    if (!isMetroStop && best && bestRun && bestRun.matchedXY[best.segIdx + 1]) {
      const A = bestRun.matchedXY[best.segIdx], B = bestRun.matchedXY[best.segIdx + 1];
      const dx = B[0] - A[0], dy = B[1] - A[1];
      const phi = Math.atan2(-dy, dx) * 180 / Math.PI;
      const cross = dx * (sy - best.y) - dy * (sx - best.x);
      angle = Math.round((phi + (cross < 0 ? 180 : 0)) * 10) / 10;
    }
    const arr = [...e.lines].sort(numSort);
    stopFeatures.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [round6(lon), round6(lat)] },
      properties: {
        name: e.name,
        lines: arr.join(', '),
        arr,
        terminus: e.terminus,
        mode: cfg.mode,
        color: colorOf(arr),
        colorDark: colorDarkOf(arr),
        angle,
        // metro stations render as full discs (no roadside pole side to show)
        ...(isMetroStop ? { metro: 1 } : {}),
        snapDist: best ? Math.round(best.d) : null,
      },
    });
  }
  if (stopsFar) log(`WARNING: ${stopsFar} stops farther than 80 m from the route (kept at GTFS position)`);

  // One label per pole group: clustering by name within a 220 m radius.
  const byName = new Map();
  for (const f of stopFeatures) {
    let g = byName.get(f.properties.name);
    if (!g) byName.set(f.properties.name, (g = []));
    g.push(f);
  }
  let labelCount = 0;
  for (const g of byName.values()) {
    const clusters = [];
    for (const f of g) {
      const [lon, lat] = f.geometry.coordinates;
      const [x, y] = proj.toXY(lat, lon);
      let c = clusters.find((c) => Math.hypot(c.x - x, c.y - y) < 220);
      if (!c) clusters.push((c = { x, y, best: f }));
      else if (f.properties.terminus > c.best.properties.terminus) c.best = f;
      f.properties.label = 0;
    }
    for (const c of clusters) { c.best.properties.label = 1; labelCount++; }
  }
  log(`Stops: ${stopFeatures.length} poles, ${labelCount} labels`);

  // Terminus badge ANCHORS: every labeled terminus with the lines that end there
  // and their colors. The grid layout — and the fusing of grids that would collide
  // on screen — happens in a shared pass after all modes, so neighbouring loops of
  // ANY mode merge into one box complex.
  const badgeAnchors = [];
  for (const f of stopFeatures) {
    const p = f.properties;
    if (!p.terminus || !p.label) continue;
    badgeAnchors.push({
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      name: p.name,
      lines: p.arr.map((line) => ({ line, mode: p.mode, color: colorOf([line]), colorDark: colorDarkOf([line]) })),
    });
  }
  log(`Termini: ${badgeAnchors.length} loops with line badges`);

  // ---------- 9) streets/tracks: runs merged per line set ----------
  const byWay = new Map();
  for (const [si, lines] of segLines) {
    const s = graph.segs[si];
    let m = byWay.get(s.wayId);
    if (!m) byWay.set(s.wayId, (m = new Map()));
    m.set(s.wayPos, lines);
  }
  const runs = [];
  for (const [wayId, posMap] of byWay) {
    const way = graph.ways.get(wayId);
    const positions = [...posMap.keys()].sort((a, b) => a - b);
    const keyOf = (pos) => [...posMap.get(pos)].sort(numSort).join(', ');
    const flush = (start, end, linesKey) => {
      const ids = way.nodeIds.slice(start, end + 2);
      const coords = ids.map((id) => {
        const n = graph.nodes.get(id);
        return [round6(n.lon), round6(n.lat)];
      });
      if (coords.length >= 2) runs.push({ coords, name: way.name, linesKey, roundabout: way.roundabout ? 1 : 0 });
    };
    let runStart = positions[0], prevPos = positions[0], runKey = keyOf(positions[0]);
    for (let i = 1; i < positions.length; i++) {
      const pos = positions[i], key = keyOf(pos);
      if (pos !== prevPos + 1 || key !== runKey) {
        flush(runStart, prevPos, runKey);
        runStart = pos;
        runKey = key;
      }
      prevPos = pos;
    }
    flush(runStart, prevPos, runKey);
  }
  // extra per-run flags: trolley 'all'/'mix' (green stroke / dashed green overlay)
  // and metro (wide translucent ribbon) — the frontend styles on these
  const runFlags = (arr) => {
    const flags = {};
    if (cfg.trolleySet && cfg.trolleySet.size) {
      const n = arr.filter((l) => cfg.trolleySet.has(l)).length;
      if (n === arr.length) flags.trolley = 'all';
      else if (n > 0) flags.trolley = 'mix';
    }
    if (cfg.mode === 'tram' && arr.every((l) => l.startsWith('M'))) flags.metro = 1;
    return flags;
  };
  const mergedRuns = mergeRuns(runs);
  const streetFeatures = mergedRuns.map((r) => {
    const arr = r.linesKey.split(', ');
    return {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: r.coords },
      properties: { name: r.name, lines: r.linesKey, arr, roundabout: r.roundabout, mode: cfg.mode, color: colorOf(arr), ...runFlags(arr) },
    };
  });
  for (const g of rawRunsAll) {
    const arr = [...g.lines].sort(numSort);
    streetFeatures.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: g.coords },
      properties: { name: '', lines: arr.join(', '), arr, roundabout: 0, mode: cfg.mode, color: colorOf(arr), unmapped: 1, ...runFlags(arr) },
    });
  }
  log(`Runs: ${runs.length} → ${mergedRuns.length} after merging` +
      (rawRunsAll.length ? ` (+${rawRunsAll.length} outside OSM)` : ''));

  const toLonLat = (xy) => xy.map(([x, y]) => { const [lon, lat] = proj.toLonLat(x, y); return [round6(lon), round6(lat)]; });
  const routeFeatures = reps.map((r) => ({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: toLonLat(r.matchedXY) },
    properties: { line: r.line, dir: r.dir, headsign: r.headsign, mode: cfg.mode, color: colorOf([r.line]) },
  }));
  const shapeFeatures = reps.map((r) => ({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: r.shapeLatLon.map(([lat, lon]) => [lon, lat]) },
    properties: { line: r.line, dir: r.dir, mode: cfg.mode },
  }));
  const metaLines = [...new Set(reps.map((r) => r.line))].sort(numSort).map((L) => ({
    line: L,
    mode: cfg.mode,
    color: colorOf([L]),
    dirs: reps.filter((r) => r.line === L).map((r) => ({
      dir: r.dir, headsign: r.headsign, variants: r.variants, tripCount: r.tripCount,
      stops: r.stopSeq.length, lengthKm: Math.round(r.lengthKm * 100) / 100, stats: r.stats,
    })),
  }));

  return { routeFeatures, shapeFeatures, stopFeatures, streetFeatures, badgeAnchors, metaLines };
}

// ---------- run per mode + write shared files ----------
const results = [];
for (const cfg of MODES) results.push(await processMode(cfg));

const routeFeatures = results.flatMap((r) => r.routeFeatures);
const shapeFeatures = results.flatMap((r) => r.shapeFeatures);
const stopFeatures = results.flatMap((r) => r.stopFeatures);
const streetFeatures = results.flatMap((r) => r.streetFeatures);
const metaLines = [];
{
  // Two operators, one line list: "171" exists in both feeds (the only clash in
  // the MZKZG numbering) — merge duplicates so the panel shows one chip whose
  // dirs cover both operators' routes.
  const byKey = new Map();
  for (const m of results.flatMap((r) => r.metaLines)) {
    const k = m.mode + '|' + m.line;
    const prev = byKey.get(k);
    if (prev) prev.dirs.push(...m.dirs);
    else { byKey.set(k, m); metaLines.push(m); }
  }
}

// ---------- 10) line-number labels: SHARED across both modes ----------
// On a street shared by trams and buses the roadway and the track are parallel
// geometries 2–6 m apart — separate labels of both modes fought for space.
// Here we pair them geometrically: a tram run following a bus roadway gets
// `busLines` (one number segment: red + blue), and the covered bus run gets
// `nolabel` (its stroke stays, the track takes over its numbers).
{
  const [lon0, lat0] = streetFeatures[0].geometry.coordinates[0];
  const P = makeProj(lat0, lon0);
  const CELL = 60, NEAR = 18, STEP = 25;
  const wrap = (f) => {
    const xy = f.geometry.coordinates.map(([lon, lat]) => P.toXY(lat, lon));
    let len = 0;
    for (let i = 1; i < xy.length; i++) len += Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]);
    return { f, xy, len };
  };
  const labelable = (f) => !f.properties.roundabout && !f.properties.unmapped;
  const busF = streetFeatures.filter((f) => f.properties.mode === 'bus' && labelable(f)).map(wrap);
  // Metro NEVER adopts street numbers: a metro line is one 20-40 km run, so the
  // adoption union would collect every bus line the tunnel passes under — a
  // label listing lines that do not ride that street (user report, Iera Odos).
  // Only street-running trams (T6/T7) share corridors with buses.
  const tramF = streetFeatures.filter((f) => f.properties.mode === 'tram' && labelable(f) && !f.properties.metro).map(wrap);
  const gridOf = (list) => {
    const g = new Map();
    list.forEach((o, oi) => {
      for (let i = 0; i + 1 < o.xy.length; i++) {
        const [ax, ay] = o.xy[i], [bx, by] = o.xy[i + 1];
        for (let cx = Math.floor(Math.min(ax, bx) / CELL); cx <= Math.floor(Math.max(ax, bx) / CELL); cx++)
          for (let cy = Math.floor(Math.min(ay, by) / CELL); cy <= Math.floor(Math.max(ay, by) / CELL); cy++) {
            const k = cx + ':' + cy;
            let arr = g.get(k);
            if (!arr) g.set(k, (arr = []));
            arr.push([ax, ay, bx, by, oi]);
          }
      }
    });
    return g;
  };
  const dSeg = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay;
    const L2 = dx * dx + dy * dy;
    let t = L2 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };
  const samplesOf = (xy) => {
    const out = [];
    let carry = 0;
    for (let i = 0; i + 1 < xy.length; i++) {
      const [ax, ay] = xy[i], [bx, by] = xy[i + 1];
      const L = Math.hypot(bx - ax, by - ay);
      if (!L) continue;
      let d = carry;
      while (d <= L) { const t = d / L; out.push([ax + t * (bx - ax), ay + t * (by - ay)]); d += STEP; }
      carry = d - L;
    }
    return out;
  };
  const nearAt = (grid, x, y) => {
    const hit = new Set();
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    for (let ix = cx - 1; ix <= cx + 1; ix++) for (let iy = cy - 1; iy <= cy + 1; iy++)
      for (const [ax, ay, bx, by, oi] of grid.get(ix + ':' + iy) || [])
        if (!hit.has(oi) && dSeg(x, y, ax, ay, bx, by) <= NEAR) hit.add(oi);
    return hit;
  };
  const busGrid = gridOf(busF), tramGrid = gridOf(tramF);
  const adopted = new Set(); // bus runs whose numbers were taken over by some track
  for (const o of tramF) {
    const smp = samplesOf(o.xy);
    if (smp.length < 2) continue;
    const nearLen = new Map();
    let nearAny = 0;
    for (const [x, y] of smp) {
      const hit = nearAt(busGrid, x, y);
      if (hit.size) nearAny++;
      for (const oi of hit) nearLen.set(oi, (nearLen.get(oi) || 0) + STEP);
    }
    if (nearAny / smp.length < 0.55) continue;
    const lines = new Set();
    for (const [oi, L] of nearLen) {
      const b = busF[oi];
      // brief brushes (intersections) do not count as a shared corridor
      if (L >= Math.max(60, 0.35 * Math.min(o.len, b.len))) {
        for (const s of b.f.properties.lines.split(', ')) lines.add(s);
        adopted.add(oi);
      }
    }
    if (lines.size) o.f.properties.busLines = [...lines].sort(numSort).join(', ');
  }
  busF.forEach((o, oi) => {
    if (!adopted.has(oi)) return; // numbers not adopted anywhere — the label stays
    const smp = samplesOf(o.xy);
    if (smp.length < 2) return;
    let nearAny = 0;
    for (const [x, y] of smp) if (nearAt(tramGrid, x, y).size) nearAny++;
    if (nearAny / smp.length >= 0.7) o.f.properties.nolabel = 1;
  });

  // Numbers ONCE per street: one label per (street name × line set) pair —
  // a set change on the same street or the next street = a new label. A group
  // (twin carriageways/tracks of the same street) gets one anchor at the midpoint
  // of its longest run. The point carries the street BEARING: the frontend rotates
  // the text parallel to the road and offsets it aside, so the number stands
  // BESIDE the roadway along its course.
  var labelFeatures = [];
  const groups = new Map(); // (name|set) → all runs of the group + the longest one
  let anonId = 0;
  for (const f of streetFeatures) {
    const p = f.properties;
    if (p.roundabout || p.nolabel) continue;
    const coords = f.geometry.coordinates;
    const xy = coords.map(([lon, lat]) => P.toXY(lat, lon));
    const segLens = [];
    let total = 0;
    for (let i = 1; i < xy.length; i++) {
      const L = Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]);
      segLens.push(L);
      total += L;
    }
    if (total < 60) continue;
    // no name (links, construction) means no street identity — each run on its own
    const gKey = (p.name || `~${anonId++}`) + '|' + p.lines + '|' + (p.busLines || '');
    const entry = { f, coords, xy, segLens, total };
    let g = groups.get(gKey);
    if (!g) groups.set(gKey, (g = { runs: [], best: null }));
    g.runs.push(entry);
    if (!g.best || total > g.best.total) g.best = entry;
  }
  const WIN = 30;
  // One label per group at the midpoint of its longest run (the "once per street"
  // rule) PLUS extra anchors tagged extra:1 spaced along every run of a few
  // blocks or more. The extras are the numbers' FALLBACK positions: stop names
  // outrank numbers in the frontend ladder, so where a name takes the main
  // anchor's spot the row must be able to reappear further down the street —
  // every anchor is collision-managed, so only the free ones actually render.
  const LONG_RUN = 500, SPACING = 550, EXCL = 300;
  const tryPlace = (e, d) => {
    const { coords, xy, segLens, total } = e;
    const at = (dd) => {
      let acc = 0;
      for (let i = 0; i < segLens.length; i++) {
        if (acc + segLens[i] >= dd || i === segLens.length - 1) {
          const t = segLens[i] ? Math.min(1, Math.max(0, (dd - acc) / segLens[i])) : 0;
          return {
            x: xy[i][0] + t * (xy[i + 1][0] - xy[i][0]), y: xy[i][1] + t * (xy[i + 1][1] - xy[i][1]),
            lon: coords[i][0] + t * (coords[i + 1][0] - coords[i][0]), lat: coords[i][1] + t * (coords[i + 1][1] - coords[i][1]),
          };
        }
        acc += segLens[i];
      }
    };
    const c = at(d), a = at(Math.max(0, d - WIN)), b = at(Math.min(total, d + WIN));
    const dx = b.x - a.x, dy = b.y - a.y;
    if (Math.hypot(dx, dy) < 5) return null; // tight bend — no clean bearing here
    let ang = Math.atan2(-dy, dx) * 180 / Math.PI; // clockwise degrees, screen y downwards
    if (ang > 90) ang -= 180;   // normalization: text never upside down
    if (ang < -90) ang += 180;
    return { c, ang };
  };
  for (const g of groups.values()) {
    const p = g.best.f.properties;
    const arr = p.busLines ? [...p.lines.split(', '), ...p.busLines.split(', ')] : p.lines.split(', ');
    const baseProps = { lines: p.lines, color: p.color, mode: p.mode, arr };
    if (p.busLines) baseProps.busLines = p.busLines;
    const anchors = [];
    const emit = (placed, extra) => {
      const props = { ...baseProps, angle: Math.round(placed.ang * 10) / 10 };
      if (extra) props.extra = 1;
      labelFeatures.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [round6(placed.c.lon), round6(placed.c.lat)] }, properties: props });
      anchors.push([placed.c.x, placed.c.y]);
    };
    // anchor at the midpoint; if there is a tight bend there, try a straighter spot nearby
    for (const frac of [0.5, 0.35, 0.65, 0.2, 0.8]) {
      const placed = tryPlace(g.best, frac * g.best.total);
      if (placed) { emit(placed, false); break; }
    }
    for (const e of g.runs) {
      if (e.total < LONG_RUN) continue;
      for (let d = SPACING / 2; d < e.total; d += SPACING) {
        const placed = tryPlace(e, d);
        if (!placed) continue;
        if (anchors.some(([ax, ay]) => Math.hypot(ax - placed.c.x, ay - placed.c.y) < EXCL)) continue;
        emit(placed, true);
      }
    }
  }
  const nShared = tramF.filter((o) => o.f.properties.busLines).length;
  log(`Labels: ${nShared} shared bus+tram segments, ${busF.filter((o) => o.f.properties.nolabel).length} roadways hand their numbers to tracks, ` +
      `${labelFeatures.length} number labels (${labelFeatures.filter((f) => f.properties.extra).length} zoom-in repeats)`);
}

// ---------- 11) terminus line badges: grids fuse into one complex when they collide ----------
// Each terminating line gets its own small box, laid out in a centered grid under
// the loop. The grid lives in SCREEN space while loops live in metres, so two
// neighbouring loops overlap when zoomed out and stand apart when zoomed in. The
// layout is therefore computed for several ZOOM BANDS: inside a band, anchors whose
// grids would overlap are merged into ONE complex (union of lines, centroid
// position), and the frontend shows the band matching the current zoom.
const badgeFeatures = [];
// Grids are fused for the WORST CASE inside a band (its lower zoom edge), so
// wide bands mean badly oversized complexes near the band's top — the
// whole-map poster renders around z13.9 and with a [13,14] band the Kaponiera
// complex (fused for z13.0) boxed out its neighbours' stop names. Narrower
// bands keep the fusion honest at every zoom.
const BADGE_BANDS = [[13, 13.6], [13.6, 14.4], [14.4, 15.5], [15.5, 16.8], [16.8, 22]];
{
  const anchors = results.flatMap((r) => r.badgeAnchors);
  // Cell spacing is in ems (scales with badge text), but each box also carries
  // FIXED pixels (icon-text-fit padding + rim) that don't scale — at low zoom a
  // 3-digit box outgrew a 3.0/1.5 em cell and neighbours overlapped, so the
  // cells are wider than the naive text estimate.
  const PER_ROW = 5, CELL_W = 3.4, CELL_H = 2.0, BASE_Y = 1.1;
  const EM = 9, PAD = 10; // px: label em size in the band, plus breathing room
  // Name-row metrics. The frontend wraps names at text-max-width 10 em with
  // line-height 1.1 (set explicitly in app.js) — roughly 18 chars per line at
  // ~0.55 em/char — so both the row stacking and the fusion test must use the
  // WRAPPED height and width: a two-line name laid out on a one-line slot
  // overprints the row above it, and two neighbouring complexes whose grids
  // clear each other can still cross name stacks.
  const NAME_EM = 10, NAME_CHW = 0.55, NAME_WRAP = 18, NAME_LH = 1.1, NAME_BASE = 0.8;
  // A complex may carry at most MAX_NAMES terminus names — one huge fused
  // block (Katowice centre: 11 names, 55 boxes) reads as noise because the
  // names lose their loops. Clusters that collide but may not fuse are pushed
  // apart by the separation pass below instead.
  const MAX_NAMES = 3;
  const nameRows = (nm) => Math.max(1, Math.ceil(nm.length / NAME_WRAP));
  const nameWpx = (nm) => Math.min(nm.length, Math.ceil(nm.length / nameRows(nm)) + 2) * NAME_CHW * NAME_EM;
  // full complex footprint in px: box grid below the anchor + name stack above
  const rectOf = (c) => {
    const g = geom(c.lines.length);
    const stackH = c.names.reduce((s, nm) => s + nameRows(nm) * NAME_LH, 0);
    const w = Math.max(g.w, ...c.names.map(nameWpx));
    const top = -(NAME_BASE + stackH) * NAME_EM;
    const bottom = g.yc + g.h / 2;
    return { w, cy: (top + bottom) / 2, h: bottom - top };
  };
  const latMid = anchors.length ? anchors.reduce((s, a) => s + a.lat, 0) / anchors.length : 50;
  const P2 = makeProj(latMid, anchors.length ? anchors[0].lon : 19.94);
  // grid footprint in px for n lines: width, height and the centre's offset below
  // the anchor (the grid hangs under the dot)
  const geom = (n) => {
    const rows = Math.ceil(n / PER_ROW), cols = Math.min(PER_ROW, n);
    return {
      w: cols * CELL_W * EM + PAD,
      h: ((rows - 1) * CELL_H + 1) * EM + PAD,
      yc: (BASE_Y + ((rows - 1) * CELL_H) / 2) * EM,
    };
  };
  let mergedTotal = 0;
  BADGE_BANDS.forEach(([z0], band) => {
    // metres per pixel at the band's lower edge (worst case inside the band);
    // 512 px tiles ⇒ the classic 256 px formula at z+1
    const mpp = (156543.03392 * Math.cos((latMid * Math.PI) / 180)) / 2 ** (z0 + 1);
    const cl = anchors.map((a) => {
      const [x, y] = P2.toXY(a.lat, a.lon);
      return { x, y, n: 1, lines: a.lines.slice(), names: [a.name] };
    });
    for (let pass = 0; pass < 12; pass++) {
      let merged = false;
      for (let i = 0; i < cl.length; i++) {
        for (let j = i + 1; j < cl.length; j++) {
          const A = cl[i], B = cl[j];
          const ra = rectOf(A), rb = rectOf(B);
          const dx = Math.abs(A.x - B.x);
          const dy = Math.abs((A.y - ra.cy * mpp) - (B.y - rb.cy * mpp));
          if (dx >= ((ra.w + rb.w) / 2) * mpp || dy >= ((ra.h + rb.h) / 2) * mpp) continue;
          if (new Set([...A.names, ...B.names]).size > MAX_NAMES) continue;
          const seen = new Set(A.lines.map((l) => l.line));
          for (const l of B.lines) if (!seen.has(l.line)) A.lines.push(l);
          for (const nm of B.names) if (!A.names.includes(nm)) A.names.push(nm);
          A.x = (A.x * A.n + B.x * B.n) / (A.n + B.n);
          A.y = (A.y * A.n + B.y * B.n) / (A.n + B.n);
          A.n += B.n;
          cl.splice(j--, 1);
          merged = true;
        }
      }
      if (!merged) break;
    }
    // Separation: complexes that still overlap (the MAX_NAMES cap stopped the
    // merge) are nudged apart along the axis needing the smaller correction,
    // half each. The terminus DOTS are drawn from stops.geojson at the true
    // loop positions and do not move, so a nudged complex stays next to its
    // loop and the name→loop association survives.
    for (let pass = 0; pass < 40; pass++) {
      let moved = false;
      for (let i = 0; i < cl.length; i++) {
        for (let j = i + 1; j < cl.length; j++) {
          const A = cl[i], B = cl[j];
          const ra = rectOf(A), rb = rectOf(B);
          const dxp = (A.x - B.x) / mpp;
          const dyp = ((A.y - ra.cy * mpp) - (B.y - rb.cy * mpp)) / mpp;
          const ox = (ra.w + rb.w) / 2 - Math.abs(dxp);
          const oy = (ra.h + rb.h) / 2 - Math.abs(dyp);
          if (ox <= 0 || oy <= 0) continue;
          if (ox < oy) {
            const s = (dxp >= 0 ? 1 : -1) * (ox / 2 + 2) * mpp;
            A.x += s; B.x -= s;
          } else {
            const s = (dyp >= 0 ? 1 : -1) * (oy / 2 + 2) * mpp;
            A.y += s; B.y -= s;
          }
          moved = true;
        }
      }
      if (!moved) break;
    }
    mergedTotal += anchors.length - cl.length;
    for (const c of cl) {
      const lines = c.lines.slice().sort((a, b) => numSort(a.line, b.line));
      const [lon, lat] = P2.toLonLat(c.x, c.y);
      // The terminus NAME(S) ride with the complex: reserved rows stacked
      // right above the grid, drawn unconditionally like the boxes. The
      // collision-managed name layer could stay nameless at saturated nodes
      // (Bałtyk at Kaponiera) — and a nameless loop is a hard error on a
      // printed map, so from z13 these rows replace it.
      const modes = [...new Set(lines.map((l) => l.mode))].join(',');
      let yOff = NAME_BASE;
      for (const nm of [...c.names].sort((a, b) => b.localeCompare(a))) {
        badgeFeatures.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [round6(lon), round6(lat)] },
          properties: { name: nm, band, modes, arr: lines.map((l) => l.line), off: [0, -Math.round(yOff * 100) / 100] },
        });
        yOff += nameRows(nm) * NAME_LH;
      }
      lines.forEach((l, i) => {
        const row = Math.floor(i / PER_ROW), col = i % PER_ROW;
        const rowLen = Math.min(PER_ROW, lines.length - row * PER_ROW);
        badgeFeatures.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [round6(lon), round6(lat)] },
          properties: {
            line: l.line, mode: l.mode, color: l.color, colorDark: l.colorDark, band,
            off: [
              Math.round((col - (rowLen - 1) / 2) * CELL_W * 100) / 100,
              Math.round((BASE_Y + row * CELL_H) * 100) / 100,
            ],
          },
        });
      });
    }
  });
  log(`Badges: ${badgeFeatures.length} boxes across ${BADGE_BANDS.length} zoom bands ` +
      `(${mergedTotal} colliding grids fused)`);
}

let bLonMin = Infinity, bLonMax = -Infinity, bLatMin = Infinity, bLatMax = -Infinity;
for (const f of routeFeatures) for (const [lon, lat] of f.geometry.coordinates) {
  if (lon < bLonMin) bLonMin = lon; if (lon > bLonMax) bLonMax = lon;
  if (lat < bLatMin) bLatMin = lat; if (lat > bLatMax) bLatMax = lat;
}

const outDir = join(ROOT, 'data/out');
mkdirSync(outDir, { recursive: true });
const fc = (features) => JSON.stringify({ type: 'FeatureCollection', features });
writeFileSync(join(outDir, 'route.geojson'), fc(routeFeatures));
writeFileSync(join(outDir, 'streets.geojson'), fc(streetFeatures));
writeFileSync(join(outDir, 'labels.geojson'), fc(labelFeatures));
writeFileSync(join(outDir, 'stops.geojson'), fc(stopFeatures));
writeFileSync(join(outDir, 'badges.geojson'), fc(badgeFeatures));
writeFileSync(join(outDir, 'gtfs-shape.geojson'), fc(shapeFeatures));
writeFileSync(join(outDir, 'meta.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  bbox: [bLonMin, bLatMin, bLonMax, bLatMax],
  badgeBands: BADGE_BANDS,
  modes: MODES.map((m) => ({ mode: m.mode, label: m.label, color: m.color })),
  lines: metaLines,
}, null, 2));
log(`Wrote data/out/{route,streets,labels,stops,badges,gtfs-shape}.geojson + meta.json`);
