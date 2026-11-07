// "See every single voter": an animated flight over Texas with one dot for each person who voted in the 2026 U.S. Senate
// race. It plays on its own, scene by scene, always over the flat map: the whole state, what a dot means, the emptiest
// county, the county with the most voters, down into the most crowded neighborhood in the state until single voters show,
// the same zoom over the emptiest county; then flights over the big metros, and the most crowded spot of seven more
// counties, each close enough to see single voters.
import * as THREE from 'three';
import { geoConicEqualArea, geoCentroid } from 'd3-geo';
import { feature } from 'topojson-client';
import { createDots, countyTris, loadPrecincts, precinctUnits, DOT_C } from './dots.js';

const GEO_URL = 'https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/counties-10m.json';
const $ = id => document.getElementById(id);
const fmt = n => n.toLocaleString('en-US');
const short = n => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n);
const pct = (a, b) => (100 * a / b).toFixed(0) + '%';
const getJSON = url => fetch(url).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });

let res, us;
try { [res, us] = await Promise.all([getJSON('data/results-2026.json'), getJSON(GEO_URL)]); }
catch (e) { $('loading').textContent = 'Could not load the map data. Please reload the page.'; throw e; }

// ---------- data: the 2026 U.S. Senate race, by county ----------
const race = res.races.find(r => r.id === 'u-s-senate');
const counties = res.counties.map((c, i) => {
  const [dem, rep, other, total] = race.counties[i];
  return { ...c, dem, rep, other, total, density: total / c.landSqMi };
});
const byFips = new Map(counties.map(c => [c.fips, c]));
const byName = name => counties.find(c => c.name === name);
const D = race.candidates.find(c => c.party === 'DEM'), R = race.candidates.find(c => c.party === 'REP');
const TOT = counties.reduce((s, c) => s + c.total, 0), OTH = TOT - D.votes - R.votes;
const byDensity = [...counties].sort((a, b) => a.density - b.density);
const EMPTY = byDensity[0], CROWDED = byDensity.at(-1);
const BIGGEST = [...counties].sort((a, b) => b.total - a.total)[0];

// ---------- map geometry (same projection as the other pages) ----------
const geo = feature(us, us.objects.counties);
const tx = { type: 'FeatureCollection', features: geo.features.filter(f => String(f.id).startsWith('48')) };
const projection = geoConicEqualArea().parallels([27.5, 35]).rotate([99.5, 0]).fitExtent([[-500, -500], [500, 500]], tx);
const P = ([lon, lat]) => { const [x, y] = projection([lon, lat]); return new THREE.Vector2(x, -y); };
const ringPts = ring => { const pts = ring.map(P); pts.pop(); return pts; };
// map units per mile, from 0.1 degree of latitude (about 6.9 miles) in the middle of the state
const UPM = P([-99.5, 31]).distanceTo(P([-99.5, 31.1])) / 6.905;

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
$('stage').appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#0e1116');
const FOV = 30, TAN = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 10000);
const mapGroup = new THREE.Group();
mapGroup.rotation.x = -Math.PI / 2; // map x/y in the ground plane; map y becomes world -z (north)
scene.add(mapGroup);

const allEdges = [];
const ordered = []; // counties in the order the dots are placed
for (const f of tx.features) {
  const c = byFips.get(String(f.id)); if (!c) continue;
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  const shapes = polys.map(([outer, ...holes]) => {
    const s = new THREE.Shape(ringPts(outer));
    for (const h of holes) s.holes.push(new THREE.Path(ringPts(h)));
    return s;
  });
  c.tris = countyTris(shapes); // the county's outline, used if the precincts don't load
  const edges = [];
  for (const s of shapes) for (const ring of [s.getPoints(), ...s.holes.map(h => h.getPoints())])
    for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; edges.push(a.x, a.y, 0, b.x, b.y, 0); }
  c.edges = edges; allEdges.push(...edges);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < c.tris.length; i += 2) {
    x0 = Math.min(x0, c.tris[i]); x1 = Math.max(x1, c.tris[i]); y0 = Math.min(y0, c.tris[i + 1]); y1 = Math.max(y1, c.tris[i + 1]);
  }
  c.box = { x0, y0, x1, y1 };
  const cen = P(geoCentroid(f)); c.cx = cen.x; c.cy = cen.y;
  c.hot = { x: c.cx, y: c.cy, voters: c.density };
  ordered.push(c);
}
const lineGeo = pts => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)); return g; };
// faint county lines over the dots, and a bright white outline for the counties a scene is about, from the moment it starts
const borders = new THREE.LineSegments(lineGeo(allEdges),
  new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.13, depthTest: false }));
