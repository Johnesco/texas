// Flythrough of the 2026 U.S. Senate race: as the reader scrolls through the story cards, the camera flies between
// groups of counties, the columns rise and fall, and the colors switch between "who won" and "how far it moved".
// Every number in the cards is computed here from the data files; only the choice of which counties to visit is written by hand.
import * as THREE from 'three';
import { GEO_URL, buildMap, layout, H_FLAT, REP_C, DEM_C, LOSER_C, OTHER_C, winnerColor } from './map3d.js';

const $ = id => document.getElementById(id);
const getJSON = url => fetch(url).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
let res, us, hist;
try {
  [res, us, hist] = await Promise.all([getJSON('data/results-2026.json'), getJSON(GEO_URL), getJSON('data/results-history.json')]);
} catch (e) {
  $('loading').textContent = 'Could not load the map data. Please reload the page.';
  throw e;
}

// ---------- data ----------
const RACE = res.races.find(r => r.id === 'u-s-senate');
const BEFORE = hist.races.find(r => r.id === '2024-president'); // same county order as results-2026.json
const D = RACE.candidates.find(c => c.party === 'DEM'), R = RACE.candidates.find(c => c.party === 'REP');
const counties = res.counties.map((c, i) => {
  const [dem, rep, other, total] = RACE.counties[i], [d0, r0, , t0] = BEFORE.counties[i];
  const m = 100 * (dem - rep) / total, m0 = 100 * (d0 - r0) / t0; // margin, + = Democratic
  return { ...c, dem, rep, other, total, m, m0, shift: m - m0, total0: t0 };
});
const byName = new Map(counties.map(c => [c.name, c]));
const pick = names => names.map(n => byName.get(n)).filter(Boolean);

const fmt = n => n.toLocaleString('en-US');
const pct = (a, b, d = 0) => (100 * a / b).toFixed(d) + '%';
const short = n => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'K' : fmt(n);
const mg = (m, d = 0) => (m >= 0 ? 'D+' : 'R+') + Math.abs(m).toFixed(d);
const list = a => a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a.at(-1);

const land = counties.reduce((s, c) => s + c.landSqMi, 0);
const S = { dem: 0, rep: 0, tot: 0, cntR: 0, landR: 0, tot0: 0, d0: 0, r0: 0 };
for (const c of counties) {
  S.dem += c.dem; S.rep += c.rep; S.tot += c.total; S.tot0 += c.total0;
  if (c.rep >= c.dem) { S.cntR++; S.landR += c.landSqMi; }
}
for (const [d0, r0] of BEFORE.counties) { S.d0 += d0; S.r0 += r0; }
const desc = [...counties].sort((a, b) => b.total - a.total), asc = [...desc].reverse();
const big = desc[0];
let nSmall = 0, accSmall = 0, landSmall = 0;
while (accSmall + asc[nSmall].total < big.total) { accSmall += asc[nSmall].total; landSmall += asc[nSmall].landSqMi; nSmall++; }
const smallest = asc.slice(0, nSmall);
const reddest = [...counties].sort((a, b) => a.m - b.m).slice(0, 5);
const big5 = desc.slice(0, 5), big5v = big5.reduce((s, c) => s + c.total, 0);
const big5R = big5.reduce((s, c) => s + c.rep, 0);
let nR = 0; // how many of Paxton's lowest-vote counties it takes to match his votes in the big five
for (let s = 0, byRep = [...counties].sort((a, b) => a.rep - b.rep); nR < byRep.length && s + byRep[nR].rep <= big5R; nR++) s += byRep[nR].rep;
const flipped = counties.filter(c => c.m > 0 && c.m0 < 0);
const DFW = pick(['Tarrant', 'Collin', 'Denton', 'Kaufman', 'Rockwall', 'Ellis', 'Johnson', 'Parker']).filter(c => flipped.includes(c));
const VALLEY = pick(['Hidalgo', 'Cameron', 'Starr', 'Webb', 'Zapata', 'Willacy', 'Maverick']).filter(c => flipped.includes(c));
const byShift = [...counties].sort((a, b) => b.shift - a.shift);
const movedD = counties.filter(c => c.shift > 0).length;
const medianShift = byShift[Math.floor(byShift.length / 2)].shift;
const flipVotes = flipped.reduce((s, c) => s + c.total, 0);

