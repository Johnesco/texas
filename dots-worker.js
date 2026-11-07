// Places one dot per voter (or per `per` voters) for dots.js. Each county's dots are scattered at random inside the
// county's shape, and each dot also gets a height inside the county's raised column: the runner-up's voters at the
// bottom, third-party and write-in voters in the middle, the winner's on top, as the stacked columns are drawn.
// The dots are written in random party order, so on a flat map no party is always drawn over the others.
//
// In:  { counties: [{ tris: Float32Array (x0,y0,x1,y1,x2,y2 per triangle, map units), dem, rep, other, target, delay }],
//        per, seed, job }
// Out: { buf: Int16Array, 4 per dot: x, y (fixed point around the county's center), height * Z, party * 256 + county index;
//        table: Float32Array, 4 per county: center x, center y, map units per x/y step, rise delay;
//        counts: [dem, rep, other] dots; job }
// party: 0 = Democratic, 1 = Republican, 2 = everyone else.
const Z = 64; // the tallest column is 420 map units
const STEPS = 32000; // x/y steps from a county's center to its farthest edge (Int16 holds ±32767)

// small fast seeded random (mulberry32), so a race always draws the same dots
function rng(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

onmessage = ({ data: { counties, per, seed, job } }) => {
  const n = c => [Math.round(c.dem / per), Math.round(c.rep / per), Math.round(c.other / per)];
  let total = 0;
  for (const c of counties) total += n(c).reduce((a, b) => a + b, 0);
  const buf = new Int16Array(total * 4), table = new Float32Array(counties.length * 4), counts = [0, 0, 0];
  const rand = rng(seed);
  let o = 0;
  counties.forEach((c, ci) => {
    const t = c.tris, T = t.length / 6;
    // center and reach of the county, for its fixed-point coordinates
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < t.length; i += 2) {
      x0 = Math.min(x0, t[i]); x1 = Math.max(x1, t[i]); y0 = Math.min(y0, t[i + 1]); y1 = Math.max(y1, t[i + 1]);
    }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, step = Math.max(x1 - x0, y1 - y0, 1e-6) / 2 / STEPS;
    table.set([cx, cy, step, c.delay || 0], ci * 4);
    const left = n(c);
    let all = left[0] + left[1] + left[2];
    if (!all || !T) return;
    // cumulative triangle areas, so a dot lands in a triangle in proportion to its area
    const cum = new Float64Array(T);
    let acc = 0;
    for (let i = 0; i < T; i++) {
      const j = i * 6;
      acc += Math.abs((t[j + 2] - t[j]) * (t[j + 5] - t[j + 1]) - (t[j + 4] - t[j]) * (t[j + 3] - t[j + 1])) / 2;
      cum[i] = acc;
    }
    // where each party's layer starts in the column, bottom to top: runner-up, others, winner
    const base = c.dem > c.rep ? [left[1] + left[2], 0, left[1]] : [0, left[0] + left[2], left[0]];
    const used = [0, 0, 0], size = all;
    for (let p = 0; p < 3; p++) counts[p] += left[p];
    while (all) {
      // draw a party at random from the voters still to place (without replacement)
      const r0 = rand() * all;
      const party = r0 < left[0] ? 0 : r0 < left[0] + left[1] ? 1 : 2;
      left[party]--; all--;
      const z = c.target * (base[party] + used[party]++ + rand()) / size;
      // pick a triangle (binary search on the cumulative areas), then a uniform point in it
      const r = rand() * acc;
      let lo = 0, hi = T - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < r) lo = m + 1; else hi = m; }
      const j = lo * 6;
      let a = rand(), b = rand();
      if (a + b > 1) { a = 1 - a; b = 1 - b; }
      const x = t[j] + a * (t[j + 2] - t[j]) + b * (t[j + 4] - t[j]);
      const y = t[j + 1] + a * (t[j + 3] - t[j + 1]) + b * (t[j + 5] - t[j + 1]);
      buf[o++] = Math.round((x - cx) / step); buf[o++] = Math.round((y - cy) / step); buf[o++] = Math.round(z * Z);
      buf[o++] = party * 256 + ci;
    }
  });
  postMessage({ buf, table, counts, job }, [buf.buffer, table.buffer]);
};
