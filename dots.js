// One dot per voter, shared by the ?dot= view of the main map (app.js) and the "See every single voter" page (voters.js).
// dots-worker.js places the dots; this module turns them into one THREE.Points drawn by a small shader.
//
// We only know how many people voted in each county, not where they live, so each county's voters are scattered at
// random inside its borders. Each dot also knows its place in the county's raised column (uniforms.uP: 0 = flat map,
// 1 = raised), so the main map's columns can be built from voters.
import * as THREE from 'three';

export const DOT_C = { dem: '#6c7dff', rep: '#ff3b3b', other: '#9aa6b8' };

// A county's area as a flat list of triangles (x0,y0,x1,y1,x2,y2 ...), in map units, from its THREE.Shapes.
export function countyTris(shapes) {
  const tris = [];
  for (const s of shapes) {
    const { shape, holes } = s.extractPoints(1);
    const faces = THREE.ShapeUtils.triangulateShape(shape, holes); // drops repeated end points in place
    const pts = [...shape, ...holes.flat()];
    for (const [a, b, d] of faces) tris.push(pts[a].x, pts[a].y, pts[b].x, pts[b].y, pts[d].x, pts[d].y);
  }
  return new Float32Array(tris);
}

const glslColor = h => { const c = new THREE.Color(h); return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`; };

// uniforms (all sizes in device pixels):
//   uP       rise progress, same timing as the main map's columns (0 = flat)
//   uReveal  share of dots shown (0..1), in a fixed random order, to let the dots appear gradually
//   uMinSize smallest dot size; uFocus, uFocusSize: index of one county (in the order given to place()) whose dots get
//            a different smallest size, -1 for none; uWorld: dot diameter in map units, so dots grow as the camera comes close
//   uViewH   drawing buffer height, to turn uWorld into pixels
export function createDots({ depthTest = true } = {}) {
  const uniforms = {
    uP: { value: 0 }, uReveal: { value: 1 }, uMinSize: { value: 1 }, uWorld: { value: 0.012 }, uViewH: { value: 800 },
    uCounties: { value: null }, uFocus: { value: -1 }, uFocusSize: { value: 1 },
  };
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, uniforms, depthTest, depthWrite: depthTest,
    vertexShader: `precision highp float; precision highp int; precision highp sampler2D;
      uniform mat4 modelViewMatrix, projectionMatrix;
      uniform float uP, uReveal, uMinSize, uWorld, uViewH, uFocus, uFocusSize;
      uniform sampler2D uCounties; // per county: center x, center y, map units per step, rise delay
      in ivec4 position;           // from dots-worker.js: x, y steps from the county center, height * 64, party * 256 + county
      out vec3 vColor; out float vSize;
      float ease(float t) { return t < .5 ? 4. * t * t * t : 1. - pow(-2. * t + 2., 3.) / 2.; }
      void main() {
        uint h = uint(gl_VertexID) * 2654435761u; h ^= h >> 16; h *= 2246822519u; h ^= h >> 13;
        if (float(h & 16777215u) / 16777216. >= uReveal) { gl_Position = vec4(2., 2., 2., 1.); gl_PointSize = 1.; return; }
        float party = float(position.w >> 8);
        int cix = position.w & 255;
        float ci = float(cix);
        vec4 C = texelFetch(uCounties, ivec2(cix, 0), 0);
        vec3 q = vec3(position.xyz);
        float k = ease(clamp((uP - 0.3 - C.w) / 0.45, 0., 1.));
        vec4 mv = modelViewMatrix * vec4(C.x + q.x * C.z, C.y + q.y * C.z, 0.2 + q.z / 64. * k, 1.);
        gl_Position = projectionMatrix * mv;
        vSize = max(abs(ci - uFocus) < .5 ? uFocusSize : uMinSize, uWorld * projectionMatrix[1][1] * uViewH * 0.5 / max(-mv.z, 1e-3));
        gl_PointSize = vSize;
        vColor = party < .5 ? ${glslColor(DOT_C.dem)} : party < 1.5 ? ${glslColor(DOT_C.rep)} : ${glslColor(DOT_C.other)};
      }`,
    fragmentShader: `precision highp float;
      in vec3 vColor; in float vSize; out vec4 outColor;
      void main() {
        vec2 d = gl_PointCoord - .5;
        if (vSize > 2.5 && dot(d, d) > .25) discard; // round dots once they are big enough to see a shape
        outColor = vec4(vColor, 1.);
      }`,
  });
  const points = new THREE.Points(new THREE.BufferGeometry(), material);
  points.frustumCulled = false; // the bounding sphere would be computed from the fixed-point values
  const worker = new Worker(new URL('./dots-worker.js', import.meta.url));
  let job = 0, done = null;
  worker.onmessage = ({ data: { buf, table, counts, job: j } }) => {
    if (j !== job) return; // a newer request came in while this one was being placed
    points.geometry.dispose();
    const g = new THREE.BufferGeometry();
    // read as integers (ivec4): Direct3D, behind WebGL on Windows, can't turn 16-bit integers into floats itself, and
    // converting ten million dots on the CPU every frame is far too slow
    const attr = new THREE.Int16BufferAttribute(buf, 4);
    attr.gpuType = THREE.IntType;
    g.setAttribute('position', attr);
    points.geometry = g;
    uniforms.uCounties.value?.dispose();
    const tex = new THREE.DataTexture(table, table.length / 4, 1, THREE.RGBAFormat, THREE.FloatType);
    tex.needsUpdate = true;
    uniforms.uCounties.value = tex;
    done({ n: counts[0] + counts[1] + counts[2], counts });
  };
  // counties: [{ tris, dem, rep, other, target (raised height, map units), delay (rise delay, 0..0.25) }]
  function place(counties, { per = 1, seed = 1 } = {}) {
    return new Promise(resolve => {
      done = resolve;
      worker.postMessage({ per, seed, job: ++job,
        counties: counties.map(({ tris, dem, rep, other, target = 0, delay = 0 }) => ({ tris, dem, rep, other, target, delay })) });
    });
  }
  return { points, uniforms, place };
}
