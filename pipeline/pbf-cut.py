#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Cuts the OSM extracts a map's download.sh asks Overpass for out of a
Geofabrik .pbf instead — the same JSON shape ('elements': ways with tags,
node ids and geometry; for the names file: nodes/ways/relations with tags
only), so build.mjs cannot tell the difference. Written 10.09.2026, when every
public Overpass mirror answered 504 for Athens and Bucharest (the wall Berlin,
London, São Paulo, Vienna and Kraków hit before).

usage: pbf-cut-generic.py <pbf> <job>... where a job is
  road:<out.json>:<S,W,N,E>          highway ways (the family's road set)
  rail:<out.json>:<S,W,N,E>          railway=subway|tram|light_rail|rail ways
  names:<out.json>:<S,W,N,E>         nwr with a name and one of the accent keys, tags only
"""
import json, os, re, sys
import osmium

HW = re.compile(r'^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|busway|construction|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$')
RAIL = re.compile(r'^(subway|tram|light_rail|rail)$')
NAME_KEYS = ('amenity', 'place', 'tourism', 'leisure', 'shop', 'building', 'railway', 'public_transport', 'natural', 'waterway', 'landuse', 'historic', 'office', 'man_made')

pbf = sys.argv[1]
jobs = []
for spec in sys.argv[2:]:
    kind, out, box = spec.split(':', 2)
    box = tuple(float(x) for x in box.split(','))
    if os.path.exists(out):
        print('jest już', out, flush=True); continue
    jobs.append((kind, out, box, []))
if not jobs:
    sys.exit(0)


def inside(box, la0, lo0, la1, lo1):
    return la1 >= box[0] and la0 <= box[2] and lo1 >= box[1] and lo0 <= box[3]


class H(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.want_way = any(k in ('road', 'rail') for k, *_ in jobs)
        self.want_names = any(k == 'names' for k, *_ in jobs)

    def _named(self, o, kind, la, lo):
        tags = o.tags
        if 'name' not in tags or not any(k in tags for k in NAME_KEYS):
            return
        for k, out, box, els in jobs:
            if k == 'names' and (la is None or inside(box, la, lo, la, lo)):
                els.append({'type': kind, 'id': o.id, 'tags': {t.k: t.v for t in tags}})

    def node(self, n):
        if not self.want_names:
            return
        try:
            self._named(n, 'node', n.location.lat, n.location.lon)
        except osmium.InvalidLocationError:
            pass

    def relation(self, r):
        if self.want_names:
            self._named(r, 'relation', None, None)   # relations: no cheap location — keep by tags

    def way(self, w):
        tags = w.tags
        hw, rw = tags.get('highway'), tags.get('railway')
        is_road = hw is not None and HW.match(hw)
        is_rail = rw is not None and RAIL.match(rw)
        if not (is_road or is_rail or (self.want_names and 'name' in tags)):
            return
        geom, ids = [], []
        la0, la1, lo0, lo1 = 90.0, -90.0, 180.0, -180.0
        for n in w.nodes:
            try:
                lo, la = n.lon, n.lat
            except osmium.InvalidLocationError:
                continue
            ids.append(n.ref)
            geom.append({'lat': la, 'lon': lo})
            if la < la0: la0 = la
            if la > la1: la1 = la
            if lo < lo0: lo0 = lo
            if lo > lo1: lo1 = lo
        if len(geom) < 2:
            return
        for k, out, box, els in jobs:
            if not inside(box, la0, lo0, la1, lo1):
                continue
            if k == 'road' and is_road or k == 'rail' and is_rail:
                els.append({'type': 'way', 'id': w.id, 'nodes': ids, 'tags': {t.k: t.v for t in tags}, 'geometry': geom})
            elif k == 'names' and 'name' in tags and any(t in tags for t in NAME_KEYS):
                els.append({'type': 'way', 'id': w.id, 'tags': {t.k: t.v for t in tags}})


print('czytam', os.path.basename(pbf), flush=True)
H().apply_file(pbf, locations=True, idx='flex_mem')
for k, out, box, els in jobs:
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    json.dump({'version': 0.6, 'generator': 'pbf-cut-generic.py (Geofabrik ' + os.path.basename(pbf) + ')', 'elements': els}, open(out, 'w'))
    print(f'{k}: {len(els)} -> {out}', flush=True)
print('gotowe', flush=True)
