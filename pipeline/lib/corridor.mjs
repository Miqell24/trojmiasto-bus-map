// ── Zwijanie dwujezdniowej drogi w jedną rysowaną linię ──────────────────────
//
// Droga dwujezdniowa narysowana jako dwie jezdnie to uczciwa geometria i kiepska
// kartografia: oba kierunki tej samej linii lądują na zewnętrznych krawędziach
// korytarza, a środek zostaje pusty. W węźle bywa gorzej — kształt GTFS potrafi
// jechać łącznicą zbierającą jeszcze 40 m dalej na zewnątrz i wtedy z trasy
// wyrasta hak.
//
// Ten moduł zastępuje obie jezdnie (i wszystko inne narysowane blisko osi, co
// wozi wyłącznie linie tego korytarza) JEDNĄ linią biegnącą środkiem. Działa
// tylko na ręcznie wypisanych korytarzach i celowo NIE jest automatem: 43%
// długości sieci Trójmiasta ma gdzieś równoległego bliźniaka, więc zwinięcie
// wszystkiego przerysowałoby każdą główną arterię w mieście.
//
// Poza buforem korytarza nic się nie rusza. Kawałki wchodzące do korytarza są
// dociągane do punktu na osi, w którym w niego wchodzą, więc nic się nie urywa —
// na końcach zostaje naturalny rozwidlony wjazd w węzeł.

const hyp = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Sklejenie listy wayów w jedną łamaną; każdy kolejny way obracany tak, żeby
// dotykał końca poprzedniego.
function chainWays(ids, graph) {
  let out = null;
  for (const id of ids) {
    const w = graph.ways.get(id);
    if (!w) return { err: `way ${id} nie trafił do grafu (odcięty przez wayAccess?)` };
    let g = w.nodeIds.map((n) => graph.nodes.get(n)).filter(Boolean).map((n) => [n.x, n.y]);
    if (g.length < 2) return { err: `way ${id} bez geometrii` };
    if (!out) { out = g; continue; }
    const t = out[out.length - 1];
    const d0 = hyp(t, g[0]), d1 = hyp(t, g[g.length - 1]);
    if (d1 < d0) g = g.slice().reverse();
    if (Math.min(d0, d1) > 1) return { err: `przerwa ${Math.round(Math.min(d0, d1))} m przed way ${id}` };
    out = out.concat(g.slice(1));
  }
  return { poly: out };
}

function resample(poly, step) {
  const out = [poly[0]];
  let carry = 0;
  for (let i = 1; i < poly.length; i++) {
    const [x1, y1] = poly[i - 1], [x2, y2] = poly[i];
    const L = Math.hypot(x2 - x1, y2 - y1);
    if (!L) continue;
    let t = 0;
    while (carry + L - t >= step) { t += step - carry; carry = 0; out.push([x1 + (x2 - x1) * t / L, y1 + (y2 - y1) * t / L]); }
    carry += L - t;
  }
  out.push(poly[poly.length - 1]);
  return out;
}

// Rzut punktu na łamaną: odległość, punkt i pozycja łukowa.
function makeProjector(poly) {
  const cum = [0];
  for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + hyp(poly[i - 1], poly[i]));
  const L = cum[cum.length - 1];
  const project = (p) => {
    let bd = Infinity, bs = 0;
    for (let i = 1; i < poly.length; i++) {
      const [x1, y1] = poly[i - 1], [x2, y2] = poly[i];
      const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
      let t = L2 ? ((p[0] - x1) * dx + (p[1] - y1) * dy) / L2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(p[0] - x1 - t * dx, p[1] - y1 - t * dy);
      if (d < bd) { bd = d; bs = cum[i - 1] + t * Math.sqrt(L2); }
    }
    return { d: bd, s: bs };
  };
  const at = (s) => {
    s = Math.max(0, Math.min(L, s));
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const seg = cum[i] - cum[i - 1] || 1;
    const t = (s - cum[i - 1]) / seg;
    return [poly[i - 1][0] + (poly[i][0] - poly[i - 1][0]) * t, poly[i - 1][1] + (poly[i][1] - poly[i - 1][1]) * t];
  };
  // Wycinek [s0, s1] z zachowanymi wierzchołkami pośrednimi. `forced` to pozycje,
  // w których w oś wchodzi odnoga węzła — muszą zostać WIERZCHOŁKAMI, inaczej
  // odnoga dotyka osi w środku odcinka i kontrola spójności (szycie szwów,
  // audyt) czyta linię jako rozerwaną, mimo że rysuje się bez szpary.
  const slice = (s0, s1, forced = []) => {
    const [a, b] = s0 <= s1 ? [s0, s1] : [s1, s0];
    const stops = [...cum, ...forced].filter((v) => v > a + 0.05 && v < b - 0.05).sort((x, y) => x - y);
    const out = [at(a)];
    for (const v of stops) out.push(at(v));
    out.push(at(b));
    return s0 <= s1 ? out : out.reverse();
  };
  return { project, at, slice, L };
}

