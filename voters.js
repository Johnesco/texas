// "See every single voter": an animated flight over Texas with one dot for each person who voted in the 2026 U.S. Senate
// race. It plays on its own, scene by scene: the whole state, what a dot means, the emptiest county, the county with the
// most voters, then down into the most crowded county until single voters show, and the same zoom over the emptiest one.
import * as THREE from 'three';
import { geoConicEqualArea, geoCentroid } from 'd3-geo';
import { feature } from 'topojson-client';
import { createDots, countyTris, DOT_C } from './dots.js';

const GEO_URL = 'https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/counties-10m.json';
const $ = id => document.getElementById(id);
const fmt = n => n.toLocaleString('en-US');
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
  c.tris = countyTris(shapes);
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
  ordered.push(c);
}
const lineGeo = pts => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)); return g; };
// faint county lines over the dots, and a brighter outline for the county a scene is about
const borders = new THREE.LineSegments(lineGeo(allEdges),
  new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.13, depthTest: false }));
borders.renderOrder = 1; mapGroup.add(borders);
const focusMat = new THREE.LineBasicMaterial({ color: 0xf2c14e, transparent: true, opacity: 0, depthTest: false });
const focusLine = new THREE.LineSegments(new THREE.BufferGeometry(), focusMat);
focusLine.renderOrder = 2; mapGroup.add(focusLine);

const dots = createDots({ depthTest: false });
dots.uniforms.uP.value = 0; dots.uniforms.uReveal.value = 0;
mapGroup.add(dots.points);

$('legend').innerHTML = [[DOT_C.dem, `${D.last} (D)`], [DOT_C.rep, `${R.last} (R)`], [DOT_C.other, 'Other']]
  .map(([c, t]) => `<span><i style="background:${c}"></i>${t}</span>`).join('');

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
// camera distance that shows halfW x halfH map units (looking straight down) inside the free area
const fitDist = (halfW, halfH) => Math.max(halfW * H / (TAN * area.w), halfH * H / (TAN * area.h));
const stateView = (tilt = 0.0001, heading = 0) => ({ x: 0, y: 0, d: fitDist(520, 520), tilt, heading });
const countyView = (c, tilt = 0.0001, heading = 0, pad = 1.3) =>
  ({ x: (c.box.x0 + c.box.x1) / 2, y: (c.box.y0 + c.box.y1) / 2, d: fitDist(pad * (c.box.x1 - c.box.x0) / 2, pad * (c.box.y1 - c.box.y0) / 2), tilt, heading });
// a view of `miles` (top to bottom of the free area) around a point
const milesView = (x, y, miles, tilt = 0.0001) => ({ x, y, d: (miles * UPM / 2) * H / (TAN * area.h), tilt, heading: 0 });
const viewMiles = v => 2 * v.d * TAN * area.h / H / UPM; // inverse: miles from top to bottom of the free area
const viewSqMi = v => { const m = viewMiles(v); return m * m * area.w / area.h; };

// ---------- the scenes ----------
const ZOOM_NEAR = 0.6, ZOOM_MID = 5; // miles from top to bottom of the free area, for the close-ups
const perSqMi = c => c.density >= 10 ? fmt(Math.round(c.density)) : c.density.toFixed(1);
const spot = c => ({ x: c.cx, y: c.cy });
const crowdRatio = CROWDED.density / EMPTY.density;
const round2 = n => { const p = 10 ** Math.max(0, Math.floor(Math.log10(n)) - 1); return Math.round(n / p) * p; };
const acres = c => 640 / c.density;
const acresTxt = a => a >= 100 ? fmt(round2(a)) : a >= 10 ? Math.round(a) : a.toFixed(1);

