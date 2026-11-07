"""Build data/blockgroups.json: where adults live inside each Texas county, for the one-dot-per-voter views.

We only know how many people voted in each county, not where they live. The dot views (voters.html, and the main map
with ?dot=) place each county's voters among its census block groups in proportion to the block group's population
age 18 and over, then at random inside the block group. Block groups with no adults (parks, water, airports, open
land) get no dots.

Sources (downloaded into data/raw/census-dl/, which is not committed; the script downloads them if missing):
  * U.S. Census Bureau, 2020 Census Redistricting Data (P.L. 94-171) Summary File, Texas: P3_001N, total population
    18 years and over, by block group (summary level 150):
    https://www2.census.gov/programs-surveys/decennial/2020/data/01-Redistricting_File--PL_94-171/Texas/tx2020.pl.zip
  * U.S. Census Bureau, 2020 Cartographic Boundary Files, block groups, Texas, 1:500,000:
    https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_48_bg_500k.zip

Output, per county FIPS: a list of block groups, each [adults, polygons]; a polygon is a list of rings, a ring is
[lon0, lat0, dlon1, dlat1, ...] in 1e-4 degree steps (about 10 m), delta-encoded and simplified to about 30 m.
Also, per county, `hot`: the most crowded spot (adults per square mile within about half a mile), for the close-ups.

Run:  python scripts/build_blockgroups.py
"""
import io
import json
import math
import struct
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DL = ROOT / "data" / "raw" / "census-dl"
PL_URL = "https://www2.census.gov/programs-surveys/decennial/2020/data/01-Redistricting_File--PL_94-171/Texas/tx2020.pl.zip"
BG_URL = "https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_48_bg_500k.zip"
Q = 1e4          # coordinate steps per degree
TOL = 0.0003     # simplification tolerance, degrees (about 30 m)
HOT_R = 0.5      # radius of the "most crowded spot" window, miles
TX_ADULTS = 21_866_700  # 2020 Census, Texas, population 18 and over (P3_001N), the check total


def fetch(url, path):
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        print("downloading", url)
        urllib.request.urlretrieve(url, path)
    return zipfile.ZipFile(path)


# ---------- adults per block group (P.L. 94-171: geo header + segment 2, joined on LOGRECNO) ----------
pl = fetch(PL_URL, DL / "pl" / "tx2020.pl.zip")
logrec = {}
with pl.open("txgeo2020.pl") as f:
    for line in io.TextIOWrapper(f, encoding="latin-1"):
        r = line.split("|")
        if r[2] == "150":  # block group
            logrec[r[7]] = r[8].split("US")[1]  # LOGRECNO -> 12-digit block group GEOID
adults = {}
with pl.open("tx000022020.pl") as f:
    for line in io.TextIOWrapper(f, encoding="latin-1"):
        r = line.split("|", 6)
        if r[4] in logrec:
            adults[logrec[r[4]]] = int(r[5])  # P3_001N
total = sum(adults.values())
assert total == TX_ADULTS, f"adults add up to {total:,}, expected {TX_ADULTS:,}"
print(f"{len(adults):,} block groups, {total:,} adults")


# ---------- block group shapes (shapefile, polygons only) ----------
bgz = fetch(BG_URL, DL / "bg" / "cb_2020_48_bg_500k.zip")
dbf = bgz.read("cb_2020_48_bg_500k.dbf")
n, hlen, rlen = struct.unpack("<IHH", dbf[4:12])
fields, off = [], 32
while dbf[off] != 0x0D:
    name = dbf[off:off + 11].split(b"\0")[0].decode()
    fields.append((name, dbf[off + 16]))
    off += 32
starts, s = {}, 1
for name, ln in fields:
    starts[name] = (s, ln); s += ln
gs, gl = starts["GEOID"]
geoids = [dbf[hlen + i * rlen + gs: hlen + i * rlen + gs + gl].decode().strip() for i in range(n)]

shp = bgz.read("cb_2020_48_bg_500k.shp")
rings_by_bg, pos, i = [], 100, 0
while pos < len(shp):
    _, clen = struct.unpack(">II", shp[pos:pos + 8])
    rec = shp[pos + 8: pos + 8 + clen * 2]
    pos += 8 + clen * 2
    stype = struct.unpack("<i", rec[:4])[0]
    rings = []
    if stype == 5:
        nparts, npts = struct.unpack("<ii", rec[36:44])
        parts = struct.unpack(f"<{nparts}i", rec[44:44 + 4 * nparts])
        pts = struct.unpack(f"<{2 * npts}d", rec[44 + 4 * nparts: 44 + 4 * nparts + 16 * npts])
        for p in range(nparts):
            a, b = parts[p], parts[p + 1] if p + 1 < nparts else npts
            rings.append([(pts[2 * k], pts[2 * k + 1]) for k in range(a, b)])
    rings_by_bg.append(rings)
    i += 1
assert i == n == len(geoids)


def signed_area(r):
    return sum(r[k][0] * r[k + 1][1] - r[k + 1][0] * r[k][1] for k in range(len(r) - 1)) / 2