// Oś korytarza: środek między jezdniami, ucięty tam, gdzie jezdnie przestają być
// parą (w węźle rozjeżdżają się na łącznice i wtedy środek nic już nie znaczy).
function buildAxis(A, B0, step, maxSep) {
  let B = B0;
  if (hyp(B[0], A[0]) > hyp(B[B.length - 1], A[0])) B = B.slice().reverse();
  const pb = makeProjector(B);
  const pts = [];
  let lastS = -Infinity;
  for (const p of resample(A, step)) {
    const n = pb.project(p);
    if (n.s < lastS - 5) continue;               // rzut cofnął się — pomijamy
    lastS = Math.max(lastS, n.s);
    const q = pb.at(n.s);
    pts.push({ p: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], sep: n.d });
  }
  let lo = 0, hi = pts.length - 1;
  while (lo < hi && pts[lo].sep > maxSep) lo++;
  while (hi > lo && pts[hi].sep > maxSep) hi--;
  const kept = pts.slice(lo, hi + 1);
  const seps = kept.map((k) => k.sep).sort((a, b) => a - b);
  return {
    poly: kept.map((k) => k.p),
    trimmed: pts.length - kept.length,
    sepMin: seps[0], sepMax: seps[seps.length - 1], sepMid: seps[(seps.length / 2) | 0],
  };
}

/**
 * @param specs  lista korytarzy: {label, mode, name, lines, a, b, maxSep, buffer}
 * @param ctx    {graph, proj, streetFeatures, routeFeatures, mode, colorOf, runFlags, numSort, round6, log}
 * @returns      nowa tablica streetFeatures (routeFeatures są modyfikowane w miejscu)
 */