// Down the ballot: the Texas House and the U.S. House, every district added up by county (same county order).
function chamber(id) {
  const r = res.races.find(x => x.id === id), p = hist.races.find(x => x.id === `2024-${id}`);
  const before = new Map(p.districts.map(d => [d.district, d.candidates[0].party]));
  const dist = r.districts.map(d => {
    const [a, b] = d.candidates;
    return { ...d, w: a, m: b ? 100 * (a.votes - b.votes) / d.total : 100, before: before.get(d.district) };
  });
  const row = ([dem, rep, other, total]) => ({ dem, rep, other, total });
  const sum = k => r.counties.reduce((s, x) => s + x[k], 0);
  return { r, label: r.label, rows: r.counties.map(row), rows0: p.counties.map(row), dist, n: dist.length,
    dem: sum(0), rep: sum(1), tot: sum(3), seatD: r.seats.DEM || 0, seatR: r.seats.REP || 0, seatD0: p.seats.DEM || 0,
    gainD: dist.filter(d => d.before === 'REP' && d.w.party === 'DEM'), gainR: dist.filter(d => d.before === 'DEM' && d.w.party === 'REP') };
}
const TXH = chamber('texas-house'), USH = chamber('u-s-house');
counties.forEach((c, i) => c.i = i);
// counties whose Texas House vote (all districts added up) went from a Republican lead in 2024 to a Democratic one
const txhFlipped = counties.filter(c => { const a = TXH.rows0[c.i], b = TXH.rows[c.i]; return a.rep > a.dem && b.dem > b.rep; })
  .sort((a, b) => TXH.rows[b.i].total - TXH.rows[a.i].total);
const txhClose = TXH.gainD.filter(d => d.m < 2);
// ticket-splitting: counties the Senate Democrat won where Republicans got more U.S. House votes, and the reverse
const splitR = counties.filter(c => c.dem > c.rep && USH.rows[c.i].rep > USH.rows[c.i].dem);
const splitD = counties.filter(c => c.rep > c.dem && USH.rows[c.i].dem > USH.rows[c.i].rep);
const cm = (row, d = 0) => mg(100 * (row.dem - row.rep) / row.total, d);
// a strip of seats: Democratic holds, Democratic gains, Republican gains, Republican holds
const seatStrip = ch => {
  const cell = (cls, k) => `<i class="${cls}"></i>`.repeat(k);
  return `<div class="seats" role="img" aria-label="${ch.seatD} Democratic and ${ch.seatR} Republican seats">` +
    cell('d', ch.seatD - ch.gainD.length) + cell('d f', ch.gainD.length) + cell('r f', ch.gainR.length) + cell('r', ch.seatR - ch.gainR.length) +
    `</div><div class="seats-key"><span><i class="d"></i>${ch.seatD} D</span><span><i class="r"></i>${ch.seatR} R</span><span><i class="d f"></i>changed party since 2024</span></div>`;
};
const distList = ds => list(ds.map(d => `District ${d.district} (${d.w.name}, by ${d.m.toFixed(1)} points)`));

// Colors: winner's share in 10-point bands (map3d.js, as on the main map); shift toward a party in 10-point bands.
const SHIFT_BINS = [0, 10, 20, 30, 40, 50];
const SHIFT_D = ['#3d3a52', '#4f4a8a', '#5f59c0', '#7b7bf0', '#a9a6ff', '#e0ddff'];
const SHIFT_R = '#b84a4a';
const shiftColor = c => c.shift < 0 ? SHIFT_R : SHIFT_D[Math.max(0, SHIFT_BINS.findLastIndex(b => c.shift >= b))];

