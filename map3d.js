// The 3D county map shared by the flythrough (story.js) and the share-image page (scripts/panels.html): county shapes,
// outlines, and columns stacked by how each county voted. (app.js has its own copy of the same drawing code.)
import * as THREE from 'three';
import { geoConicEqualArea, geoCentroid } from 'd3-geo';
import { feature } from 'topojson-client';

export const GEO_URL = 'https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/counties-10m.json';
export const H_MAX = 420, H_FLAT = 0.8;
// Columns shorter than SPLIT_MIN (map units; the tallest column is H_MAX) are too short to read as a stack, so they stay one color.
export const SPLIT_MIN = 4;
export const LOSER_C = { dem: '#584cde', rep: '#d72f30' }, OTHER_C = '#5d6c82';
export const BINS = [40, 50, 60, 70, 80, 90];
export const REP_C = ['#ffb2b2', '#e27f7f', '#d75d5d', '#d72f30', '#c21b18', '#a80000'];
export const DEM_C = ['#a5b0ff', '#7996e2', '#6674de', '#584cde', '#3933e5', '#0d0596'];
export function winnerColor(c) {
  const i = Math.max(0, BINS.findLastIndex(b => 100 * Math.max(c.dem, c.rep) / c.total >= b));
  return (c.dem > c.rep ? DEM_C : REP_C)[i];
}

// Outline of an extruded county (height 1): the border at the bottom and top, plus a vertical line at each corner,
// faded by how sharply the border turns there, so wiggly river borders don't streak the columns.
const CORNER_MIN = 10, CORNER_FULL = 90;
function outlineGeometry(shapes) {
  const pos = [], col = [];
  const line = (a, b, za, zb, alpha) => { pos.push(a.x, a.y, za, b.x, b.y, zb); col.push(1, 1, 1, alpha, 1, 1, 1, alpha); };
  for (const shape of shapes) {
    for (const ring of [shape.getPoints(), ...shape.holes.map(h => h.getPoints())]) {
      const pts = ring.filter((q, i) => i === 0 || !q.equals(ring[i - 1]));
      if (pts.length > 2 && pts[0].equals(pts.at(-1))) pts.pop();
      const n = pts.length;
      for (let i = 0; i < n; i++) {
        const prev = pts[(i + n - 1) % n], cur = pts[i], next = pts[(i + 1) % n];
        line(cur, next, 0, 0, 1); line(cur, next, 1, 1, 1);
        const a = cur.clone().sub(prev).normalize(), b = next.clone().sub(cur).normalize();
        const turn = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1)));
        if (turn < CORNER_MIN) continue;
        line(cur, cur, 0, 1, turn >= CORNER_FULL ? 1 : ((turn - CORNER_MIN) / (CORNER_FULL - CORNER_MIN)) ** 2);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  return geo;
}

// Adds Texas's counties to `scene`. `counties` are objects with fips, dem, rep, other and total; each gets
// lower / middle / mesh (its column segments: runner-up, third-party, winner), box, cx/cy and target (full height).
export function buildMap(scene, us, counties, { maxTotal, edgeOpacity = 0.55 } = {}) {
  const byFips = new Map(counties.map(c => [c.fips, c]));
  const geo = feature(us, us.objects.counties);
  const tx = { type: 'FeatureCollection', features: geo.features.filter(f => String(f.id).startsWith('48')) };
  const projection = geoConicEqualArea().parallels([27.5, 35]).rotate([99.5, 0]).fitExtent([[-500, -500], [500, 500]], tx);
  const P = ([lon, lat]) => { const [x, y] = projection([lon, lat]); return new THREE.Vector2(x, -y); };
  const ringPts = ring => { const pts = ring.map(P); pts.pop(); return pts; };
  const mapGroup = new THREE.Group();
  mapGroup.rotation.x = -Math.PI / 2; // shapes in XY, extruded along +Z = world up; map y becomes world -z
  scene.add(mapGroup);
  const edgeMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: edgeOpacity });
  const pickables = [];
  maxTotal ??= Math.max(...counties.map(c => c.total));
  for (const f of tx.features) {
    const c = byFips.get(String(f.id)); if (!c) continue;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    const shapes = polys.map(([outer, ...holes]) => {
      const s = new THREE.Shape(ringPts(outer));
      for (const h of holes) s.holes.push(new THREE.Path(ringPts(h)));
      return s;
    });
    const g = new THREE.ExtrudeGeometry(shapes, { depth: 1, bevelEnabled: false });
    g.computeBoundingBox();
    const edges = outlineGeometry(shapes);
    const seg = color => {
      const m = new THREE.Mesh(g, [new THREE.MeshBasicMaterial(), new THREE.MeshLambertMaterial()]);
      m.add(new THREE.LineSegments(edges, edgeMat));
      m.userData = c; mapGroup.add(m); pickables.push(m);
      if (color) paint(m, new THREE.Color(color));
      return m;
    };
    const dWon = c.dem > c.rep;
    const cen = P(geoCentroid(f));
    Object.assign(c, {
      cx: cen.x, cy: cen.y, box: g.boundingBox,
      target: Math.max(H_FLAT, H_MAX * c.total / maxTotal),
      fLower: (dWon ? c.rep : c.dem) / c.total, fMiddle: c.other / c.total,
      lower: seg(dWon ? LOSER_C.rep : LOSER_C.dem), middle: seg(OTHER_C), mesh: seg(),
    });
    c.split = c.target >= SPLIT_MIN;
    paint(c.mesh, new THREE.Color(winnerColor(c)));
    layout(c, H_FLAT);
  }
  return { mapGroup, pickables, tx };
}

// place a county's segments for a column of height h
export function layout(c, h) {
  c.h = h;
  if (!c.split) {
    c.lower.visible = c.middle.visible = false;
    c.mesh.position.z = 0; c.mesh.scale.z = h;
    return;
  }
  const a = h * c.fLower, b = h * c.fMiddle;
  c.lower.visible = a > 0; c.lower.scale.z = Math.max(a, 1e-4);
  c.middle.visible = b > 0; c.middle.position.z = a; c.middle.scale.z = Math.max(b, 1e-4);
  c.mesh.position.z = a + b; c.mesh.scale.z = Math.max(h - a - b, 1e-4);
}
export const paint = (m, color) => { m.material[0].color.copy(color); m.material[1].color.copy(color).multiplyScalar(0.8); };
