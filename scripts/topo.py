"""Minimal TopoJSON builder: shared-arc extraction, topology-preserving Douglas-Peucker, quantize + delta encode.

Neighbouring polygons share identical vertices in the source (admdongkor), so shared borders are cut into
arcs at junction points and each arc is simplified once — neighbours stay gap-free after simplification.
"""
import math


def _dp(pts, tol):
    """Douglas-Peucker on an open polyline of integer points; keeps both endpoints."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (x1, y1), (x2, y2) = pts[a], pts[b]
        dx, dy = x2 - x1, y2 - y1
        L = math.hypot(dx, dy)
        best, bi = -1.0, -1
        for i in range(a + 1, b):
            x0, y0 = pts[i]
            d = abs(dy * x0 - dx * y0 + x2 * y1 - y2 * x1) / L if L else math.hypot(x0 - x1, y0 - y1)
            if d > best:
                best, bi = d, i
        if bi > 0 and best > tol:
            keep[bi] = True
            stack += [(a, bi), (bi, b)]
    return [p for p, k in zip(pts, keep) if k]


def build(objects, n=100000, tol=0.0):
    """objects: {name: [(properties, [polygon, ...]), ...]} with polygon = [ring, ...], ring = [(lon, lat), ...].
    tol is in degrees. Returns a TopoJSON dict."""
    allpts = [p for geoms in objects.values() for _, polys in geoms for poly in polys for r in poly for p in r]
    x0, y0 = min(p[0] for p in allpts), min(p[1] for p in allpts)
    x1, y1 = max(p[0] for p in allpts), max(p[1] for p in allpts)
    kx, ky = (x1 - x0) / (n - 1), (y1 - y0) / (n - 1)
    q = lambda p: (round((p[0] - x0) / kx), round((p[1] - y0) / ky))
    tol_q = tol / kx

    # quantized rings, consecutive duplicates removed, closed
    rings = []  # (obj, geom_i, poly_i, ring_i, pts)
    for name, geoms in objects.items():
        for gi, (_, polys) in enumerate(geoms):
            for pi, poly in enumerate(polys):
                for ri, ring in enumerate(poly):
                    pts = []
                    for p in ring:
                        qp = q(p)
                        if not pts or pts[-1] != qp:
                            pts.append(qp)
                    if pts[0] != pts[-1]:
                        pts.append(pts[0])
                    if len(pts) >= 4:
                        rings.append((name, gi, pi, ri, pts))

    # edge owners -> junction points (incident edges with different owner sets)
    owners = {}
    for idx, (*_, pts) in enumerate(rings):
        for a, b in zip(pts, pts[1:]):
            owners.setdefault((a, b) if a < b else (b, a), set()).add(idx)
    inc = {}
    for (a, b), o in owners.items():
        fs = frozenset(o)
        inc.setdefault(a, set()).add(fs)
        inc.setdefault(b, set()).add(fs)
    junction = {p for p, s in inc.items() if len(s) > 1}

    arcs, arc_index = [], {}

    def add_arc(seq):
        key, rkey = tuple(seq), tuple(reversed(seq))
        if key in arc_index:
            return arc_index[key]
        if rkey in arc_index:
            return ~arc_index[rkey]
        arcs.append(seq)
        arc_index[key] = len(arcs) - 1
        return len(arcs) - 1

    def canon_closed(pts):
        ring = pts[:-1]
        i = ring.index(min(ring))
        fwd = ring[i:] + ring[:i]
        rev = list(reversed(fwd))
        rev = rev[-1:] + rev[:-1]
        return (fwd, False) if fwd <= rev else (rev, True)

    out = {name: [[None] * len(polys) for _, polys in geoms] for name, geoms in objects.items()}
    for name, gi, pi, ri, pts in rings:
        ring = pts[:-1]
        cuts = [i for i, p in enumerate(ring) if p in junction]
        refs = []
        if not cuts:
            seq, flipped = canon_closed(pts)
            seq = seq + [seq[0]]
            r = add_arc(seq)
            refs = [~r if flipped else r]
        else:
            s = cuts[0]
            rot = ring[s:] + ring[:s] + [ring[s]]
            jset = [i for i, p in enumerate(rot) if p in junction]
            for a, b in zip(jset, jset[1:]):
                refs.append(add_arc(rot[a:b + 1]))
        polys = out[name][gi]
        if polys[pi] is None:
            polys[pi] = []
        polys[pi].append(refs)

    # simplify each unique arc once; closed arcs keep >= 4 points
    simp = []
    for a in arcs:
        if a[0] == a[-1]:
            far = max(range(len(a)), key=lambda i: (a[i][0] - a[0][0]) ** 2 + (a[i][1] - a[0][1]) ** 2)
            s1, s2 = _dp(a[:far + 1], tol_q), _dp(a[far:], tol_q)
            r = s1 + s2[1:]
            if len(r) < 4:
                r = a if len(a) <= 5 else [a[0], a[len(a) // 3], a[2 * len(a) // 3], a[0]]
            simp.append(r)
        else:
            simp.append(_dp(a, tol_q))

    enc = []
    for a in simp:
        d, px, py = [], 0, 0
        for x, y in a:
            d.append([x - px, y - py])
            px, py = x, y
        enc.append(d)

    topo_objs = {}
    for name, geoms in objects.items():
        gs = []
        for gi, (props, _) in enumerate(geoms):
            polys = [p for p in out[name][gi] if p]
            gs.append({"type": "MultiPolygon", "arcs": polys, "properties": props})
        topo_objs[name] = {"type": "GeometryCollection", "geometries": gs}
    return {"type": "Topology", "transform": {"scale": [kx, ky], "translate": [x0, y0]},
            "objects": topo_objs, "arcs": enc}
