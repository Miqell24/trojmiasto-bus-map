// HMM/Viterbi map matching (Newson–Krumm 2009) on a directed road graph.
// Observations = GTFS polyline points; states = projections onto nearby segments;
// emission = Gaussian distance penalty; transition = penalty for |route − straight line|.
// The result follows OSM nodes, so roundabouts and intersections get true geometry.
import { candidates, dijkstra, pathTo } from './graph.mjs';

function emission(d, sigma) { return -0.5 * (d / sigma) * (d / sigma); }

function exits(graph, c) {
  const s = graph.segs[c.segIdx];
  const list = [];
  if (isFinite(s.fwdPen)) list.push({ node: s.b, cost: (1 - c.t) * s.len * s.fwdPen });
  if (isFinite(s.bwdPen)) list.push({ node: s.a, cost: c.t * s.len * s.bwdPen });
  return list;
}

function entries(graph, c) {
  const s = graph.segs[c.segIdx];
  const list = [];
  if (isFinite(s.fwdPen)) list.push({ node: s.a, cost: c.t * s.len * s.fwdPen });
  if (isFinite(s.bwdPen)) list.push({ node: s.b, cost: (1 - c.t) * s.len * s.bwdPen });
  return list;
}

// Travel along a shared segment; costs include directional penalties (null = impossible).
function sameSegDist(graph, a, b) {
  if (a.segIdx !== b.segIdx) return null;
  const s = graph.segs[a.segIdx];
  let best = null;
  if (isFinite(s.fwdPen) && b.t >= a.t) best = (b.t - a.t) * s.len * s.fwdPen;
  if (isFinite(s.bwdPen) && b.t <= a.t) {
    const d = (a.t - b.t) * s.len * s.bwdPen;
    if (best === null || d < best) best = d;
  }
  return best;
}

function routeDistances(graph, a, candsB, cap) {
  const sources = new Map();
  for (const e of exits(graph, a)) {
    const cur = sources.get(e.node);
    if (cur === undefined || e.cost < cur) sources.set(e.node, e.cost);
  }
  const entryLists = candsB.map((c) => entries(graph, c));
  const targets = new Set();
  for (const list of entryLists) for (const e of list) targets.add(e.node);
  const { dist } = dijkstra(graph, sources, targets, cap);
  return candsB.map((b, k) => {
    let best = sameSegDist(graph, a, b);
    for (const e of entryLists[k]) {
      const d = dist.get(e.node);
      if (d !== undefined) {
        const total = d + e.cost;
        if (best === null || total < best) best = total;
      }
    }
    return best;
  });
}

// Geometry of the a→b connection (without the start point). Returns {d, coords, nodesPath|null}.
function connectPair(graph, a, b, cap) {
  const ss = sameSegDist(graph, a, b);
  const sources = new Map();
  for (const e of exits(graph, a)) {
    const cur = sources.get(e.node);
    if (cur === undefined || e.cost < cur) sources.set(e.node, e.cost);
  }
  const entryList = entries(graph, b);
  const targets = new Set(entryList.map((e) => e.node));
  const { dist, prev } = dijkstra(graph, sources, targets, cap);
  let best = null;
  for (const e of entryList) {
    const d = dist.get(e.node);
    if (d !== undefined) {
      const total = d + e.cost;
      if (!best || total < best.total) best = { total, node: e.node };
    }
  }
  if (ss !== null && (best === null || ss <= best.total)) {
    return { d: ss, coords: [[b.x, b.y]], nodesPath: null };
  }
  if (best === null) return null;
  const nodesPath = pathTo(prev, best.node);
  const coords = [];
  for (const n of nodesPath) {
    const nd = graph.nodes.get(n);
    coords.push([nd.x, nd.y]);
  }
  coords.push([b.x, b.y]);
  return { d: best.total, coords, nodesPath };
}

function argmax(arr) {
  let bi = 0;
  for (let i = 1; i < arr.length; i++) if (arr[i] > arr[bi]) bi = i;
  return bi;
}

function appendCoords(coords, extra) {
  for (const p of extra) {
    const last = coords[coords.length - 1];
    if (Math.abs(last[0] - p[0]) > 0.01 || Math.abs(last[1] - p[1]) > 0.01) coords.push(p);
  }
}

