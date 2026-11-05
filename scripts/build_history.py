"""Build data/results-history.json: Texas general elections 2008-2024, county results for the major statewide races
(President, U.S. Senate, Governor, Lieutenant Governor, Attorney General: whichever were on the ballot that year).

Sources (snapshots saved in data/raw/):
  * 2008-2018: Texas Secretary of State, Election History (official canvassed results), race results by county,
    https://elections.sos.state.tx.us/elchist<election id>_race<race id>.htm  -> data/raw/sos-<year>-<race>.htm
  * 2020-2024: Texas Secretary of State, election results site (results.texas-election.com), final county results,
    https://results.texas-election.com/static/data/election/<election id>/<version>/County.json
    That site refuses scripted downloads, so the files were read in a web browser and the five major races were
    extracted from them as [fips, Democratic, Republican, total] rows plus each candidate's statewide total
    -> data/raw/sos-enr-<year>-extract.json. During extraction every county's candidate votes were checked to add up to
    its race total, and every candidate's county votes to add up to that candidate's total in the site's statewide file.

Counties are written in the same order as data/results-2026.json (run scripts/build_data.py first).

Run:  python scripts/build_history.py
The script stops with an error if any check fails.
"""
import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
norm = lambda s: re.sub(r"[^A-Z]", "", s.upper())
clean = lambda s: re.sub(r"\s+", " ", s).strip()

# race slug -> (display label, office name in the SOS 2020-2024 county files)
RACES = {
    "president": ("President", "PRESIDENT/VICE-PRESIDENT"),
    "u-s-senate": ("U.S. Senate", "U. S. SENATOR"),
    "governor": ("Governor", "GOVERNOR"),
    "lieutenant-governor": ("Lieutenant Governor", "LIEUTENANT GOVERNOR"),
    "attorney-general": ("Attorney General", "ATTORNEY GENERAL"),
}
ORDER = list(RACES)
# 2008-2018 Election History: year -> (election id, date, {race slug: race id})
ELCHIST = {
    2008: (141, "Nov. 4, 2008", {"president": 62, "u-s-senate": 832}),
    2010: (154, "Nov. 2, 2010", {"governor": 833, "lieutenant-governor": 834, "attorney-general": 835}),
    2012: (164, "Nov. 6, 2012", {"president": 62, "u-s-senate": 832}),
    2014: (175, "Nov. 4, 2014", {"u-s-senate": 832, "governor": 833, "lieutenant-governor": 834, "attorney-general": 835}),
    2016: (319, "Nov. 8, 2016", {"president": 62}),
    2018: (331, "Nov. 6, 2018", {"u-s-senate": 832, "governor": 833, "lieutenant-governor": 834, "attorney-general": 835}),
}
ENR = {2020: "Nov. 3, 2020", 2022: "Nov. 8, 2022", 2024: "Nov. 5, 2024"}
PARTY = {"REP": "REP", "DEM": "DEM", "LIB": "L", "GRN": "GRE", "GRE": "GRE", "W-I": "W", "W": "W"}  # -> codes the page uses
# Display casing for the 2020-2024 files, which list names in capitals
NAME_FIX = {"MJ": "MJ", "JD": "JD"}

base = json.loads((ROOT / "data" / "results-2026.json").read_text(encoding="utf-8"))
fips_index = {c["fips"]: i for i, c in enumerate(base["counties"])}
name_index = {norm(c["name"]): i for i, c in enumerate(base["counties"])}
assert len(fips_index) == 254

num = lambda s: int(s.replace(",", ""))
cells = lambda row, tag: [clean(re.sub(r"<[^>]+>", "", x)) for x in re.findall(rf"<{tag}[^>]*>(.*?)</{tag}>", row, re.S)]


def display_name(first, last):
    """'Richard J. (Rick)' + 'Noriega' -> 'Rick Noriega'; 'Ted  Cruz' + '' -> 'Ted Cruz'"""
    nick = re.search(r"\(([^)]+)\)", first)
    if nick:
        first = nick.group(1)
    return clean(f"{first} {last}")


def cap_word(w):
    if w.strip('"') in NAME_FIX:
        return w.replace(w.strip('"'), NAME_FIX[w.strip('"')])
    w = w.capitalize()
    if w.startswith('"'):
        w = '"' + w[1:].capitalize()
    if w.startswith("Mc") and len(w) > 3:
        w = "Mc" + w[2:].capitalize()
    return re.sub(r"'(\w)", lambda m: "'" + m.group(1).upper(), w)  # O'rourke -> O'Rourke


def enr_name(n):
    """'DONALD J. TRUMP/MICHAEL R. PENCE (I)' -> ('Donald J. Trump', True)"""
    inc = n.strip().endswith("(I)")
    n = n.replace("(I)", "").split("/")[0].strip()
    return " ".join("-".join(cap_word(x) for x in p.split("-")) for p in n.split()), inc


races = []

