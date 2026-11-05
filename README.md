# Why Texas looks red

An interactive map of the 2026 U.S. Senate election in Texas (James Talarico (D), Ken Paxton (R), Ted Brown (L)).
It starts as the familiar flat county map, then raises each county into a column whose height is the number of
votes cast there. The point is to show why a map that is mostly red can still belong to a statewide Democratic win.

**Live:** https://johnesco.github.io/texas/

## Key figures (computed from the data file)

| | |
|---|---|
| Counties won | Paxton 214, Talarico 40 |
| Land area of counties won (Census) | Paxton 78%, Talarico 22% |
| Votes cast in counties won | Paxton-won counties 29%, Talarico-won counties 71% |
| Statewide vote | Talarico 5,444,982 (55.1%), Paxton 4,249,373 (43.0%), Brown 190,237, write-ins 5,112; total 9,889,704 |
| Harris County | 1,383,480 votes, more than the 208 smallest counties combined (1,381,337), which cover 83% of the state's land area |

## Data and method

- **Results:** Texas Secretary of State, Election Night Returns, 2026 November General Election (election id 53815),
  county-level results for U.S. Senator, as of 11/04/2026 04:59 PM Central, retrieved 2026-11-04. All precincts are
  reporting in all 254 counties. These results are **unofficial** until the state canvass.
  - Results site: https://goelect.txelections.civixapps.com/ivis-enr-ui/races
  - Data feed: https://goelect.txelections.civixapps.com/api-ivis-system/api/s3/enr/election/countyInfo/53815
  - Statewide page used as a cross-check: https://electionresults.sos.state.tx.us/results.html
- **Land area and FIPS codes:** U.S. Census Bureau, 2024 Gazetteer Files, counties (`ALAND_SQMI`, water excluded).
  https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html
- **County shapes:** U.S. Census Bureau cartographic boundary files, 2017, via
  [us-atlas](https://github.com/topojson/us-atlas) v3.0.1 (`counties-10m.json`).
- **Column height** is proportional to the total votes cast in the Senate race, counting every candidate including
  write-ins, on a linear scale. Counties with very few votes get a thin minimum height so they stay visible.
- **Color** is the county winner's share of all votes cast there, in 10-point bands.

The raw snapshots are in [`data/raw/`](data/raw). [`scripts/build_data.py`](scripts/build_data.py) rebuilds
[`data/results-2026-senate.json`](data/results-2026-senate.json) from them. The script stops with an error unless
all of these hold:

- every one of the 254 counties has exactly one U.S. Senate race
- each county's candidate votes add up to its race total
- every county matches a Census FIPS code
- the county totals for each party add up exactly to the Secretary of State's published statewide totals

```bash
python scripts/build_data.py
```

## Running locally

The page loads its data with `fetch`, so it has to be served over HTTP:

```bash
python -m http.server 8765
```

Then open http://localhost:8765.

Built with [three.js](https://threejs.org) r160, [d3-geo](https://github.com/d3/d3-geo) 3.1.1 and
[topojson-client](https://github.com/topojson/topojson-client) 3.1.0.