borders.renderOrder = 1; mapGroup.add(borders);
const focusMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthTest: false });
const focusLine = new THREE.LineSegments(new THREE.BufferGeometry(), focusMat);
focusLine.renderOrder = 2; mapGroup.add(focusLine);

const dots = createDots({ depthTest: false }); // one flat layer: no need for depth
dots.uniforms.uP.value = 0; dots.uniforms.uReveal.value = 0;
mapGroup.add(dots.points);

$('legend').innerHTML = [[DOT_C.dem, `${D.last} (D)`], [DOT_C.rep, `${R.last} (R)`], [DOT_C.other, 'Other']]
  .map(([c, t]) => `<span><i style="background:${c}"></i>${t}</span>`).join('');

// Where to put each county's voters. The 2026 results are by county, so each party's county total is placed by precinct
// the way that party's voters were spread in the 2024 Senate race, then on census blocks by adults (dots.js). If that file
// fails to load, the dots are spread evenly over each county instead.
const HOT_R = 0.5; // miles: a county's "most crowded spot" is the most voters within this distance
$('loading').textContent = 'Loading precincts…';
let PC = null;
try { PC = await loadPrecincts(P); } catch (e) { console.error('Precincts did not load; dots spread evenly', e); }
if (PC) for (const c of ordered) {
  const pc = PC.byFips.get(c.fips); if (!pc) continue;
  c.units = precinctUnits(pc, c);
  const spot = PC.hot?.[c.fips]; if (!spot) continue;
  // voters per square mile within HOT_R of the spot, as the dots will be placed
  const h = P([spot[0], spot[1]]), r2 = (HOT_R * UPM) ** 2, u = c.units;
  let n = 0;
  for (let i = 0; i < u.length; i += 6) if ((u[i] - h.x) ** 2 + (u[i + 1] - h.y) ** 2 <= r2) n += u[i + 3] + u[i + 4] + u[i + 5];
  c.hot = { x: h.x, y: h.y, voters: n / (Math.PI * HOT_R ** 2) };
}
// the most crowded neighborhood in the state
const DENSE = [...ordered].sort((a, b) => b.hot.voters - a.hot.voters)[0];

