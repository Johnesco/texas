"""Build data/precincts.json.gz: where each county's voters live and how each neighborhood votes, for the ?voters=1 view.

Results for 2026 are known by county only. Precinct (VTD) results for 2026 aren't published yet, so this uses the
pattern of the 2024 U.S. Senate race (Allred vs. Cruz) inside each county:

  * each county's 2026 votes for each party are shared among its 2024 voting districts (VTDs) in proportion to that
    party's 2024 votes there (done in the browser, so each county still adds up exactly to its 2026 result);
  * inside a VTD, its voters are shared among its census blocks in proportion to their population 18 and over, and
    placed at random within a circle the size of the block's land area.

Sources (downloaded into data/raw/census-dl/, which is not committed):
  * Texas Legislative Council, Capitol Data Portal, 2024 General Election, U.S. Senator, results by VTD:
    https://ted.capitol.texas.gov/api/Offices/510/2/vtd
  * Texas Legislative Council, VTDs_24PG (2024 primary and general election VTD boundaries):
    https://data.capitol.texas.gov/dataset/vtds
  * U.S. Census Bureau, 2020 Census Redistricting Data (P.L. 94-171), Texas: each block's internal point, land area and
    population 18 and over (P3_001N). Downloaded by scripts/build_blockgroups.py.

Output: { meta, counties: { fips: [[dem24, rep24, other24, blocks], ...] }, hot } with one entry per VTD; blocks is a flat
list [lon, lat, radius, adults, ...]: lon/lat in 1e-4 degree steps, delta-encoded within the VTD; radius in units of 10 m.
hot: each county's most crowded spot (adults per square mile within half a mile of a census block), for the close-ups.

Run:  python scripts/build_precincts.py
"""
import csv
import io
import json
import math
import struct
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DL = ROOT / "data" / "raw" / "census-dl"
SEN_URL = "https://ted.capitol.texas.gov/api/Offices/510/2/vtd"
VTD_URL = ("https://data.capitol.texas.gov/dataset/4d8298d0-d176-4c19-b174-42837027b73e/resource/"
           "906f47e4-4e39-4156-b1bd-4969be0b2780/download/vtds_24pg.zip")
PL_ZIP = DL / "pl" / "tx2020.pl.zip"
TX_ADULTS = 21_866_700
Q = 1e4


def fetch(url, path):
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        print("downloading", url)
        urllib.request.urlretrieve(url, path)
    return path


# ---------- 2024 U.S. Senate votes by VTD ----------
sen = {}
with open(fetch(SEN_URL, DL / "tlc" / "sen24_vtd.json"), encoding="utf-8") as f:
    rows = csv.reader(f)
    head = next(rows)
    iD = next(i for i, h in enumerate(head) if h.startswith("AllredD"))
    iR = next(i for i, h in enumerate(head) if h.startswith("CruzR"))
    others = [i for i, h in enumerate(head) if "_24G_" in h and i not in (iD, iR)]
    for r in rows:
        key = int(r[1])
        sen[key] = (r[0], int(r[iD]), int(r[iR]), sum(int(r[i]) for i in others))
tot = [sum(v[k] for v in sen.values()) for k in (1, 2, 3)]
print(f"{len(sen):,} VTDs; 2024 Senate: Allred {tot[0]:,}, Cruz {tot[1]:,}, others {tot[2]:,}")

# ---------- VTD shapes (Lambert conformal conic, meters) -> lon/lat ----------
A, F_ = 6378137.0, 1 / 298.257222101
E = math.sqrt(2 * F_ - F_ * F_)
L0, P1, P2, PO, FE, FN = map(math.radians, (-100.0, 27.41666666666667, 34.91666666666666, 31.16666666666667, 0, 0))
FE, FN = 1_000_000.0, 1_000_000.0
m = lambda p: math.cos(p) / math.sqrt(1 - (E * math.sin(p)) ** 2)
t = lambda p: math.tan(math.pi / 4 - p / 2) / ((1 - E * math.sin(p)) / (1 + E * math.sin(p))) ** (E / 2)
N = (math.log(m(P1)) - math.log(m(P2))) / (math.log(t(P1)) - math.log(t(P2)))
FF = m(P1) / (N * t(P1) ** N)
RHO0 = A * FF * t(PO) ** N