// ---------- the story ----------
// view: 'state' (whole map) or a list of counties to frame. raise: 0 flat → 1 columns. phi: tilt (0 = straight down).
// theta: compass angle of the camera. hi: counties lit up (null = all). label: text under the county name.
const vs = c => `${short(c.total)} votes`;
const STEPS = [
  { view: 'state', raise: 0, phi: 0.0001, theta: 0, color: 'winner', hi: null, labels: [], card: () => `
    <div class="kicker">Nov. 3, 2026 · U.S. Senate</div>
    <h2>A red map</h2>
    <p>${R.name} carried <b class="hl">${S.cntR} of ${counties.length}</b> counties, which cover <b class="hl">${pct(S.landR, land)}</b> of Texas's land.</p>
    <p>${D.name} won the state anyway, <b class="hl">${pct(S.dem, S.tot, 1)} to ${pct(S.rep, S.tot, 1)}</b>. This is how.</p>` },
  { view: reddest, raise: 0, phi: 0.75, theta: -0.35, zoom: 1.3, color: 'winner', hi: reddest, labels: reddest, label: c => `${mg(c.m)} · ${fmt(c.total)} votes`, card: () => `
    <div class="kicker">The Panhandle and West Texas</div>
    <h2>Deep red, and nearly empty</h2>
    <p>${R.last}'s five best counties were ${list(reddest.map(c => c.name))}. He won them by up to ${Math.abs(reddest[0].m).toFixed(0)} points.</p>
    <div class="big">${fmt(reddest.reduce((s, c) => s + c.total, 0))}<small>votes cast in those five counties together, ${pct(reddest.reduce((s, c) => s + c.total, 0), S.tot, 2)} of the state</small></div>
    <p>On a flat map each of them gets as much color as a county of a million voters. The smallest of all, ${asc[0].name} County, cast ${fmt(asc[0].total)} votes.</p>` },
  { view: 'state', raise: 1, phi: 0.98, theta: -0.22, zoom: 1.08, color: 'winner', hi: [big, ...smallest], labels: [big], label: vs, card: () => `
    <div class="kicker">Raise the counties</div>
    <h2>Now give each county its votes</h2>
    <p>Each column's height is the number of votes cast there. The lit-up counties are ${big.name} and the <b class="hl">${nSmall} counties</b> that cast the fewest votes.</p>
    <div class="stat-row"><div class="stat"><b>${fmt(big.total)}</b><span>votes in ${big.name} County</span></div>
      <div class="stat"><b>${fmt(accSmall)}</b><span>votes in the ${nSmall} smallest, together</span></div></div>
    <p>Those ${nSmall} counties cover ${pct(landSmall, land)} of Texas's land.</p>
    <p>Each column is also split by how its county voted: the runner-up's votes at the bottom, third-party and write-in votes in gray, and the winner's votes on top.</p>` },
  { view: big5, raise: 1, phi: 1.0, theta: 0.45, zoom: 1.15, color: 'winner', hi: big5, labels: big5, label: c => `${vs(c)} · ${mg(c.m)}`, card: () => `
    <div class="kicker">The Texas Triangle</div>
    <h2>Five counties, ${pct(big5v, S.tot)} of the vote</h2>
    <p>${list(big5.map(c => c.name))} cast <b class="hl">${fmt(big5v)}</b> votes between them. ${D.last} carried all five${big5.every(c => c.m > 0) ? '' : ' but one'}.</p>
    <p>Together they gave him a lead of <b class="hl">${fmt(big5.reduce((s, c) => s + c.dem - c.rep, 0))}</b> votes; his statewide lead was ${fmt(S.dem - S.rep)}.</p>
    <p>They aren't one-party places. The red at the base of each column is ${R.last}'s share: <b class="hl">${fmt(big5R)}</b> votes in these five,
      ${pct(big5R, S.rep)} of all his votes in Texas, more than he got in the ${nR} counties where he got the fewest votes, combined.</p>` },
  { view: DFW, raise: 1, phi: 0.92, theta: -0.6, zoom: 1.25, color: 'winner', hi: DFW, labels: DFW, label: c => `${mg(c.m0)} → ${mg(c.m)}`, card: () => `
    <div class="kicker">Dallas–Fort Worth</div>
    <h2>The suburbs flipped</h2>
    <p>In 2024, Donald Trump carried these ${DFW.length} counties for President. Two years later ${D.last} carried them for the Senate.</p>
    <ul class="flips">${DFW.map(c => `<li><span>${c.name}</span><span class="r">${mg(c.m0, 1)}</span><span class="ar">→</span><span class="d">${mg(c.m, 1)}</span></li>`).join('')}</ul>
    <p>The red part of each column shows how close they still are: ${R.last} got between ${Math.min(...DFW.map(c => 100 * c.rep / c.total)).toFixed(0)}% and ${Math.max(...DFW.map(c => 100 * c.rep / c.total)).toFixed(0)}% of the vote in them.</p>
    <p class="note">2024 President vs. 2026 U.S. Senate, margin as a share of all votes cast. Different races, same voters.</p>` },
  { view: VALLEY, raise: 1, phi: 0.85, theta: 0.5, zoom: 1.2, color: 'winner', hi: VALLEY, labels: VALLEY, label: c => `${mg(c.m0)} → ${mg(c.m)}`, card: () => {
    const top = [...VALLEY].sort((a, b) => b.shift - a.shift)[0];
    return `
    <div class="kicker">The Rio Grande Valley and the border</div>
    <h2>The biggest swings in the state</h2>
    <p>These ${VALLEY.length} border counties all voted for Trump in 2024 and for ${D.last} in 2026.</p>
    <div class="big">${top.shift.toFixed(0)} points<small>the swing toward the Democrat in ${top.name} County, from ${mg(top.m0, 1)} to ${mg(top.m, 1)}</small></div>
    <ul class="flips">${VALLEY.map(c => `<li><span>${c.name}</span><span class="r">${mg(c.m0, 1)}</span><span class="ar">→</span><span class="d">${mg(c.m, 1)}</span></li>`).join('')}</ul>`; } },
  { view: 'state', raise: 0, phi: 0.0001, theta: 0, color: 'shift', hi: null, labels: [byShift[0], byShift.at(-1)], label: c => `${c.shift >= 0 ? '+' : ''}${c.shift.toFixed(0)} pts toward D`, card: () => `
    <div class="kicker">Every county moved</div>
    <h2>${movedD === counties.length ? `All ${counties.length} counties` : `${movedD} of ${counties.length} counties`} shifted toward the Democrat</h2>
    <p>Here each county is colored by how far its margin moved from the 2024 presidential race to the 2026 Senate race. The median county moved <b class="hl">${medianShift.toFixed(0)} points</b>.</p>
    <p>The biggest move was in ${byShift[0].name} County (${byShift[0].shift.toFixed(0)} points). The smallest was in ${byShift.at(-1).name} County (${byShift.at(-1).shift.toFixed(0)}), which ${R.last} still won ${mg(byShift.at(-1).m)}.</p>
    <p>${flipped.length} counties flipped from Trump to ${D.last}. They cast ${pct(flipVotes, S.tot)} of the state's votes.</p>` },
  { view: 'state', raise: 0, phi: 0.45, theta: 0.15, color: TXH, hi: txhFlipped, labels: txhFlipped.slice(0, 6), label: c => `House vote ${cm(TXH.rows0[c.i])} → ${cm(TXH.rows[c.i])}`, card: () => `
    <div class="kicker">Down the ballot · Texas House</div>
    <h2>Democrats took the Texas House</h2>
    <p>Democrats won <b class="hl">${TXH.seatD} of ${TXH.n}</b> seats, up from ${TXH.seatD0} in 2024. They gained ${TXH.gainD.length} districts${TXH.gainR.length ? ` and lost ${TXH.gainR.length}` : ' and lost none'},
      and won ${pct(TXH.dem, TXH.tot, 1)} of the Texas House vote.</p>
    ${seatStrip(TXH)}
    <div class="big">${txhClose.length} of ${TXH.gainD.length}<small>Democratic gains were won by less than 2 points</small></div>
    <p>Here each county is colored by which party got more Texas House votes there, every district added up. The ${txhFlipped.length} lit-up counties
      went from a Republican lead in 2024 to a Democratic one.</p>
    <p class="note">Republicans had held the Texas House since the 2002 election. Seats and votes: Texas Secretary of State, 2026 election-night returns and 2024 final results.</p>` },
  { view: 'state', raise: 0, phi: 0.45, theta: -0.15, color: USH, hi: splitR, labels: splitR, label: c => `Senate ${mg(c.m)} · House ${cm(USH.rows[c.i])}`, card: () => `
    <div class="kicker">Down the ballot · U.S. House</div>
    <h2>More votes, fewer seats</h2>
    <p>Democrats won <b class="hl">${pct(USH.dem, USH.tot, 1)}</b> of the U.S. House vote in Texas, but <b class="hl">${USH.seatD} of the ${USH.n}</b> seats (${pct(USH.seatD, USH.n)}).</p>
    ${seatStrip(USH)}
    <p>They gained ${distList(USH.gainD)}${USH.gainR.length ? `, and lost ${distList(USH.gainR)}` : ''}.</p>
    <p>That gap doesn't come from empty land: districts have equal populations. It comes from where the district lines fall.</p>
    <p>Few voters split their tickets. ${D.last} won only ${splitR.length} counties where Republicans got more U.S. House votes (${list(splitR.map(c => c.name))}, lit up),
      and ${splitD.length ? `${splitD.length} went the other way` : 'none went the other way'}.</p>` },
  { view: 'state', raise: 1, phi: 1.0, theta: 0.6, zoom: 1.1, spin: true, color: 'winner', hi: null, labels: desc.slice(0, 6), label: vs, card: () => `
    <div class="kicker">The whole picture</div>
    <h2>Most of the map, fewer of the votes</h2>
    <p>${R.last} won ${S.cntR} counties and ${pct(S.landR, land)} of the land. ${D.last} won where people vote, and the state by <b class="hl">${fmt(S.dem - S.rep)}</b> votes.</p>
    <div class="links">
      <a class="cta" href="./?race=u-s-senate"><b>Explore the map yourself →</b><span>All 18 statewide races, every county, hover for details</span></a>
      <a class="cta" href="history.html"><b>How we got there →</b><span>Every major statewide race since 2008</span></a>
    </div>
    <p class="note">Sources: Texas Secretary of State, election-night returns as of ${res.meta.resultsUpdated} (unofficial until the canvass) and 2024 final county results;
      U.S. Census Bureau land area and county boundaries. Column height is proportional to votes cast in the Senate race; each column is split by candidate.</p>` },
];