export function collapseCorridors(specs, ctx) {
  const { graph, proj, routeFeatures, mode, colorOf, runFlags, numSort, round6, log } = ctx;
  let streetFeatures = ctx.streetFeatures;
  for (const spec of specs) {
    if (spec.mode !== mode) continue;
    const ca = chainWays(spec.a, graph), cb = chainWays(spec.b, graph);
    if (ca.err || cb.err) { log(`  KORYTARZ ${spec.label}: POMINIĘTY — ${ca.err || cb.err}`); continue; }
    const ax = buildAxis(ca.poly, cb.poly, spec.step || 8, spec.maxSep);
    if (ax.poly.length < 2) { log(`  KORYTARZ ${spec.label}: POMINIĘTY — pusta oś`); continue; }
    const P = makeProjector(ax.poly);
    const lineSet = new Set(spec.lines);
    const EDGE = 0.5;
    const toXY = (c) => proj.toXY(c[1], c[0]);
    const toLL = ([x, y]) => { const [lon, lat] = proj.toLonLat(x, y); return [round6(lon), round6(lat)]; };

    const kept = [], cover = [], attach = [];
    let absorbed = 0, absorbedM = 0;
    for (const f of streetFeatures) {
      const p = f.properties;
      if (p.mode !== mode || !p.arr.every((l) => lineSet.has(l))) { kept.push(f); continue; }
      const xy = f.geometry.coordinates.map(toXY);
      const pr = xy.map((q) => P.project(q));
      const inside = pr.map((q) => q.d <= spec.buffer && q.s > EDGE && q.s < P.L - EDGE);
      if (!inside.some(Boolean)) { kept.push(f); continue; }
      absorbed++;
      // podział na naprzemienne odcinki wewnątrz/na zewnątrz korytarza
      let i = 0;
      while (i < inside.length) {
        let j = i;
        while (j + 1 < inside.length && inside[j + 1] === inside[i]) j++;
        if (inside[i]) {
          const ss = pr.slice(i, j + 1).map((q) => q.s);
          cover.push({ s0: Math.min(...ss), s1: Math.max(...ss), arr: p.arr });
          for (let k = i + 1; k <= j; k++) absorbedM += hyp(xy[k - 1], xy[k]);
        } else {
          const coords = f.geometry.coordinates.slice(i, j + 1);
          // dociągnięcie do osi w miejscu wejścia w korytarz — bez tego zostaje szpara
          if (i > 0) { attach.push(pr[i - 1].s); coords.unshift(toLL(P.at(pr[i - 1].s))); }
          if (j + 1 < inside.length) { attach.push(pr[j + 1].s); coords.push(toLL(P.at(pr[j + 1].s))); }
          if (coords.length >= 2) kept.push({ ...f, geometry: { type: 'LineString', coordinates: coords } });
        }
        i = j + 1;
      }
    }
    if (!cover.length) { log(`  KORYTARZ ${spec.label}: nic nie trafiło w bufor`); continue; }

    // pokrycie osi: elementarne przedziały ze wspólnym składem linii, sklejane
    const cuts = [...new Set(cover.flatMap((c) => [c.s0, c.s1]))].sort((a, b) => a - b);
    const pieces = [];
    for (let i = 1; i < cuts.length; i++) {
      const a = cuts[i - 1], b = cuts[i];
      if (b - a < 0.5) continue;
      const mid = (a + b) / 2, set = new Set();
      for (const c of cover) if (c.s0 <= mid && c.s1 >= mid) for (const l of c.arr) set.add(l);
      if (!set.size) continue;
      const key = [...set].sort(numSort).join(', ');
      const prev = pieces[pieces.length - 1];
      if (prev && prev.key === key && Math.abs(prev.s1 - a) < 0.5) prev.s1 = b;
      else pieces.push({ s0: a, s1: b, key });
    }
    let emittedM = 0;
    for (const pc of pieces) {
      const arr = pc.key.split(', ');
      const coords = P.slice(pc.s0, pc.s1, attach).map(toLL);
      emittedM += pc.s1 - pc.s0;
      kept.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: { name: spec.name, lines: pc.key, arr, roundabout: 0, mode, color: colorOf(arr), ...runFlags(arr) },
      });
    }
    streetFeatures = kept;

    // ta sama oś w route.geojson, żeby podświetlenie linii i planer jechały tym,
    // co narysowane
    for (const rf of routeFeatures) {
      if (rf.properties.mode !== mode || !lineSet.has(rf.properties.line)) continue;
      const xy = rf.geometry.coordinates.map(toXY);
      const pr = xy.map((q) => P.project(q));
      const inside = pr.map((q) => q.d <= spec.buffer && q.s > EDGE && q.s < P.L - EDGE);
      if (!inside.some(Boolean)) continue;
      const out = [];
      let i = 0;
      while (i < inside.length) {
        let j = i;
        while (j + 1 < inside.length && inside[j + 1] === inside[i]) j++;
        if (inside[i]) out.push(...P.slice(pr[i].s, pr[j].s).map(toLL));
        else out.push(...rf.geometry.coordinates.slice(i, j + 1));
        i = j + 1;
      }
      rf.geometry.coordinates = out;
    }

    log(`  KORYTARZ ${spec.label}: oś ${Math.round(P.L)} m (rozstaw jezdni ${ax.sepMin.toFixed(1)}–${ax.sepMax.toFixed(1)} m, ` +
        `mediana ${ax.sepMid.toFixed(1)}), ${absorbed} kawałków / ${Math.round(absorbedM)} m wciągniętych, ` +
        `${pieces.length} nowych odcinków / ${Math.round(emittedM)} m, ucięte końce w węzłach: ${ax.trimmed} próbek`);
  }
  return streetFeatures;
}
