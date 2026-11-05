"""Build data/results-2026-senate.json from the raw source snapshots in data/raw/.

Sources (snapshots saved in data/raw/):
  * Texas Secretary of State, Election Night Returns API, 2026 November General Election
    (election id 53815), county-level results:
    https://goelect.txelections.civixapps.com/api-ivis-system/api/s3/enr/election/countyInfo/53815
  * Texas Secretary of State statewide results page (used only as a cross-check):
    https://electionresults.sos.state.tx.us/results.html
  * U.S. Census Bureau, 2024 Gazetteer Files, counties (land area, FIPS codes):
    https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_counties_national.zip

Run:  python scripts/build_data.py
The script stops with an error if any check fails.
"""
import base64
import csv
import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
RACE = "U. S. SENATOR"
norm = lambda s: re.sub(r"[^A-Z]", "", s.upper())

# --- Census gazetteer: FIPS, name, land area -------------------------------------------
gaz = {}
with open(RAW / "census-2024-gazetteer-tx-counties.txt", encoding="utf-8") as f:
    for r in csv.DictReader(f, delimiter="\t"):
        r = {k.strip(): v.strip() for k, v in r.items()}
        name = r["NAME"].removesuffix(" County")
        gaz[norm(name)] = dict(fips=r["GEOID"], name=name, landSqMi=float(r["ALAND_SQMI"]))
assert len(gaz) == 254, len(gaz)

# --- SOS county results ------------------------------------------------------------------
sos = json.loads(base64.b64decode(json.loads((RAW / "sos-countyInfo-53815.json").read_text())["upload"]))
assert len(sos) == 254, len(sos)
counties = []
for c in sos.values():
    races = [r for r in c["Races"].values() if r["N"].strip() == RACE]
    assert len(races) == 1, (c["N"], len(races))
    r = races[0]
    by_party = {}
    for cand in r["C"].values():
        by_party[cand["P"]] = by_party.get(cand["P"], 0) + cand["V"]
    assert sum(by_party.values()) == r["T"], c["N"]
    assert set(by_party) <= {"DEM", "REP", "L", "W"}, by_party
    g = gaz[norm(c["N"])]
    counties.append(dict(
        fips=g["fips"], name=g["name"],
        dem=by_party.get("DEM", 0), rep=by_party.get("REP", 0),
        lib=by_party.get("L", 0), writein=by_party.get("W", 0), total=r["T"],
        precinctsReporting=r["PR"], precinctsTotal=r["TP"], landSqMi=g["landSqMi"],
    ))
counties.sort(key=lambda c: c["fips"])
assert len({c["fips"] for c in counties}) == 254

# --- Cross-check against the SOS statewide page ------------------------------------------
page = html.unescape((RAW / "sos-results-statewide.html").read_text(encoding="utf-8"))
block = page[page.index(RACE):]
block = block[: block.index("U. S. REPRESENTATIVE")]
state = {}
for party, votes in re.findall(r'class="party">([^<]+)</td><td class="candidate">[^<]+</td><td class="ballot">([\d,]+)', block):
    state[party] = state.get(party, 0) + int(votes.replace(",", ""))
updated = re.search(r"Updated ([^)]+?)\s*\)", page).group(1).strip()
sums = {
    "REPUBLICAN": sum(c["rep"] for c in counties), "DEMOCRATIC": sum(c["dem"] for c in counties),
    "LIBERTARIAN": sum(c["lib"] for c in counties), "WRITE-IN": sum(c["writein"] for c in counties),
}
assert sums == state, (sums, state)
not_full = [c["name"] for c in counties if c["precinctsReporting"] != c["precinctsTotal"]]

out = dict(
    meta=dict(
        race="2026 U.S. Senate, Texas", dem="James Talarico", rep="Ken Paxton", lib="Ted Brown",
        resultsSource="Texas Secretary of State, Election Night Returns (unofficial results; official canvass pending)",
        resultsUrl="https://goelect.txelections.civixapps.com/ivis-enr-ui/races",
        resultsApi="https://goelect.txelections.civixapps.com/api-ivis-system/api/s3/enr/election/countyInfo/53815",
        resultsUpdated=updated + " (Central)", retrieved="2026-11-04",
        landSource="U.S. Census Bureau, 2024 Gazetteer Files (counties), ALAND_SQMI",
        landUrl="https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html",
        countiesNotFullyReporting=not_full,
    ),
    counties=counties,
)
(ROOT / "data" / "results-2026-senate.json").write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
print(f"OK: 254 counties, statewide sums match SOS page ({updated}): {sums}")
print("Counties not at 100% precincts:", not_full or "none")