// cards
const stepsEl = $('steps');
STEPS.forEach((s, i) => {
  const sec = document.createElement('section');
  sec.className = 'step'; sec.dataset.i = i;
  sec.innerHTML = `<div class="card">${s.card()}</div>`;
  stepsEl.appendChild(sec);
});
const stepEls = [...stepsEl.querySelectorAll('section.step')];
$('dots').innerHTML = STEPS.map((s, i) => `<button type="button" data-i="${i}" aria-label="Step ${i + 1}"></button>`).join('');
$('dots').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const el = stepEls[+b.dataset.i], y = el.getBoundingClientRect().top + scrollY + el.offsetHeight / 2 - innerHeight * trigger();
  scrollTo({ top: y, behavior: 'smooth' });
});

// ---------- scene ----------
const stage = $('stage');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
stage.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const BG = new THREE.Color('#0e1116');
scene.background = BG;
const camera = new THREE.PerspectiveCamera(30, 1, 5, 20000);
scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(-600, 900, 700); scene.add(sun);

// Columns are stacked by vote (map3d.js): runner-up at the bottom, third-party and write-ins in gray, winner on top.
const { mapGroup, pickables } = buildMap(scene, us, counties, { maxTotal: big.total, edgeOpacity: 0.45 });
for (const c of counties) Object.assign(c, { color: new THREE.Color(winnerColor(c)), lit: 1,
  lowerColor: new THREE.Color(c.dem > c.rep ? LOSER_C.rep : LOSER_C.dem), middleColor: new THREE.Color(OTHER_C) });