// ---------- layout: the part of the screen not covered by the caption card ----------
let W = 1, H = 1, area = { w: 1, h: 1, ox: 0, oy: 0 };
function resize() {
  W = $('stage').clientWidth; H = $('stage').clientHeight;
  renderer.setSize(W, H);
  camera.aspect = W / H;
  const wide = W > 760;
  // wide screens: the caption sits on the left, so the map is centered in what's to its right; narrow: above the caption
  area = wide ? { w: W - 440, h: H - 90, ox: -220, oy: 0 } : { w: W, h: H * 0.55, oy: H * 0.2, ox: 0 };
  camera.setViewOffset(W, H, area.ox, area.oy, W, H);
  camera.updateProjectionMatrix();
  dots.uniforms.uViewH.value = H * renderer.getPixelRatio();
}
// A view: the camera looks at map point (x, y) from distance d, tilted `tilt` radians from straight down, from the
// direction `heading` (0 = from the south, looking north).
// camera distance that shows halfW x halfH map units (looking straight down) inside the free area
const fitDist = (halfW, halfH) => Math.max(halfW * H / (TAN * area.w), halfH * H / (TAN * area.h));
const stateView = (tilt = 0.0001, heading = 0) => ({ x: 0, y: 0, d: fitDist(520, 520), tilt, heading });
const boxView = (cs, tilt = 0.0001, heading = 0, pad = 1.3) => {
  const x0 = Math.min(...cs.map(c => c.box.x0)), x1 = Math.max(...cs.map(c => c.box.x1));
  const y0 = Math.min(...cs.map(c => c.box.y0)), y1 = Math.max(...cs.map(c => c.box.y1));
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, d: fitDist(pad * (x1 - x0) / 2, pad * (y1 - y0) / 2), tilt, heading };
};
const countyView = (c, tilt, heading, pad) => boxView([c], tilt, heading, pad);
// a view of `miles` (top to bottom of the free area) around a point, looking straight down
const milesView = (p, miles, tilt = 0.0001, heading = 0) => ({ x: p.x, y: p.y, d: (miles * UPM / 2) * H / (TAN * area.h), tilt, heading });
const viewMiles = v => 2 * v.d * TAN * area.h / H / UPM; // inverse: miles from top to bottom of the free area
const viewSqMi = v => { const m = viewMiles(v); return m * m * area.w / area.h; };
// Close-ups come down until single voters stand apart: the typical gap between voters at a county's most crowded spot
// (1 / sqrt(voters per square mile)) is drawn SEP_PX pixels wide, and each dot about a third of that gap across.
const SEP_PX = 16;
const gapMiles = c => 1 / Math.sqrt(Math.max(c.hot.voters, 1));
const closeMiles = c => Math.min(3, Math.max(0.15, area.h * gapMiles(c) / SEP_PX));
const closeView = (c, at = c) => milesView(at.hot, closeMiles(c));

// ---------- the scenes ----------
// Each scene flies `fly` seconds from where the last one ended, then holds `hold` seconds (drifting round by `drift`
// radians a second, if set). glide: fly straight, without zooming out on the way. dot: how wide a voter's dot is, in
// miles, so dots grow as the camera comes down (they're never drawn smaller than a pixel).
const ZOOM_MID = 5; // miles from top to bottom of the free area
const DOT_FAR = 0.005; // miles, for scenes without their own
const perSqMi = c => c.density >= 10 ? fmt(Math.round(c.density)) : c.density.toFixed(1);
const round2 = n => { if (n < 10) return Math.round(n); const p = 10 ** Math.max(0, Math.floor(Math.log10(n)) - 1); return Math.round(n / p) * p; };
const acresTxt = a => a >= 100 ? fmt(round2(a)) : a >= 10 ? Math.round(a) : a.toFixed(1);
const split = c => `${D.last} ${pct(c.dem, c.total)}, ${R.last} ${pct(c.rep, c.total)}`;
const tall = v => viewMiles(v) >= 1 ? `${viewMiles(v).toFixed(1)} miles` : `${fmt(round2(viewMiles(v) * 1760))} yards`;
const named = (...names) => names.map(byName).filter(Boolean);
const sumVoters = cs => cs.reduce((s, c) => s + c.total, 0);
const inView = (c, v) => round2(c.hot.voters * viewSqMi(v));
const HOUSTON = named('Harris', 'Fort Bend', 'Montgomery', 'Galveston', 'Brazoria');
const DFW = named('Dallas', 'Tarrant', 'Collin', 'Denton');
const I35 = named('Travis', 'Bexar', 'Williamson', 'Hays');
const BORDER = named('Hidalgo', 'Cameron', 'Webb');
const ELPASO = byName('El Paso');
// the close-up tour, roughly west to east so each hop is short
const TOUR = named('El Paso', 'Lubbock', 'Tarrant', 'Bexar', 'Hidalgo', 'Nueces', 'Harris').filter(c => c !== DENSE);
// a metro flight: over the group at a slight angle, then the camera slides across it
const metro = (cs, heading) => () => boxView(cs, 0.3, heading, 1.1);