# --- 2008-2018: Election History pages ---------------------------------------------------------
for year, (eid, date, ids) in ELCHIST.items():
    for slug, rid in ids.items():
        page = html.unescape((RAW / f"sos-{year}-{slug.replace('u-s-', 'us-')}.htm").read_text(encoding="latin-1"))
        assert f"{year} General Election" in page, (year, slug)
        head = re.findall(r"<TR><TH.*?</TR>", page, re.S)
        parties = cells(head[-1], "TH")[1:]
        n = parties.index("Votes")
        parties = parties[:n]
        row1 = cells(head[0], "TH")[1:n + 1]
        row2 = cells(head[1], "TH")[1:n + 1] if len(head) == 3 else [""] * n
        if slug == "president":   # row 1 = presidential candidate ("Mitt Romney/"), row 2 = running mate
            names = [x.rstrip("/").strip() for x in row1]
            lasts = [x.split()[-1] for x in names]
        else:                     # row 1 = first names, row 2 = last names (2018: row 1 = full name, row 2 empty)
            names = [display_name(a, b) for a, b in zip(row1, row2)]
            lasts = [re.sub(r",.*", "", b) if b else a.split()[-1] for a, b in zip(row1, row2)]
        rows, statewide = {}, None
        for tr in re.findall(r"<TR ALIGN=right>.*?</TR>", page, re.S):
            c = cells(tr, "TD")
            votes = [num(x) for x in c[1:n + 1]]
            total = num(c[n + 1])
            assert sum(votes) == total, (year, slug, c[0], "candidate votes do not add up to the county total")
            if c[0] == "ALL COUNTIES":
                statewide = votes
            else:
                rows[name_index[norm(c[0])]] = (votes, total)
        assert len(rows) == 254 and statewide, (year, slug, len(rows))
        assert [sum(v[k] for v, _ in rows.values()) for k in range(n)] == statewide, (year, slug, "counties do not add up to the statewide row")
        assert parties.count("DEM") == 1 and parties.count("REP") == 1, (year, slug)
        di, ri = parties.index("DEM"), parties.index("REP")
        cands = sorted((dict(name=nm, last=ls, party=PARTY[p], votes=statewide[k])
                        for k, (nm, ls, p) in enumerate(zip(names, lasts, parties))), key=lambda c: -c["votes"])
        out_rows = [[rows[i][0][di], rows[i][0][ri], rows[i][1] - rows[i][0][di] - rows[i][0][ri], rows[i][1]] for i in range(254)]
        races.append(dict(id=f"{year}-{slug}", year=year, date=date, label=RACES[slug][0], candidates=cands, counties=out_rows,
                          source="Texas Secretary of State, Election History (official canvassed results)",
                          sourceUrl=f"https://elections.sos.state.tx.us/elchist{eid}_race{rid}.htm"))

# --- 2020-2024: results.texas-election.com extracts --------------------------------------------
for year, date in ENR.items():
    x = json.loads((RAW / f"sos-enr-{year}-extract.json").read_text(encoding="utf-8"))
    for slug, (label, office) in RACES.items():
        if office not in x["races"]:
            continue
        r = x["races"][office]
        rows = [None] * 254
        for f, d, p, t in r["counties"]:
            assert d + p <= t
            rows[fips_index[f]] = [d, p, t - d - p, t]
        assert all(rows), (year, slug, "missing counties")
        by_party = {}
        for nm, p, v in r["candidates"]:
            by_party[p] = by_party.get(p, 0) + v
        assert by_party["DEM"] == sum(row[0] for row in rows) and by_party["REP"] == sum(row[1] for row in rows), (year, slug)
        assert sum(v for _, _, v in r["candidates"]) == sum(row[3] for row in rows), (year, slug, "candidate totals vs county totals")
        cands = []
        for nm, p, v in sorted(r["candidates"], key=lambda c: -c[2]):
            disp, _ = enr_name(nm)
            cands.append(dict(name=disp, last=disp.split()[-1], party=PARTY[p], votes=v))
        races.append(dict(id=f"{year}-{slug}", year=year, date=date, label=label, candidates=cands, counties=rows,
                          source="Texas Secretary of State, election results (final county results)",
                          sourceUrl=x["source"]))

races.sort(key=lambda r: (r["year"], ORDER.index(r["id"].split("-", 1)[1])))
out = dict(
    meta=dict(
        retrieved="2026-11-05",
        countyRow="counties[i] = [Democratic votes, Republican votes, all other votes, total votes], in the county order of results-2026.json",
    ),
    races=races,
)
(ROOT / "data" / "results-history.json").write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
print(f"OK: {len(races)} races, 254 counties each; all county and statewide checks passed.")
for r in races:
    d = next(c for c in r["candidates"] if c["party"] == "DEM"); p = next(c for c in r["candidates"] if c["party"] == "REP")
    tot = sum(x[3] for x in r["counties"]); won = sum(1 for x in r["counties"] if x[1] > x[0])
    print(f"  {r['id']:26} {d['name']:24} {100*d['votes']/tot:5.1f}%  {p['name']:18} {100*p['votes']/tot:5.1f}%  R won {won:3} counties  {tot:>10,} votes")