def inv(x, y):
    x, y = x - FE, RHO0 - (y - FN)
    rho = math.copysign(math.hypot(x, y), N)
    tt = (rho / (A * FF)) ** (1 / N)
    lam = math.atan2(x, y) / N + L0
    phi = math.pi / 2 - 2 * math.atan(tt)
    for _ in range(6):
        phi = math.pi / 2 - 2 * math.atan(tt * ((1 - E * math.sin(phi)) / (1 + E * math.sin(phi))) ** (E / 2))
    return math.degrees(lam), math.degrees(phi)


z = zipfile.ZipFile(fetch(VTD_URL, DL / "tlc" / "vtds_24pg.zip"))
dbf = z.read("VTDs_24PG.dbf")
n, hlen, rlen = struct.unpack("<IHH", dbf[4:12])
fields, off, s = {}, 32, 1
while dbf[off] != 0x0D:
    name, ln = dbf[off:off + 11].split(b"\0")[0].decode(), dbf[off + 16]
    fields[name] = (s, ln); s += ln; off += 32
fld = lambda i, name: dbf[hlen + i * rlen + fields[name][0]: hlen + i * rlen + fields[name][0] + fields[name][1]].decode().strip()
shp = z.read("VTDs_24PG.shp")
vtds, pos, i = [], 100, 0
while pos < len(shp):
    _, clen = struct.unpack(">II", shp[pos:pos + 8])
    rec = shp[pos + 8: pos + 8 + clen * 2]; pos += 8 + clen * 2
    rings = []
    if struct.unpack("<i", rec[:4])[0] == 5:
        nparts, npts = struct.unpack("<ii", rec[36:44])
        parts = struct.unpack(f"<{nparts}i", rec[44:44 + 4 * nparts])
        pts = struct.unpack(f"<{2 * npts}d", rec[44 + 4 * nparts: 44 + 4 * nparts + 16 * npts])
        for p in range(nparts):
            a, b = parts[p], parts[p + 1] if p + 1 < nparts else npts
            rings.append([inv(pts[2 * k], pts[2 * k + 1]) for k in range(a, b)])
    key = int(float(fld(i, "VTDKEY")))
    cnty = int(fld(i, "CNTY"))
    vtds.append({"key": key, "fips": f"48{cnty:03d}", "rings": rings,
                 "areaM2": float(fld(i, "Shape_area"))})
    i += 1
print(f"{len(vtds):,} VTD shapes")
missing = set(sen) - {v["key"] for v in vtds}
assert not missing, f"VTDs with votes but no shape: {sorted(missing)[:10]}"

# ---------- census blocks: internal point, land area, adults ----------
pl = zipfile.ZipFile(PL_ZIP)
blk = {}
with pl.open("txgeo2020.pl") as f:
    for line in io.TextIOWrapper(f, encoding="latin-1"):
        r = line.rstrip("\n").split("|")
        if r[2] == "750":
            # from the end: AREALAND, AREAWATR, BASENAME, NAME, FUNCSTAT, GCUNI, POP100, HU100, INTPTLAT, INTPTLON, LSADC, PARTFLAG, UGA
            blk[r[7]] = [r[8].split("US")[1][:5], float(r[-4]), float(r[-5]), float(r[-13]), 0]
with pl.open("tx000022020.pl") as f:
    for line in io.TextIOWrapper(f, encoding="latin-1"):
        r = line.split("|", 6)
        b = blk.get(r[4])
        if b: b[4] = int(r[5])
blocks = [b for b in blk.values() if b[4] > 0]
assert sum(b[4] for b in blk.values()) == TX_ADULTS
print(f"{len(blk):,} blocks, {len(blocks):,} with adults")


# ---------- each block to the VTD that contains its internal point ----------
def inside(x, y, rings):
    c = False
    for r in rings:  # even-odd over every ring handles holes and multipart shapes
        j = len(r) - 1
        for k in range(len(r)):
            xi, yi = r[k]; xj, yj = r[j]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                c = not c
            j = k
    return c


CELL = 0.05
by_cnty = defaultdict(list)
for v in vtds:
    xs = [p[0] for r in v["rings"] for p in r]; ys = [p[1] for r in v["rings"] for p in r]
    if not xs: continue
    v["box"] = (min(xs), min(ys), max(xs), max(ys))
    v["c"] = ((v["box"][0] + v["box"][2]) / 2, (v["box"][1] + v["box"][3]) / 2)
    v["blocks"] = []
    by_cnty[v["fips"]].append(v)