const scenes = [
  { fly: 0, hold: 10, reveal: 7, view: () => stateView(), html: () => `
      <div class="kicker">Texas · U.S. Senate · Nov. 3, 2026</div>
      <h1>See every single voter</h1>
      <p><b class="hl">${fmt(TOT)}</b> Texans voted for U.S. Senate. Each of them is about to become one dot on this map.</p>` },
  { fly: 3, hold: 12, view: () => stateView(0.2), html: () => `
      <h2>One dot, one voter</h2>
      <p>The dots are voters, not residents. More than 31 million people live in Texas, but children, people who aren't citizens,
      and adults who didn't vote aren't on this map. Only the ${fmt(TOT)} who cast a ballot for U.S. Senate are.</p>
      ${PC ? `<p class="note">The 2026 results are by county; precinct results aren't out yet. So each county's voters for each
      party are placed by precinct the way that party's voters were spread in the 2024 Senate race, then on census blocks by
      how many adults live there, scattered at random around each block. Each county still adds up exactly to its 2026 result.</p>`
      : `<p class="note">The results say how many people voted in each county, not where they live. So each county's voters are
      placed where its adults live, by census block group, at random within each one. The colors are mixed across the whole
      county: a dot's color shows how its county voted, not its neighborhood.</p>`}` },
  { fly: 2.5, hold: 10, view: () => stateView(0.25, 0.1), html: () => `
      <h2>Blue, red and gray</h2>
      <p><span class="d">Blue</span>: voted for ${D.name} (D), ${fmt(D.votes)}.<br><span class="r">Red</span>: ${R.name} (R), ${fmt(R.votes)}.<br>
      <span class="o">Gray</span>: everyone else, ${fmt(OTH)}.</p>
      <p>From up here, the dots pile on top of each other: in the cities, hundreds of thousands of voters share a few pixels.
      Out west, there's mostly black.</p>` },
  { fly: 6, hold: 11, size: 4, focus: EMPTY, view: () => countyView(EMPTY, 0.15), html: () => `
      <div class="kicker">The emptiest county</div>
      <h2>${EMPTY.name} County</h2>
      <div class="big">${fmt(EMPTY.total)} voters<small>on ${fmt(Math.round(EMPTY.landSqMi))} square miles of land</small></div>
      <p>That's one voter for every ${Math.round(1 / EMPTY.density)} square miles. Each dot you can see here is one person who voted
      (drawn larger, so you can find them).</p>` },
  ...(BIGGEST === CROWDED ? [] : [{ fly: 7, hold: 9, focus: BIGGEST, view: () => countyView(BIGGEST, 0.15), html: () => `
      <div class="kicker">The most voters</div>
      <h2>${BIGGEST.name} County</h2>
      <div class="big">${fmt(BIGGEST.total)} voters<small>${pct(BIGGEST.total, TOT)} of every Senate vote in Texas</small></div>
      <p>From this high up, they blur together. The empty patches are where few people live: the Ship Channel, parks, the airports.</p>` }]),
  { fly: 5, hold: 9, focus: CROWDED, view: () => countyView(CROWDED, 0.15), html: () => `
      <div class="kicker">The most crowded county</div>
      <h2>${CROWDED.name} County</h2>
      <div class="big">${perSqMi(CROWDED)} voters per square mile<small>${fmt(CROWDED.total)} voters on ${fmt(Math.round(CROWDED.landSqMi))} square miles</small></div>
      <p>That's about ${fmt(round2(CROWDED.density / EMPTY.density))} times as crowded as ${EMPTY.name} County. Now let's go down into the most
      crowded neighborhood in the state${DENSE === CROWDED ? ', right here' : `, in ${DENSE.name} County`}, until the blur breaks apart.</p>` },
  { fly: 8, hold: 6, focus: DENSE, view: () => milesView(DENSE.hot, ZOOM_MID), html: v => `
      <h2>Closer…</h2>
      <p>This view is about ${Math.round(viewMiles(v))} miles from top to bottom, around the most crowded part of ${DENSE.name} County.</p>` },
  { fly: 7, hold: 11, focus: DENSE, dot: gapMiles(DENSE) / 3, view: () => closeView(DENSE), html: v => `
      <h2>Every single voter</h2>
      <p>Now each dot is one person: about <b class="hl">${fmt(inView(DENSE, v))}</b> voters in a patch of land ${tall(v)} tall,
      in the most crowded neighborhood in Texas (${DENSE.name} County).</p>
      <p>Across the whole county, each ${DENSE.name} County voter has about ${acresTxt(640 / DENSE.density)} of an acre to themselves.</p>` },
  { fly: 9, hold: 11, size: 4, focus: EMPTY, dot: gapMiles(DENSE) / 3, view: () => closeView(DENSE, EMPTY), html: v => {
      const n = EMPTY.density * viewSqMi(v);
      return `
      <div class="kicker">Same zoom, ${EMPTY.name} County</div>
      <h2>Nobody here</h2>
      <p>This patch of ${EMPTY.name} County is the same size as the last one, which held about ${fmt(inView(DENSE, v))} voters.
      On average, a patch this size here holds ${n < 0.1 ? 'less than a tenth' : n.toFixed(1)} of one.</p>
      <div class="vs"><div><b>${fmt(round2(DENSE.hot.voters))}</b>voters per square mile in that ${DENSE.name} County neighborhood</div>
      <div><b>1 per ${Math.round(1 / EMPTY.density)}</b>square miles in ${EMPTY.name} County</div></div>`;
    } },
  // ---- over the big metros ----
  { fly: 12, hold: 9, drift: 0.008, labels: HOUSTON, view: metro(HOUSTON, -0.15), html: () => `
      <div class="kicker">Houston</div>
      <h2>${fmt(sumVoters(HOUSTON))} voters</h2>
      <p>${HOUSTON.map(c => c.name).join(', ')}: ${pct(sumVoters(HOUSTON), TOT)} of the state's vote in five counties.
      ${PC ? 'The blue core and the redder suburbs follow how each neighborhood voted in 2024.' : ''}</p>` },
  { fly: 12, hold: 9, drift: 0.008, labels: DFW, view: metro(DFW, 0.15), html: () => `
      <div class="kicker">Dallas–Fort Worth</div>
      <h2>${fmt(sumVoters(DFW))} voters</h2>
      <p>${DFW.map(c => `${c.name}: ${short(c.total)}, ${split(c)}`).join('; ')}.</p>` },
  { fly: 12, hold: 9, drift: -0.008, labels: I35, view: metro(I35, -0.1), html: () => `
      <div class="kicker">Down I-35: Austin and San Antonio</div>
      <h2>${fmt(sumVoters(I35))} voters</h2>
      <p>${I35.map(c => `${c.name}: ${short(c.total)}, ${split(c)}`).join('; ')}.</p>` },
  { fly: 12, hold: 9, drift: 0.008, labels: BORDER, view: metro(BORDER, 0.1), html: () => `
      <div class="kicker">The border</div>
      <h2>${fmt(sumVoters(BORDER))} voters</h2>
      <p>${BORDER.map(c => `${c.name}: ${short(c.total)}, ${split(c)}`).join('; ')}. Between the cities, the map is nearly empty.</p>` },
  { fly: 14, hold: 9, drift: -0.008, labels: [ELPASO], view: metro([ELPASO], -0.1), html: () => `
      <div class="kicker">Out west</div>
      <h2>${ELPASO.name} County: ${fmt(ELPASO.total)} voters</h2>
      <p>The flight here crossed hundreds of miles of West Texas, where whole counties cast a few hundred or a few thousand votes.
      ${ELPASO.name} County voted ${split(ELPASO)}.</p>` },
  { fly: 9, hold: 6, view: () => stateView(), html: () => `
      <div class="kicker">Up close</div>
      <h2>County by county</h2>
      <p>Next, the most crowded spot in ${TOUR.length} more counties. Each time, the camera comes down until single voters stand
      apart: the more crowded the spot, the closer it gets.</p>` },
  ...TOUR.map((c, i) => ({ fly: 5.5, hold: 6, focus: c, dot: gapMiles(c) / 3, view: () => closeView(c), html: v => `
      <div class="kicker">Up close · ${i + 1} of ${TOUR.length}</div>
      <h2>${c.name} County</h2>
      <div class="big">About ${fmt(round2(c.hot.voters))} voters per square mile<small>in its most crowded half mile; this view is ${tall(v)} tall and holds about ${fmt(inView(c, v))}</small></div>
      <p>That's ${fmt(round2(c.hot.voters / c.density))} times the county's average. ${fmt(c.total)} voters in the county: ${split(c)}.</p>` })),
  { fly: 9, hold: Infinity, view: () => stateView(), html: () => `
      <h2>Same state, same election, one vote each</h2>
      <p>${EMPTY.name} County's ${fmt(EMPTY.total)} voters and ${CROWDED.name} County's ${fmt(CROWDED.total)} each cast a vote that counted the
      same. Statewide, ${D.last} won by <b class="hl">${fmt(D.votes - R.votes)}</b> votes, ${(100 * D.votes / TOT).toFixed(1)}% to ${(100 * R.votes / TOT).toFixed(1)}%.</p>
      <div class="links"><a href="#" id="again">↺ Watch again</a><a href="./?race=u-s-senate">Explore the full map →</a><a href="story.html">Fly through county by county →</a></div>` },
];
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
for (const s of scenes) { s.dot ??= DOT_FAR; if (REDUCED) s.drift = 0; }
// where a scene's camera ends up, after its drift
const endView = s => { const v = s.view(); return s.drift && isFinite(s.hold) ? { ...v, heading: v.heading + s.drift * s.hold } : v; };
// The timeline: each flight takes as long as its path needs at SPEED (a scene's `fly` is only the shortest it may take).
// Views depend on the screen's shape, so this runs once the layout is known.
let END = 0;
function timeline() {
  let acc = 0;
  scenes.forEach((s, i) => {
    s.minFly ??= s.fly;
    const S = i ? zoomPath(endView(scenes[i - 1]), s.view()).S : 0;
    s.fly = REDUCED ? Math.min(s.minFly, 0.6) : Math.max(s.minFly, S / SPEED);
    s.start = acc; acc += s.fly + (isFinite(s.hold) ? s.hold : 0);
  });
  END = scenes.at(-1).start + scenes.at(-1).fly;
}

// ---------- camera ----------
const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const smooth = t => t * t * (3 - 2 * t);
const clamp01 = x => Math.min(1, Math.max(0, x));
// Flights follow van Wijk and Nuij's smooth zoom-and-pan path ("Smooth and efficient zooming and panning", 2003): rather
// than sliding across the map up close, the camera zooms out, crosses while high, and zooms back in. The path's length S
// counts both panning (in screen widths) and zooming (in factors of e), and the flight moves along it at about SPEED a
// second, so neither the scrolling nor the zooming ever gets fast.
const RHO = 1.7;    // how much the path favors zooming out over panning (√2 is the textbook balance)
const SPEED = 0.4;  // path length a second, on average: zooming about 2x a second, or panning about a fifth of the screen
const viewW = d => 2 * d * TAN * Math.min(area.w, area.h) / H; // map units across the free area's shorter side
const viewD = w => w * H / (2 * TAN * Math.min(area.w, area.h));
function zoomPath(a, b) {
  const w0 = viewW(a.d), w1 = viewW(b.d), dx = b.x - a.x, dy = b.y - a.y, u1 = Math.hypot(dx, dy);
  if (u1 < 1e-4 * Math.min(w0, w1)) { // (nearly) straight in or out
    const S = Math.abs(Math.log(w1 / w0)) / RHO;
    return { S, dx, dy, u1, at: s => ({ u: 0, w: w0 * (w1 / w0) ** (S ? s / S : 1) }) };
  }
  const r2 = RHO * RHO, r4 = r2 * r2;
  const b0 = (w1 * w1 - w0 * w0 + r4 * u1 * u1) / (2 * w0 * r2 * u1);
  const b1 = (w1 * w1 - w0 * w0 - r4 * u1 * u1) / (2 * w1 * r2 * u1);
  const r0 = -Math.asinh(b0), r1 = -Math.asinh(b1); // ln(-b + sqrt(b² + 1)), without losing precision for large b
  return { S: (r1 - r0) / RHO, dx, dy, u1, at: s => ({
    u: w0 / r2 * (Math.cosh(r0) * Math.tanh(RHO * s + r0) - Math.sinh(r0)),
    w: w0 * Math.cosh(r0) / Math.cosh(RHO * s + r0) }) };
}
function flight(a, b, t) {
  const p = zoomPath(a, b), e = smooth(t), { u, w } = p.at(p.S * e), f = p.u1 ? u / p.u1 : 0;
  const dh = Math.atan2(Math.sin(b.heading - a.heading), Math.cos(b.heading - a.heading)); // shortest way round
  return { x: a.x + p.dx * f, y: a.y + p.dy * f, d: viewD(w), tilt: a.tilt + (b.tilt - a.tilt) * e, heading: a.heading + dh * e };
}
function setView(v) {
  const target = new THREE.Vector3(v.x, 0, -v.y);
  const s = Math.sin(v.tilt) * v.d;
  camera.position.set(target.x + s * Math.sin(v.heading), Math.cos(v.tilt) * v.d, target.z + s * Math.cos(v.heading));
  camera.near = v.d * 0.02; camera.far = v.d * 10 + 2000; camera.updateProjectionMatrix();
  camera.lookAt(target);
}
const NICE_FT = [50, 100, 200, 500, 1000, 2000], NICE_MI = [1, 2, 5, 10, 20, 50, 100, 200];
function scaleBar(v) {
  const pxPerMile = H / (2 * v.d * TAN) * UPM, max = 130;
  let label, px;
  for (const m of [...NICE_MI].reverse()) if (m * pxPerMile <= max) { label = `${m} mile${m > 1 ? 's' : ''}`; px = m * pxPerMile; break; }
  if (!label) for (const ft of [...NICE_FT].reverse()) if (ft / 5280 * pxPerMile <= max) { label = `${fmt(ft)} feet`; px = ft / 5280 * pxPerMile; break; }
  $('scalebar').querySelector('i').style.width = `${px}px`;
  $('scalebar').querySelector('span').textContent = label;
  $('scalebar').style.opacity = v.tilt < 0.35 ? 1 : 0; // only meaningful looking (nearly) straight down
}

// ---------- county labels (metro scenes), on the ground at each county's center ----------
const labelsEl = $('labels'), labelEls = new Map(), lv = new THREE.Vector3();
function labelFor(c) {
  if (!labelEls.has(c)) {
    const el = document.createElement('div'); el.className = 'label';
    el.innerHTML = `${c.name}<small>${short(c.total)} voters</small>`;
    labelsEl.appendChild(el); labelEls.set(c, el);
  }
  return labelEls.get(c);
}
function placeLabels(s, local) {
  const show = new Set(s.labels || []);
  for (const [c, el] of labelEls) if (!show.has(c)) el.style.opacity = 0;
  const placed = [];
  for (const c of [...show].sort((a, b) => b.total - a.total)) { // largest first; skip a label that would overlap one shown
    const el = labelFor(c);
    lv.set(c.cx, c.cy, 0).applyMatrix4(mapGroup.matrixWorld).project(camera);
    const x = (lv.x + 1) / 2 * W, y = (1 - lv.y) / 2 * H, bw = el.offsetWidth, bh = el.offsetHeight;
    const box = [x - bw / 2, y - bh * 1.2, x + bw / 2, y - bh * 0.2];
    const ok = lv.z < 1 && x > 0 && x < W && y > 0 && y < H && !placed.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
    if (ok) placed.push(box);
    el.style.left = x + 'px'; el.style.top = y + 'px';
    el.style.opacity = ok ? clamp01((local - s.fly + 1) / 1) : 0;
  }
}

// ---------- the clock ----------
let t = 0, playing = true, cur = -1, last = performance.now();
const sceneAt = time => { let i = 0; while (i + 1 < scenes.length && scenes[i + 1].start <= time) i++; return i; };
function showCaption(i) {
  const s = scenes[i], cap = $('caption');
  cap.classList.add('fade');
  setTimeout(() => {
    cap.innerHTML = s.html(s.view());
    cap.classList.remove('fade');
    $('again')?.addEventListener('click', e => { e.preventDefault(); jump(0); });
  }, cur === -1 ? 0 : 350);
  focusLine.geometry.dispose();
  // the scene's county, or the counties it names
  const outlined = s.focus ? [s.focus] : s.labels || [];
  focusLine.geometry = outlined.length ? lineGeo(outlined.flatMap(c => c.edges)) : new THREE.BufferGeometry();
}
function jump(time) { t = Math.max(0, Math.min(time, END)); playing = true; updateButton(); }
function updateButton() { $('pause').textContent = t >= END ? 'Watch again' : playing ? 'Pause' : 'Play'; }
$('pause').onclick = () => { if (t >= END) jump(0); else { playing = !playing; updateButton(); } };
$('prev').onclick = () => { const i = sceneAt(t); jump(scenes[t - scenes[i].start < 1.5 && i > 0 ? i - 1 : i].start); };
$('next').onclick = () => { const i = sceneAt(t); if (i + 1 < scenes.length) jump(scenes[i + 1].start); };
addEventListener('keydown', e => {
  if (e.key === ' ' && e.target === document.body) { e.preventDefault(); $('pause').click(); }
  if (e.key === 'ArrowRight') $('next').click();
  if (e.key === 'ArrowLeft') $('prev').click();
});

function frame(now) {
  const dt = Math.min(0.25, (now - last) / 1000); last = now;
  if (playing && t < END) { t = Math.min(END, t + dt); if (t >= END) updateButton(); }
  const i = sceneAt(t), s = scenes[i], local = t - s.start;
  if (i !== cur) { showCaption(i); cur = i; }
  const prev = scenes[Math.max(0, i - 1)];
  const k = s.fly ? clamp01(local / s.fly) : 1;
  let v = k < 1 ? flight(endView(prev), s.view(), k) : s.view();
  if (k >= 1 && s.drift) v = { ...v, heading: v.heading + s.drift * Math.min(local - s.fly, isFinite(s.hold) ? s.hold : 0) };
  setView(v); scaleBar(v);
  // dot size in map units, changing smoothly (on a log scale) from the last scene's to this one's
  const e = ease(k), dot = Math.exp(Math.log(prev.dot) + (Math.log(s.dot) - Math.log(prev.dot)) * e);
  dots.uniforms.uWorld.value = dot * UPM;
  // a scene's `size` enlarges the dots of its county only, so a few voters can be found without slowing the whole map
  const dpr = renderer.getPixelRatio();
  dots.uniforms.uMinSize.value = dpr;
  dots.uniforms.uFocus.value = s.size && s.focus ? ordered.indexOf(s.focus) : -1;
  dots.uniforms.uFocusSize.value = dpr * (1 + ((s.size || 1) - 1) * e);
  dots.uniforms.uReveal.value = i === 0 ? clamp01(local / s.reveal) ** 1.6 : 1;
  focusMat.opacity = clamp01(local / 0.4); // fades in over the first moment of the scene
  $('fill').style.width = `${100 * t / END}%`;
  renderer.render(scene, camera);
  placeLabels(s, local);
  requestAnimationFrame(frame);
}

new ResizeObserver(resize).observe($('stage'));
resize();
timeline();
$('loading').textContent = `Placing ${fmt(TOT)} voters…`;
await dots.place(ordered, { per: 1, seed: 2026 });
$('loading').remove();
// ?scene=N (1-based) starts at that scene, already arrived
const startAt = +new URLSearchParams(location.search).get('scene');
if (startAt > 1 && startAt <= scenes.length) { t = scenes[startAt - 1].start + scenes[startAt - 1].fly; updateButton(); }
last = performance.now();
requestAnimationFrame(frame);