def simplify(pts, tol):
    """Douglas-Peucker, iterative; keeps the ends."""
    if len(pts) < 5:
        return pts
    keep = [False] * len(pts); keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (x0, y0), (x1, y1) = pts[a], pts[b]
        dx, dy = x1 - x0, y1 - y0
        L = math.hypot(dx, dy) or 1e-12
        best, bi = -1, -1
        for k in range(a + 1, b):
            d = abs(dy * (pts[k][0] - x0) - dx * (pts[k][1] - y0)) / L
            if d > best: best, bi = d, k
        if best > tol:
            keep[bi] = True; stack += [(a, bi), (bi, b)]
    return [p for p, k in zip(pts, keep) if k]


def sqmi(r, lat):
    return abs(signed_area(r)) * 69.05 * 69.05 * math.cos(math.radians(lat))


counties, info = {}, {}
for geoid, rings in zip(geoids, rings_by_bg):
    a = adults.get(geoid, 0)
    if a == 0 or not rings:
        continue
    # shapefile rings: clockwise = outer, counterclockwise = hole (in lon/lat with y up)
    polys = []
    for r in rings:
        if signed_area(r) < 0 or not polys: polys.append([r])
        else: polys[-1].append(r)
    enc, area, cx, cy = [], 0.0, 0.0, 0.0
    lat0 = sum(p[1] for p in rings[0]) / len(rings[0])
    for poly in polys:
        out = []
        for j, r in enumerate(poly):
            # a ring starts and ends on the same point, so simplify it as two halves split at its farthest point
            m = max(range(len(r)), key=lambda k: (r[k][0] - r[0][0]) ** 2 + (r[k][1] - r[0][1]) ** 2)
            s = simplify(r[:m + 1], TOL) + simplify(r[m:], TOL)[1:]
            q = [(round(x * Q), round(y * Q)) for x, y in s]
            q = [p for k, p in enumerate(q) if k == 0 or p != q[k - 1]]
            if len(q) < 4:
                if j == 0: break  # the outer ring vanished: drop the polygon
                continue
            flat = [q[0][0], q[0][1]]
            for k in range(1, len(q)): flat += [q[k][0] - q[k - 1][0], q[k][1] - q[k - 1][1]]
            out.append(flat)
            w = sqmi(r, lat0) * (1 if j == 0 else -1)
            area += w
            if j == 0:
                cx += w * sum(p[0] for p in r) / len(r); cy += w * sum(p[1] for p in r) / len(r)
        if out: enc.append(out)
    if not enc:  # too small to draw at this tolerance: keep it as a tiny square, so its adults still get dots
        x, y = rings[0][0]
        x, y = round(x * Q), round(y * Q)
        enc = [[[x, y, 2, 0, 0, 2, -2, 0, 0, -2]]]
    fips = geoid[:5]
    counties.setdefault(fips, []).append([a, enc])
    if area > 0:
        info.setdefault(fips, []).append((cx / area, cy / area, a, area))

# the most crowded spot in each county: adults per square mile in a circle of HOT_R miles around each block group's
# center (counting block groups whose centers fall inside), taken as a density over the larger of the circle and the
# block groups' own area, so one huge block group doesn't count as crowded
hot = {}
for fips, bgs in info.items():
    best = None
    for x, y, _, _ in bgs:
        kx = 69.05 * math.cos(math.radians(y))
        tot_a = tot_area = 0
        for x2, y2, a2, ar2 in bgs:
            if math.hypot((x2 - x) * kx, (y2 - y) * 69.05) <= HOT_R:
                tot_a += a2; tot_area += ar2
        d = tot_a / max(math.pi * HOT_R ** 2, tot_area)
        if best is None or d > best[2]:
            best = (x, y, d)
    hot[fips] = [round(best[0], 4), round(best[1], 4), round(best[2])]

assert len(counties) == 254, len(counties)
kept = sum(a for bgs in counties.values() for a, _ in bgs)
assert kept == TX_ADULTS, kept
out = {
    "meta": {
        "adultsSource": "U.S. Census Bureau, 2020 Census Redistricting Data (P.L. 94-171), P3_001N (population 18 and over), block groups",
        "adultsUrl": PL_URL,
        "shapesSource": "U.S. Census Bureau, 2020 Cartographic Boundary Files, block groups, 1:500,000",
        "shapesUrl": BG_URL,
        "format": "counties[fips] = [[adults, polygons]...]; polygon = rings; ring = [lon0, lat0, dlon, dlat, ...] in 1e-4 degrees. "
                  "hot[fips] = [lon, lat, adults per square mile within half a mile]: the county's most crowded spot.",
        "adults": TX_ADULTS,
    },
    "counties": counties,
    "hot": hot,
}
path = ROOT / "data" / "blockgroups.json"
path.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
print(f"wrote {path} ({path.stat().st_size / 1e6:.1f} MB), {sum(len(v) for v in counties.values()):,} block groups with adults")