const scenes = [
  { fly: 0, hold: 10, reveal: 7, view: () => stateView(), html: () => `
      <div class="kicker">Texas · U.S. Senate · Nov. 3, 2026</div>
      <h1>See every single voter</h1>
      <p><b class="hl">${fmt(TOT)}</b> Texans voted for U.S. Senate. Each of them is about to become one dot on this map.</p>` },
  { fly: 3, hold: 11, view: () => stateView(0.35), html: () => `
      <h2>One dot, one voter</h2>
      <p>The dots are voters, not residents. More than 31 million people live in Texas, but children, people who aren't citizens,
      and adults who didn't vote aren't on this map. Only the ${fmt(TOT)} who cast a ballot for U.S. Senate are.</p>
      <p class="note">The results tell us how many people voted in each county, not where they live, so each county's voters
      are scattered at random within its borders.</p>` },
  { fly: 2.5, hold: 10, view: () => stateView(0.42, 0.12), html: () => `
      <h2>Blue, red and gray</h2>
      <p><span class="d">Blue</span>: voted for ${D.name} (D), ${fmt(D.votes)}.<br><span class="r">Red</span>: ${R.name} (R), ${fmt(R.votes)}.<br>
      <span class="o">Gray</span>: everyone else, ${fmt(OTH)}.</p>
      <p>From up here, the dots pile on top of each other: in the cities, hundreds of thousands of voters share a few pixels.
      Out west, there's mostly black.</p>` },
  { fly: 6, hold: 11, size: 4, focus: EMPTY, view: () => countyView(EMPTY, 0.2), html: () => `
      <div class="kicker">The emptiest county</div>
      <h2>${EMPTY.name} County</h2>
      <div class="big">${fmt(EMPTY.total)} voters<small>on ${fmt(Math.round(EMPTY.landSqMi))} square miles of land</small></div>
      <p>That's one voter for every ${Math.round(1 / EMPTY.density)} square miles. Each dot you can see here is one person who voted
      (drawn larger, so you can find them).</p>` },
  ...(BIGGEST === CROWDED ? [] : [{ fly: 7, hold: 9, focus: BIGGEST, view: () => countyView(BIGGEST, 0.3), html: () => `
      <div class="kicker">The most voters</div>
      <h2>${BIGGEST.name} County</h2>
      <div class="big">${fmt(BIGGEST.total)} voters<small>${(100 * BIGGEST.total / TOT).toFixed(0)}% of every Senate vote in Texas</small></div>
      <p>From this high up, they blur into solid color.</p>` }]),
  { fly: 5, hold: 9, focus: CROWDED, view: () => countyView(CROWDED, 0.22), html: () => `
      <div class="kicker">The most crowded county</div>
      <h2>${CROWDED.name} County</h2>
      <div class="big">${perSqMi(CROWDED)} voters per square mile<small>${fmt(CROWDED.total)} voters on ${fmt(Math.round(CROWDED.landSqMi))} square miles</small></div>
      <p>That's about ${fmt(round2(crowdRatio))} times as crowded as ${EMPTY.name} County. Let's go down until the blur breaks apart.</p>` },
  { fly: 8, hold: 6, focus: CROWDED, view: () => milesView(spot(CROWDED).x, spot(CROWDED).y, ZOOM_MID), html: v => `
      <h2>Closer…</h2>
      <p>This view is about ${Math.round(viewMiles(v))} miles from top to bottom. It holds roughly
      <b class="hl">${fmt(round2(CROWDED.density * viewSqMi(v)))}</b> ${CROWDED.name} County voters.</p>` },
  { fly: 7, hold: 11, focus: CROWDED, view: () => milesView(spot(CROWDED).x, spot(CROWDED).y, ZOOM_NEAR), html: v => `
      <h2>Every single voter</h2>
      <p>Now each dot is one person: about <b class="hl">${fmt(round2(CROWDED.density * viewSqMi(v)))}</b> voters in a patch of land
      ${viewMiles(v) >= 1 ? `${viewMiles(v).toFixed(1)} miles` : `${fmt(round2(viewMiles(v) * 1760))} yards`} tall.</p>
      <p>On average, each ${CROWDED.name} County voter has about ${acresTxt(acres(CROWDED))} of an acre to themselves.</p>` },
  { fly: 9, hold: 11, size: 4, focus: EMPTY, view: () => milesView(spot(EMPTY).x, spot(EMPTY).y, ZOOM_NEAR), html: v => {
      const n = EMPTY.density * viewSqMi(v);
      return `
      <div class="kicker">Same zoom, ${EMPTY.name} County</div>
      <h2>Nobody here</h2>
      <p>This patch of ${EMPTY.name} County is the same size as the last one. That one held about
      ${fmt(round2(CROWDED.density * viewSqMi(v)))} voters; on average, a patch this size here holds ${n < 0.1 ? 'less than a tenth' : n.toFixed(1)} of one.</p>
      <div class="vs"><div><b>${perSqMi(CROWDED)}</b>voters per square mile in ${CROWDED.name} County</div>
      <div><b>1 per ${Math.round(1 / EMPTY.density)}</b>square miles in ${EMPTY.name} County</div></div>`;
    } },
  { fly: 8, hold: Infinity, view: () => stateView(0.0001), html: () => `
      <h2>Same state, same election, one vote each</h2>
      <p>${EMPTY.name} County's ${fmt(EMPTY.total)} voters and ${CROWDED.name} County's ${fmt(CROWDED.total)} each cast a vote that counted the
      same. Statewide, ${D.last} won by <b class="hl">${fmt(D.votes - R.votes)}</b> votes, ${(100 * D.votes / TOT).toFixed(1)}% to ${(100 * R.votes / TOT).toFixed(1)}%.</p>
      <div class="links"><a href="#" id="again">↺ Watch again</a><a href="./?race=u-s-senate">Explore the full map →</a><a href="story.html">Fly through county by county →</a></div>` },
];
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
if (REDUCED) for (const s of scenes) s.fly = Math.min(s.fly, 0.6);
let acc = 0;
for (const s of scenes) { s.start = acc; acc += s.fly + (isFinite(s.hold) ? s.hold : 0); }
const END = scenes.at(-1).start + scenes.at(-1).fly;