// rise order: small counties first, so the cities rise last
[...counties].sort((a, b) => a.total - b.total).forEach((c, i, a) => c.delay = 0.3 * i / a.length);
$('loading').remove();

// ---------- camera poses ----------
const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const clamp01 = x => Math.min(1, Math.max(0, x));
const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
let spin = 0;
// the camera for step s: a spherical offset (r, phi, theta) around a target point
function poseFor(s) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, hMax = 0;
  for (const c of s.view === 'state' ? counties : s.view) {
    x0 = Math.min(x0, c.box.min.x); y0 = Math.min(y0, c.box.min.y);
    x1 = Math.max(x1, c.box.max.x); y1 = Math.max(y1, c.box.max.y);
    hMax = Math.max(hMax, c.target * s.raise);
  }
  const aspect = camera.aspect, ext = Math.max((x1 - x0) / 2 / Math.min(aspect, 1.6), (y1 - y0) / 2, hMax * 0.8, 60);
  const r = (ext * (s.zoom || 1.05)) / Math.tan(halfFov) + 40;
  return { r, phi: s.phi, theta: s.theta + (s.spin ? spin : 0),
    target: new THREE.Vector3((x0 + x1) / 2, Math.min(hMax * 0.4, 180), -(y0 + y1) / 2 + (narrow() ? r * 0.12 : 0)) };
}
function setPose(o) {
  camera.position.setFromSpherical(new THREE.Spherical(o.r, Math.max(o.phi, 1e-4), o.theta)).add(o.target);
  camera.lookAt(o.target);
}
// Fly from pose a to pose b: ease the angles, and pull the camera up and back mid-flight when the hop is long,
// so a jump from one corner of the state to another reads as a flight rather than a slide.
function fly(a, b, w) {
  const dt = Math.atan2(Math.sin(b.theta - a.theta), Math.cos(b.theta - a.theta));
  const hop = a.target.distanceTo(b.target);
  return { r: a.r + (b.r - a.r) * w + Math.sin(Math.PI * w) * hop * 0.7,
    phi: a.phi + (b.phi - a.phi) * w - Math.sin(Math.PI * w) * Math.min(a.phi, b.phi) * 0.25 * clamp01(hop / 400),
    theta: a.theta + dt * w, target: a.target.clone().lerp(b.target, w) };
}