grid = {}
for fips, vs in by_cnty.items():
    g = defaultdict(list)
    for v in vs:
        x0, y0, x1, y1 = v["box"]
        for gx in range(int(x0 // CELL), int(x1 // CELL) + 1):
            for gy in range(int(y0 // CELL), int(y1 // CELL) + 1):
                g[(gx, gy)].append(v)
    grid[fips] = g
unplaced = 0
for b in blocks:
    fips, x, y = b[0], b[1], b[2]
    cand = grid.get(fips, {}).get((int(x // CELL), int(y // CELL)), [])
    hit = next((v for v in cand if v["box"][0] <= x <= v["box"][2] and v["box"][1] <= y <= v["box"][3] and inside(x, y, v["rings"])), None)
    if hit is None:  # on an edge or a sliver gap: the VTD in the same county with the nearest center
        unplaced += 1
        hit = min(by_cnty[fips], key=lambda v: (v["c"][0] - x) ** 2 + (v["c"][1] - y) ** 2)
    hit["blocks"].append(b)
print(f"blocks matched by nearest VTD instead of containment: {unplaced:,}")

# ---------- write ----------
counties, no_blocks = defaultdict(list), 0
for v in vtds:
    if v["key"] not in sen or "blocks" not in v: continue
    _, d, r, o = sen[v["key"]]
    if d + r + o == 0: continue
    bl = v["blocks"]
    if not bl:  # votes but no adults on record: one circle the size of the VTD at its center
        no_blocks += 1
        bl = [[v["fips"], v["c"][0], v["c"][1], v["areaM2"], 1]]
    flat, px, py = [], 0, 0
    for _, x, y, area, adults in bl:
        qx, qy = round(x * Q), round(y * Q)
        flat += [qx - px, qy - py, max(1, round(math.sqrt(area / math.pi) / 10)), adults]
        px, py = qx, qy
    counties[v["fips"]].append([d, r, o, flat])
assert len(counties) == 254, len(counties)
print(f"VTDs with votes but no adults on record (placed as one circle): {no_blocks}")

# ---------- each county's most crowded spot: adults per square mile within HOT_R miles of a block ----------
HOT_R, HC = 0.5, 0.01  # radius (miles); grid cell (degrees, about 0.6-0.7 miles)
hot = {}
blocks_by_cnty = defaultdict(list)
for b in blocks: blocks_by_cnty[b[0]].append(b)
for fips, bs in blocks_by_cnty.items():
    g = defaultdict(list)
    for b in bs: g[(int(b[1] // HC), int(b[2] // HC))].append(b)
    best = None
    for b in bs:
        x, y, kx = b[1], b[2], 69.05 * math.cos(math.radians(b[2]))
        gx, gy, s = int(x // HC), int(y // HC), 0
        for i in (-1, 0, 1):
            for j in (-1, 0, 1):
                for o in g.get((gx + i, gy + j), ()):
                    if ((o[1] - x) * kx) ** 2 + ((o[2] - y) * 69.05) ** 2 <= HOT_R ** 2: s += o[4]
        if best is None or s > best[2]: best = (x, y, s)
    hot[fips] = [round(best[0], 4), round(best[1], 4), round(best[2] / (math.pi * HOT_R ** 2))]
out = {
    "meta": {
        "race": "2024 general election, U.S. Senator (Allred D, Cruz R; others = all other candidates), by VTD",
        "resultsSource": "Texas Legislative Council, Capitol Data Portal, 2024 General Election, U.S. Senator by VTD",
        "resultsUrl": SEN_URL,
        "shapesSource": "Texas Legislative Council, VTDs_24PG (2024 VTD boundaries)",
        "shapesUrl": "https://data.capitol.texas.gov/dataset/vtds",
        "blocksSource": "U.S. Census Bureau, 2020 Census Redistricting Data (P.L. 94-171): block internal points, land area, P3_001N",
        "format": "counties[fips] = [[dem24, rep24, other24, blocks]...], one per VTD; blocks = [dlon, dlat, radius, adults, ...]: "
                  "lon/lat in 1e-4 degrees, delta-encoded within the VTD (the first is absolute); radius in 10 m units. "
                  "hot[fips] = [lon, lat, adults per square mile within half a mile]: the county's most crowded spot.",
        "totals2024": {"dem": tot[0], "rep": tot[1], "other": tot[2]},
    },
    "counties": counties,
    "hot": hot,
}
# gzipped (mtime 0, so a rebuild with the same data gives the same file); dots.js unzips it in the browser
import gzip
path = ROOT / "data" / "precincts.json.gz"
path.write_bytes(gzip.compress(json.dumps(out, separators=(",", ":")).encode("utf-8"), 9, mtime=0))
print(f"wrote {path} ({path.stat().st_size / 1e6:.1f} MB)")