// ---------- camera ----------
const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const clamp01 = x => Math.min(1, Math.max(0, x));
function flight(a, b, t) {
  const e = ease(t);
  // zoom out on the way when the two ends are far apart, so the trip stays readable
  const travel = Math.hypot(b.x - a.x, b.y - a.y);
  const lo = Math.log(a.d), hi = Math.log(b.d);
  const peak = Math.log(Math.max(a.d, b.d, fitDist(travel * 0.7, travel * 0.7)));
  const bump = Math.max(0, peak - Math.max(lo, hi)) * Math.sin(Math.PI * t);
  // move across faster while zoomed out: the position follows the zoom-out
  const pe = bump > 0 ? ease(clamp01((t - 0.15) / 0.7)) : e;
  return { x: a.x + (b.x - a.x) * pe, y: a.y + (b.y - a.y) * pe, d: Math.exp(lo + (hi - lo) * e + bump),
    tilt: a.tilt + (b.tilt - a.tilt) * e, heading: a.heading + (b.heading - a.heading) * e };
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
  $('scalebar').style.opacity = v.tilt < 0.3 ? 1 : 0; // only meaningful looking (nearly) straight down
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
  focusLine.geometry = s.focus ? lineGeo(s.focus.edges) : new THREE.BufferGeometry();
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
  const v = k < 1 ? flight(prev.view(), s.view(), k) : s.view();
  setView(v); scaleBar(v);
  // a scene's `size` enlarges the dots of its county only, so a few voters can be found without slowing the whole map
  const dpr = renderer.getPixelRatio();
  dots.uniforms.uMinSize.value = dpr;
  dots.uniforms.uFocus.value = s.size && s.focus ? ordered.indexOf(s.focus) : -1;
  dots.uniforms.uFocusSize.value = dpr * (1 + ((s.size || 1) - 1) * ease(k));
  dots.uniforms.uReveal.value = i === 0 ? clamp01(local / s.reveal) ** 1.6 : 1;
  focusMat.opacity = s.focus ? 0.9 * clamp01((local - s.fly + 0.5) / 1) : 0;
  $('fill').style.width = `${100 * t / END}%`;
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

new ResizeObserver(resize).observe($('stage'));
resize();
$('loading').textContent = `Placing ${fmt(TOT)} voters…`;
await dots.place(ordered, { per: 1, seed: 2026 });
$('loading').remove();
// ?scene=N (1-based) starts at that scene, already arrived
const startAt = +new URLSearchParams(location.search).get('scene');
if (startAt > 1 && startAt <= scenes.length) { t = scenes[startAt - 1].start + scenes[startAt - 1].fly; updateButton(); }
last = performance.now();
requestAnimationFrame(frame);