// ---------- scroll → story position ----------
const narrow = () => matchMedia('(max-width: 820px)').matches;
const trigger = () => narrow() ? 0.62 : 0.5; // the line on screen where a card counts as "current"
function storyPos() { // a fractional step index: 2.5 = halfway from step 2 to step 3
  const line = innerHeight * trigger();
  const mids = stepEls.map(el => { const r = el.getBoundingClientRect(); return r.top + r.height * (narrow() ? 0.75 : 0.6); });
  if (line <= mids[0]) return 0;
  for (let i = 0; i < mids.length - 1; i++)
    if (line < mids[i + 1]) return i + (line - mids[i]) / (mids[i + 1] - mids[i]);
  return mids.length - 1;
}

// ---------- labels, key, tooltip ----------
const labelsEl = $('labels');
let labelSet = [], curStep = -1;
function setStep(i) {
  if (i === curStep) return;
  curStep = i;
  const s = STEPS[i];
  const hi = s.hi ? new Set(s.hi) : null;
  for (const c of counties) {
    c.litGoal = !hi || hi.has(c) ? 1 : 0;
    c.colorGoal = new THREE.Color(s.color === 'shift' ? shiftColor(c) : s.color.rows ? winnerColor(s.color.rows[c.i]) : winnerColor(c));
  }
  labelsEl.innerHTML = '';
  labelSet = s.labels.map(c => {
    const el = document.createElement('div'); el.className = 'label';
    el.innerHTML = `${c.name}<small>${s.label(c)}</small>`;
    labelsEl.appendChild(el); return { c, el };
  });
  const legLabels = ['<50%', '50–60', '60–70', '70–80', '80–90', '90+'];
  const row = cols => `<div class="legend">${cols.map((c, j) => `<div><i style="background:${c}"></i>${legLabels[j]}</div>`).join('')}</div>`;
  $('key').innerHTML = s.color === 'shift'
    ? `<div class="legend-title">Shift toward ${D.last} (D), 2024 President → 2026 Senate, points</div>
       <div class="legend">${SHIFT_D.map((c, j) => `<div><i style="background:${c}"></i>${j === 5 ? '50+' : `${SHIFT_BINS[j]}–${SHIFT_BINS[j + 1]}`}</div>`).join('')}</div>`
    : s.color.rows
    ? `<div class="legend-title">Republicans got more ${s.color.label} votes · share of county vote</div>${row(REP_C)}
       <div class="legend-title">Democrats got more</div>${row(DEM_C)}`
    : `<div class="legend-title">${R.last} (R) won · share of county vote</div>${row(REP_C)}
       <div class="legend-title">${D.last} (D) won</div>${row(DEM_C)}` +
      (s.raise ? `<div class="legend-title">Columns are split by vote</div><div class="split-key">
        <span><i style="background:${LOSER_C.dem}"></i>${D.last}</span><span><i style="background:${LOSER_C.rep}"></i>${R.last}</span><span><i style="background:${OTHER_C}"></i>Others</span></div>` : '');
  for (const b of $('dots').children) b.setAttribute('aria-current', +b.dataset.i === i ? 'step' : 'false');
  for (const el of stepEls) el.classList.toggle('active', +el.dataset.i === i);
}

