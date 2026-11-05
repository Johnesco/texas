"""Build data/results-2026.json from the raw source snapshots in data/raw/.

Includes every race in the 2026 November General Election that was on the ballot in all 254
Texas counties (the statewide races).

Sources (snapshots saved in data/raw/):
  * Texas Secretary of State, Election Night Returns API, 2026 November General Election
    (election id 53815), county-level results:
    https://goelect.txelections.civixapps.com/api-ivis-system/api/s3/enr/election/countyInfo/53815
  * Texas Secretary of State statewide results page (used as a cross-check):
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
norm = lambda s: re.sub(r"[^A-Z]", "", s.upper())
# office (as named in the SOS county feed) -> (id used in ?race= links, display label, group)
RACES = {
    "U. S. SENATOR": ("u-s-senate", "U.S. Senate", "Federal"),
    "GOVERNOR": ("governor", "Governor", "State executive"),
    "LIEUTENANT GOVERNOR": ("lieutenant-governor", "Lieutenant Governor", "State executive"),
    "ATTORNEY GENERAL": ("attorney-general", "Attorney General", "State executive"),
    "COMPTROLLER OF PUBLIC ACCOUNTS": ("comptroller", "Comptroller of Public Accounts", "State executive"),
    "COMMISSIONER OF THE GENERAL LAND OFFICE": ("land-commissioner", "Commissioner of the General Land Office", "State executive"),
    "COMMISSIONER OF AGRICULTURE": ("agriculture-commissioner", "Commissioner of Agriculture", "State executive"),
    "RAILROAD COMMISSIONER": ("railroad-commissioner", "Railroad Commissioner", "State executive"),
    "CHIEF JUSTICE, SUPREME COURT": ("supreme-court-chief-justice", "Supreme Court, Chief Justice", "Texas Supreme Court"),
    "JUSTICE, SUPREME COURT, PLACE 2 - UNEXPIRED TERM": ("supreme-court-place-2", "Supreme Court, Place 2 (unexpired term)", "Texas Supreme Court"),
    "JUSTICE, SUPREME COURT, PLACE 7": ("supreme-court-place-7", "Supreme Court, Place 7", "Texas Supreme Court"),
    "JUSTICE, SUPREME COURT, PLACE 8": ("supreme-court-place-8", "Supreme Court, Place 8", "Texas Supreme Court"),
    "JUDGE, COURT OF CRIMINAL APPEALS, PLACE 3": ("criminal-appeals-place-3", "Court of Criminal Appeals, Place 3", "Court of Criminal Appeals"),
    "JUDGE, COURT OF CRIMINAL APPEALS, PLACE 4": ("criminal-appeals-place-4", "Court of Criminal Appeals, Place 4", "Court of Criminal Appeals"),
    "JUDGE, COURT OF CRIMINAL APPEALS, PLACE 9": ("criminal-appeals-place-9", "Court of Criminal Appeals, Place 9", "Court of Criminal Appeals"),
    "CHIEF JUSTICE, 15TH COURT OF APPEALS DISTRICT": ("fifteenth-court-chief-justice", "15th Court of Appeals, Chief Justice", "15th Court of Appeals"),
    "JUSTICE, 15TH COURT OF APPEALS DISTRICT, PLACE 2": ("fifteenth-court-place-2", "15th Court of Appeals, Place 2", "15th Court of Appeals"),
    "JUSTICE, 15TH COURT OF APPEALS DISTRICT, PLACE 3": ("fifteenth-court-place-3", "15th Court of Appeals, Place 3", "15th Court of Appeals"),
}
# Display casing the generic rule can't infer from the SOS's all-capitals names, each checked against a published source.
NAME_FIX = {
    "DIBIANCA": "DiBianca",  # Arthur DiBianca (L, Railroad Commissioner): https://ballotpedia.org/Arthur_DiBianca
}
# the statewide page names this race without the " - UNEXPIRED TERM" suffix used in the county feed
PAGE_ALIAS = {"JUSTICE, SUPREME COURT, PLACE 2 - UNEXPIRED TERM": "JUSTICE, SUPREME COURT, PLACE 2"}


def cap_word(w):
    # The SOS lists names in capitals; display casing: "MCCORMICK" -> "McCormick", "ECHAVARRIA-GARZA" -> "Echavarria-Garza"
    if w in NAME_FIX:
        return NAME_FIX[w]
    w = w.capitalize()
    return "Mc" + w[2:].capitalize() if w.startswith("Mc") and len(w) > 3 else w


def person(n):
    """'GREG ABBOTT (I)' -> ('Greg Abbott', True)"""
    inc = n.strip().endswith("(I)")
    n = n.replace("(I)", "").strip()
    return " ".join("-".join(cap_word(x) for x in p.split("-")) for p in n.split()), inc


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
county_list = sorted((gaz[norm(c["N"])] for c in sos.values()), key=lambda g: g["fips"])
assert len({g["fips"] for g in county_list}) == 254
index = {g["fips"]: i for i, g in enumerate(county_list)}

seen = {}
for c in sos.values():
    for r in c["Races"].values():
        seen.setdefault(r["N"].strip(), []).append(c["N"])
statewide = [n for n, cs in seen.items() if len(cs) == 254]

# --- SOS statewide page, for the cross-check ---------------------------------------------
page = html.unescape((RAW / "sos-results-statewide.html").read_text(encoding="utf-8"))
updated = re.search(r"Updated ([^)]+?)\s*\)", page).group(1).strip()
blocks = re.split(r'<div class="election">', page)[1:]
page_totals = {}
for b in blocks:
    name = b[: b.index("</div>")].strip()
    rows = re.findall(r'class="party">([^<]+)</td><td class="candidate">([^<]+)</td><td class="ballot">([\d,]+)', b.split('<div class="election">')[0])
    page_totals.setdefault(name, {r[1].strip(): int(r[2].replace(",", "")) for r in rows})

races = []
for office in statewide:
    rows = [None] * 254
    cand_totals = {}
    for c in sos.values():
        r = next(r for r in c["Races"].values() if r["N"].strip() == office)
        assert sum(x["V"] for x in r["C"].values()) == r["T"], (office, c["N"])
        assert r["PR"] == r["TP"], (office, c["N"], "precincts not all reporting")
        by = {"DEM": 0, "REP": 0}
        for x in r["C"].values():
            cand_totals.setdefault((x["N"].strip(), x["P"]), 0)
            cand_totals[(x["N"].strip(), x["P"])] += x["V"]
            if x["P"] in by:
                by[x["P"]] += x["V"]
        rows[index[gaz[norm(c["N"])]["fips"]]] = [by["DEM"], by["REP"], r["T"] - by["DEM"] - by["REP"], r["T"]]
    # cross-check every candidate's statewide total against the SOS statewide page
    ours = {n: v for (n, p), v in cand_totals.items()}
    theirs = page_totals[PAGE_ALIAS.get(office, office)]
    assert {norm(k): v for k, v in ours.items()} == {norm(k): v for k, v in theirs.items()}, (office, ours, theirs)
    dems = [k for k in cand_totals if k[1] == "DEM"]
    reps = [k for k in cand_totals if k[1] == "REP"]
    if len(dems) != 1 or len(reps) != 1:
        continue  # only two-party contests are mapped
    cands = []
    for (n, p), v in sorted(cand_totals.items(), key=lambda kv: -kv[1]):
        nm, inc = person(n)
        cands.append(dict(name=nm, last=nm.split()[-1], party=p, incumbent=inc, votes=v))
    rid, label, group = RACES[office]
    races.append(dict(id=rid, office=office, label=label, group=group, candidates=cands, counties=rows))

assert sorted(r["office"] for r in races) == sorted(RACES), "statewide races differ from the RACES table"
order = list(RACES)
races.sort(key=lambda r: order.index(r["office"]))
out = dict(
    meta=dict(
        election="2026 November General Election (Nov. 3, 2026)",
        resultsSource="Texas Secretary of State, Election Night Returns (unofficial results; official canvass pending)",
        resultsUrl="https://goelect.txelections.civixapps.com/ivis-enr-ui/races",
        resultsApi="https://goelect.txelections.civixapps.com/api-ivis-system/api/s3/enr/election/countyInfo/53815",
        resultsUpdated=updated + " (Central)", retrieved="2026-11-04",
        landSource="U.S. Census Bureau, 2024 Gazetteer Files (counties), ALAND_SQMI",
        landUrl="https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html",
        countyRow="counties[i] = [Democratic votes, Republican votes, all other votes, total votes] for meta.counties[i]",
    ),
    counties=[dict(fips=g["fips"], name=g["name"], landSqMi=g["landSqMi"]) for g in county_list],
    races=races,
)
(ROOT / "data" / "results-2026.json").write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
print(f"OK: {len(races)} statewide races, 254 counties each, all precincts reporting; "
      f"every candidate's total matches the SOS statewide page ({updated}).")
for r in races:
    d = next(c for c in r["candidates"] if c["party"] == "DEM"); p = next(c for c in r["candidates"] if c["party"] == "REP")
    print(f"  {r['id']:55} {d['name']} {d['votes']:,} vs {p['name']}{' (inc.)' if p['incumbent'] else ''} {p['votes']:,}")