// pts: [[x,y], ...] (resampled GTFS polyline in local coordinates).
// Points with no roadway within ~70 m stay unassigned — if GTFS drives a road that
// is missing from OSM (new infrastructure), it is better to draw the raw trace than
// to pull the route onto random nearby streets (see the fallback in reconstruction).
export function matchShape(graph, pts, opts = {}) {
  const sigma = opts.sigma ?? 8;
  const beta = opts.beta ?? 32;
  const radii = opts.radii ?? [45, 70];
  const maxCand = opts.maxCand ?? 12;
  const perWay = opts.perWay ?? Infinity;

  const obs = [];
  let skipped = 0;
  pts.forEach((p, idx) => {
    let cand = [];
    for (const r of radii) {
      cand = candidates(graph, p[0], p[1], r, maxCand, perWay);
      if (cand.length) break;
    }
    if (cand.length) obs.push({ x: p[0], y: p[1], cand, idx });
    else skipped++;
  });
  const N = obs.length;
  if (N === 0) return null;

  const NEG = -Infinity;
  const scoresHist = [obs[0].cand.map((c) => emission(c.dist, sigma))];
  const back = [];
  const breaks = new Set();
  const breakPts = [];

  for (let i = 1; i < N; i++) {
    const A = obs[i - 1], B = obs[i];
    const prevScores = scoresHist[i - 1];
    const dGc = Math.hypot(B.x - A.x, B.y - A.y);
    const cap = Math.max(400, dGc * 4 + 300);
    const rd = A.cand.map((c, j) => (prevScores[j] === NEG ? null : routeDistances(graph, c, B.cand, cap)));
    const ns = new Array(B.cand.length).fill(NEG);
    const bp = new Array(B.cand.length).fill(-1);
    for (let k = 0; k < B.cand.length; k++) {
      let best = NEG, bj = -1;
      for (let j = 0; j < A.cand.length; j++) {
        if (!rd[j] || rd[j][k] === null) continue;
        const s = prevScores[j] - Math.abs(rd[j][k] - dGc) / beta;
        if (s > best) { best = s; bj = j; }
      }
      if (bj >= 0) { ns[k] = best + emission(B.cand[k].dist, sigma); bp[k] = bj; }
    }
    let allNeg = true;
    for (const s of ns) if (s !== NEG) { allNeg = false; break; }
    if (allNeg) {
      breaks.add(i);
      breakPts.push([B.x, B.y]);
      for (let k = 0; k < B.cand.length; k++) { ns[k] = emission(B.cand[k].dist, sigma); bp[k] = -1; }
    }
    let mx = -Infinity;
    for (const s of ns) if (s > mx) mx = s;
    for (let k = 0; k < ns.length; k++) if (ns[k] !== NEG) ns[k] -= mx;
    scoresHist.push(ns);
    back.push(bp);
  }

  const chosen = new Array(N);
  chosen[N - 1] = argmax(scoresHist[N - 1]);
  for (let i = N - 1; i >= 1; i--) {
    const j = back[i - 1][chosen[i]];
    chosen[i - 1] = j >= 0 ? j : argmax(scoresHist[i - 1]);
  }

  const c0 = obs[0].cand[chosen[0]];
  const coords = [[c0.x, c0.y]];
  // Count TRAVELED meters per segment (not the mere fact of touching it) — a candidate
  // projected near a corner onto a long perpendicular segment must not drag the whole
  // block into the streets layer ("tails" at turns on a sparse OSM grid).
  const usedLen = new Map();
  const use = (si, m) => usedLen.set(si, (usedLen.get(si) || 0) + m);
  const rawStretches = [];
  let bridged = 0, rawFallbacks = 0, rawMeters = 0, sumDist = 0;

  for (let i = 1; i < N; i++) {
    const A = obs[i - 1], B = obs[i];
    const a = A.cand[chosen[i - 1]];
    const b = B.cand[chosen[i]];
    sumDist += b.dist;
    // length of the raw GTFS trace between observations (incl. unassigned points)
    let rawLen = 0;
    for (let p = A.idx; p < B.idx; p++) {
      rawLen += Math.hypot(pts[p + 1][0] - pts[p][0], pts[p + 1][1] - pts[p][1]);
    }
    const isBreak = breaks.has(i);
    const spansSkipped = B.idx - A.idx > 1;
    let conn = connectPair(graph, a, b, Math.max(500, rawLen * 4 + 300));
    if (!conn) conn = connectPair(graph, a, b, rawLen * 8 + 2000);
    // The bridge is judged only on a broken chain / across unassigned points:
    // if it comes out absurdly longer than the raw trace, the road does not exist
    // in OSM — draw the GTFS trace instead of fabricating a detour via ramps.
    const wildDetour = conn && (isBreak || spansSkipped) &&
      conn.d > Math.max(rawLen * 2.5, rawLen + 150);
    if (conn && !wildDetour) {
      appendCoords(coords, conn.coords);
      if (conn.nodesPath) {
        const sa = graph.segs[a.segIdx];
        const first = conn.nodesPath[0];
        use(a.segIdx, first === sa.b ? (1 - a.t) * sa.len : first === sa.a ? a.t * sa.len : 0);
        for (let p = 0; p + 1 < conn.nodesPath.length; p++) {
          const si = graph.segByNodes.get(conn.nodesPath[p] + '|' + conn.nodesPath[p + 1]);
          if (si !== undefined) use(si, graph.segs[si].len);
        }
        const sb = graph.segs[b.segIdx];
        const last = conn.nodesPath[conn.nodesPath.length - 1];
        use(b.segIdx, last === sb.a ? b.t * sb.len : last === sb.b ? (1 - b.t) * sb.len : 0);
      } else {
        use(a.segIdx, Math.abs(b.t - a.t) * graph.segs[a.segIdx].len);
      }
      if (isBreak) bridged++;
    } else {
      const raw = [[a.x, a.y]];
      for (let p = A.idx + 1; p < B.idx; p++) raw.push([pts[p][0], pts[p][1]]);
      raw.push([b.x, b.y]);
      appendCoords(coords, raw.slice(1));
      rawStretches.push(raw);
      rawFallbacks++;
      rawMeters += rawLen;
    }
  }

  // A segment enters the streets layer only once ≥25 m or ≥half of its length was
  // traveled (short intersection segments stay, glancing touches drop out).
  const usedSegs = new Set();
  for (const [si, m] of usedLen) {
    if (m >= Math.min(25, graph.segs[si].len * 0.5)) usedSegs.add(si);
  }

  let roundaboutSegs = 0;
  for (const si of usedSegs) if (graph.segs[si].roundabout) roundaboutSegs++;

  return {
    coords,
    usedSegs,
    breakPts,
    rawStretches,
    stats: {
      observations: pts.length,
      matched: N,
      noCandidates: skipped,
      viterbiBreaks: breaks.size,
      bridged: bridged,
      rawStretchCount: rawFallbacks,
      rawMeters: Math.round(rawMeters),
      meanError: N > 1 ? sumDist / (N - 1) : 0,
      roundaboutSegs: roundaboutSegs,
    },
  };
}