const tip = $('tip'), ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
let hovered = null;
renderer.domElement.addEventListener('pointermove', e => {
  const r = renderer.domElement.getBoundingClientRect();
  mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const hit = ray.intersectObjects(pickables, false)[0]; // any segment selects its county
  hovered = hit ? hit.object.userData : null;
  if (!hovered) { tip.style.display = 'none'; return; }
  const c = hovered;
  tip.innerHTML = `<div class="n">${c.name} County</div>
    <div class="row"><span>${D.name} (D)</span><span>${fmt(c.dem)} · ${pct(c.dem, c.total, 1)}</span></div>
    <div class="row"><span>${R.name} (R)</span><span>${fmt(c.rep)} · ${pct(c.rep, c.total, 1)}</span></div>
    <div class="row m"><span>Total votes</span><span>${fmt(c.total)}</span></div>
    <div class="row m"><span>2026 Senate margin</span><span style="color:${c.m > 0 ? '#8fa8ff' : '#ff8b8b'}">${mg(c.m, 1)}</span></div>
    <div class="row m"><span>2024 President margin</span><span style="color:${c.m0 > 0 ? '#8fa8ff' : '#ff8b8b'}">${mg(c.m0, 1)}</span></div>
    <div class="row m"><span>Land area</span><span>${fmt(Math.round(c.landSqMi))} sq mi</span></div>` +
    (STEPS[curStep].color.rows ? (() => { const ch = STEPS[curStep].color, h = ch.rows[c.i], h0 = ch.rows0[c.i];
      return `<div class="row m"><span>2026 ${ch.label}, all districts here</span><span style="color:${h.dem > h.rep ? '#8fa8ff' : '#ff8b8b'}">${cm(h, 1)}</span></div>` +
        (h0.total ? `<div class="row m"><span>2024 ${ch.label}</span><span style="color:${h0.dem > h0.rep ? '#8fa8ff' : '#ff8b8b'}">${cm(h0, 1)}</span></div>` : ''); })() : '');
  tip.style.display = 'block';
  const x = e.clientX - r.left, y = e.clientY - r.top;
  tip.style.left = Math.max(8, Math.min(x + 14, r.width - tip.offsetWidth - 8)) + 'px';
  tip.style.top = Math.max(8, Math.min(y + 14, r.height - tip.offsetHeight - 8)) + 'px';
});
renderer.domElement.addEventListener('pointerleave', () => { tip.style.display = 'none'; hovered = null; });

// ---------- loop ----------
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
resize();

const paint = (m, color) => { m.material[0].color.copy(color); m.material[1].color.copy(color).multiplyScalar(0.8); };
const DIM = new THREE.Color('#1f2631'), HOVER = new THREE.Color('#ffffff'), tmp = new THREE.Color(), v = new THREE.Vector3();
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  const pos = storyPos(), i = Math.min(STEPS.length - 2, Math.floor(pos)), f = pos - i;
  // hold the camera still while a card is near the trigger line; fly in between
  const w = ease(clamp01((f - 0.2) / 0.6));
  setStep(Math.round(pos));
  if (STEPS[curStep].spin) spin += dt * 0.08;
  const a = STEPS[i], b = STEPS[i + 1] || a;
  setPose(fly(poseFor(a), poseFor(b), w));
  const raise = a.raise + (b.raise - a.raise) * w;
  const k = 1 - Math.exp(-dt * 5); // colors and highlights ease toward the current step's
  for (const c of counties) {
    layout(c, H_FLAT + (c.target - H_FLAT) * ease(clamp01((raise * 1.3 - c.delay))));
    c.lit += (c.litGoal - c.lit) * k;
    c.color.lerp(c.colorGoal, k);
    const lit = 0.18 + 0.82 * c.lit;
    tmp.copy(DIM).lerp(c.color, lit);
    if (c === hovered) tmp.lerp(HOVER, 0.35);
    paint(c.mesh, tmp);
    if (c.split) {
      paint(c.lower, tmp.copy(DIM).lerp(c.lowerColor, lit));
      paint(c.middle, tmp.copy(DIM).lerp(c.middleColor, lit));
    }
  }
  renderer.render(scene, camera);
  // labels: show only once the camera has settled, and never two on top of each other
  const W = stage.clientWidth, H = stage.clientHeight, show = Math.round(pos) === curStep && Math.abs(pos - Math.round(pos)) < 0.3;
  const placed = [];
  for (const { c, el } of labelSet) {
    v.set(c.cx, c.cy, c.h).applyMatrix4(mapGroup.matrixWorld).project(camera);
    const x = (v.x + 1) / 2 * W, y = (1 - v.y) / 2 * H, bw = el.offsetWidth, bh = el.offsetHeight;
    const box = [x - bw / 2, y - bh * 1.2, x + bw / 2, y - bh * 0.2];
    const clash = placed.some(q => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1]);
    if (!clash) placed.push(box);
    el.style.opacity = show && !clash && v.z < 1 ? 1 : 0;
    el.style.left = x + 'px'; el.style.top = y + 'px';
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
