// Build web-ready anatomy assets from the Z-Anatomy FBX exports (BodyParts3D-derived, CC BY-SA 4.0).
//   node scripts/build-model.mjs
// Outputs public/models/{muscles,bones,attachments}.glb and src/data/parts.json
import fs from 'node:fs';
import path from 'node:path';
import { loadFbx, THREE } from './fbx-util.mjs';
import { Document, NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { quantize, reorder } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

const ROOT = path.resolve(import.meta.dirname, '..');
const RAW = path.join(ROOT, 'raw/fbx');
const OUT_MODELS = path.join(ROOT, 'public/models');
const OUT_DATA = path.join(ROOT, 'src/data');
fs.mkdirSync(OUT_MODELS, { recursive: true });
fs.mkdirSync(OUT_DATA, { recursive: true });

await MeshoptSimplifier.ready;
await MeshoptEncoder.ready;

const BODY_HEIGHT = 1.75; // metres, final model height

// ---------- helpers ----------
const clean = (s) => s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
const stripG = (s) => s.replace(/g$/, '');
function matNames(o) {
  return (Array.isArray(o.material) ? o.material : [o.material]).map((m) => (m?.name || '').replace(/\.\d+$/, ''));
}
function ancestors(o) {
  const out = [];
  for (let p = o.parent; p; p = p.parent) if (p.name) out.push(p.name);
  return out; // nearest first
}

const MUSCLE_REGIONS = [
  [/lower_limb/i, 'Lower limb'], [/upper_limb/i, 'Upper limb'], [/Cranial/i, 'Head'], [/Cervical/i, 'Neck'],
  [/Thoracic/i, 'Thorax'], [/Abdominal/i, 'Abdomen'], [/Dorsal/i, 'Back'], [/Pelvic/i, 'Pelvis'],
];
const BONE_REGIONS = [
  [/lower_limb|pelvic_girdle|Bony_pelvis/i, 'Lower limb & pelvis'], [/upper_limb|Pectoral_girdle/i, 'Upper limb & shoulder'],
  [/Cranium|head|Teeth|ossicle|Nasal|Laryngeal|ear/i, 'Skull & head'], [/Vertebral/i, 'Spine'], [/Thoracic_skeleton|thorax|Ribs|Sternum|Costal/i, 'Thorax'],
];
function regionOf(anc, table) {
  for (const a of anc) for (const [re, name] of table) if (re.test(a)) return name;
  return 'Other';
}

// Weld a non-indexed triangle soup (positions + per-vertex tissue). Averages tissue across welded duplicates.
function weld(pos, tissue, eps) {
  const map = new Map();
  const outPos = [], tSum = [], tCnt = [];
  const index = new Uint32Array(pos.length / 3);
  const inv = 1 / eps;
  for (let i = 0; i < pos.length / 3; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const key = `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = outPos.length / 3;
      map.set(key, id);
      outPos.push(x, y, z);
      tSum.push(0); tCnt.push(0);
    }
    tSum[id] += tissue[i]; tCnt[id]++;
    index[i] = id;
  }
  const t = new Float32Array(tSum.length);
  for (let i = 0; i < t.length; i++) t[i] = tSum[i] / tCnt[i];
  return { pos: new Float32Array(outPos), tissue: t, index };
}

// Remove unreferenced vertices after simplification.
function compact(pos, attrs, index) {
  const remap = new Int32Array(pos.length / 3).fill(-1);
  let n = 0;
  for (const i of index) if (remap[i] < 0) remap[i] = n++;
  const np = new Float32Array(n * 3);
  const na = attrs.map((a) => new Float32Array(n * a.size));
  for (let i = 0; i < remap.length; i++) {
    const j = remap[i];
    if (j < 0) continue;
    np.set(pos.subarray(i * 3, i * 3 + 3), j * 3);
    attrs.forEach((a, k) => na[k].set(a.array.subarray(i * a.size, i * a.size + a.size), j * a.size));
  }
  const ni = new Uint32Array(index.length);
  for (let i = 0; i < index.length; i++) ni[i] = remap[index[i]];
  return { pos: np, attrs: na, index: ni };
}

function computeNormals(pos, index) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeVertexNormals();
  return g.attributes.position && g.attributes.normal.array;
}

// Principal axis via power iteration on covariance.
function pca(pos) {
  const n = pos.length / 3;
  const c = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) c[k] += pos[i * 3 + k] / n;
  const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const d = [pos[i * 3] - c[0], pos[i * 3 + 1] - c[1], pos[i * 3 + 2] - c[2]];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a * 3 + b] += d[a] * d[b] / n;
  }
  let v = [0.3, 1, 0.2];
  for (let it = 0; it < 40; it++) {
    const w = [0, 1, 2].map((a) => C[a * 3] * v[0] + C[a * 3 + 1] * v[1] + C[a * 3 + 2] * v[2]);
    const l = Math.hypot(...w) || 1;
    v = w.map((x) => x / l);
  }
  return { center: c, axis: v };
}

// Per-vertex muscle-fibre direction: field lines between tendon clusters (origin ↔ insertion).
function fibreField(pos, tissue) {
  const n = pos.length / 3;
  const { center, axis } = pca(pos);
  const proj = (i) => (pos[i * 3] - center[0]) * axis[0] + (pos[i * 3 + 1] - center[1]) * axis[1] + (pos[i * 3 + 2] - center[2]) * axis[2];
  const tend = [];
  for (let i = 0; i < n; i++) if (tissue[i] > 0.5) tend.push(i);
  const out = new Float32Array(n * 3);
  const setAxis = () => { for (let i = 0; i < n; i++) out.set(axis, i * 3); };
  if (tend.length < 6) { setAxis(); return { fibre: out, center, axis }; }
  // 2-means on tendon vertices split by projection sign
  const A = [], B = [];
  for (const i of tend) (proj(i) < 0 ? A : B).push(i);
  const centroid = (arr) => { const c = [0, 0, 0]; for (const i of arr) for (let k = 0; k < 3; k++) c[k] += pos[i * 3 + k] / arr.length; return c; };
  const minShare = 0.08 * tend.length;
  const poles = [];
  if (A.length >= minShare) poles.push(centroid(A));
  if (B.length >= minShare) poles.push(centroid(B));
  if (poles.length === 0) { setAxis(); return { fibre: out, center, axis }; }
  for (let i = 0; i < n; i++) {
    const p = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
    let d = [0, 0, 0];
    poles.forEach((q, k) => {
      const v = [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
      const l = Math.hypot(...v) || 1;
      const s = k === 0 ? 1 : -1; // away from pole 0, towards pole 1
      for (let j = 0; j < 3; j++) d[j] += (s * v[j]) / l;
    });
    let l = Math.hypot(...d);
    if (l < 1e-4) { d = axis; l = 1; }
    // keep orientation consistent with the main axis
    const sgn = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2] < 0 ? -1 : 1;
    out[i * 3] = (sgn * d[0]) / l; out[i * 3 + 1] = (sgn * d[1]) / l; out[i * 3 + 2] = (sgn * d[2]) / l;
  }
  return { fibre: out, center, axis };
}

// ---------- collect source meshes ----------
console.time('load');
const muscleRoot = loadFbx(path.join(RAW, 'MuscularSystem100.fbx'));
const boneRoot = loadFbx(path.join(RAW, 'SkeletalSystem100.fbx'));
const jointRoot = loadFbx(path.join(RAW, 'Joints100.fbx'));
console.timeEnd('load');
for (const r of [muscleRoot, boneRoot, jointRoot]) r.updateMatrixWorld(true);

const parts = []; // {src mesh, kind, tissueFor(matName)}
const SKIP_MUSCLE_MAT = /^(Bursa|Fascia|Articular capsule|__DEFAULT)$/;

muscleRoot.traverse((o) => {
  if (!o.isMesh) return;
  const mats = matNames(o);
  if (!mats.some((m) => m === 'Tendon')) return;
  if (mats.some((m) => SKIP_MUSCLE_MAT.test(m))) return;
  const allTendon = mats.every((m) => /Tendon|Ligament|Cartilage/.test(m));
  parts.push({ o, kind: allTendon ? 'tendon' : 'muscle', tissue: (m) => (/Tendon|Ligament|Cartilage/.test(m) ? 1 : 0) });
});

const attachments = [];
boneRoot.traverse((o) => {
  if (!o.isMesh) return;
  const mats = matNames(o);
  if (mats.some((m) => /^(Origin|End)-/.test(m))) { attachments.push(o); return; }
  if (/muscle|^Sinus_of/i.test(o.name)) return;
  if (mats.some((m) => /^Teeth/.test(m))) {
    parts.push({ o, kind: 'tooth', tissue: (m) => (m === 'Teeth' ? 1 : 0) });
  } else if (mats.some((m) => /^(Bone|Cartilage|Suture)/.test(m))) {
    const onlyCart = mats.every((m) => /^Cartilage/.test(m));
    parts.push({ o, kind: onlyCart ? 'cartilage' : 'bone', tissue: (m) => (/^Cartilage/.test(m) ? 1 : 0) });
  }
});
jointRoot.traverse((o) => {
  if (!o.isMesh) return;
  const mats = matNames(o);
  if (mats.length === 1 && mats[0] === 'Cartilage') parts.push({ o, kind: 'cartilage', tissue: () => 1, joint: true });
});
console.log(`parts: ${parts.length} (muscle ${parts.filter((p) => p.kind === 'muscle').length}), attachments: ${attachments.length}`);

// ---------- names ----------
const muscleRawNames = new Set(parts.filter((p) => p.kind === 'muscle' || p.kind === 'tendon').map((p) => p.o.name));
const allRawNames = new Set(parts.map((p) => p.o.name));
function baseAndSide(name) {
  const m = name.match(/^(.*?)([rl])$/);
  if (m) {
    const other = m[1] + (m[2] === 'r' ? 'l' : 'r');
    if (allRawNames.has(other) || /(muscle|muscles|bone|cartilage|rib|finger_of_(hand|foot)|incisor|molar|canine|premolar|_[A-Za-z]+us|Talus|Patella|Femur|Tibia|Fibula|Ulna|Radius|Scapula|Clavicle|Humerus|Calcaneus|Maxilla|Incus|Malleus|Stapes|meniscus)$/i.test(m[1]))
      return { base: m[1], side: m[2] === 'r' ? 'right' : 'left' };
  }
  return { base: name, side: null };
}

// ---------- process geometry ----------
const bbox = new THREE.Box3();
const processed = [];
const tmpGeo = (o) => {
  const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
  g.applyMatrix4(o.matrixWorld);
  const flip = o.matrixWorld.determinant() < 0;
  return { g, flip };
};

for (const p of parts) {
  const { g, flip } = tmpGeo(p.o);
  const pos = g.attributes.position.array;
  const nv = pos.length / 3;
  if (nv < 9) continue;
  if (flip) for (let i = 0; i < nv; i += 3) for (let k = 0; k < 3; k++) { const t = pos[i * 3 + 3 + k]; pos[i * 3 + 3 + k] = pos[i * 3 + 6 + k]; pos[i * 3 + 6 + k] = t; }
  const mats = matNames(p.o);
  const tissue = new Float32Array(nv);
  if (g.groups.length) for (const gr of g.groups) { const t = p.tissue(mats[gr.materialIndex] ?? mats[0]); tissue.fill(t, gr.start, gr.start + gr.count); }
  else tissue.fill(p.tissue(mats[0]));
  processed.push({ p, pos: new Float32Array(pos), tissue });
  for (let i = 0; i < nv; i++) bbox.expandByPoint(new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]));
}
const size = bbox.getSize(new THREE.Vector3());
console.log('raw bbox', bbox.min.toArray().map((v) => v.toFixed(3)), bbox.max.toArray().map((v) => v.toFixed(3)));
// Up axis = largest extent
const upAxis = ['x', 'y', 'z'][[size.x, size.y, size.z].indexOf(Math.max(size.x, size.y, size.z))];
console.log('up axis', upAxis, 'size', size.toArray().map((v) => v.toFixed(3)));
const S = BODY_HEIGHT / size[upAxis];
const centre = bbox.getCenter(new THREE.Vector3());
// Transform: centre at origin horizontally, feet at y=0, Y-up.
function xform(pos) {
  for (let i = 0; i < pos.length; i += 3) {
    let x = pos[i] - centre.x, y = pos[i + 1] - centre.y, z = pos[i + 2] - centre.z;
    if (upAxis === 'z') { const t = y; y = z; z = -t; }
    pos[i] = x * S; pos[i + 1] = y * S + BODY_HEIGHT / 2; pos[i + 2] = z * S;
  }
}

const RATIO = { muscle: 0.5, tendon: 0.5, bone: 0.55, cartilage: 0.6, tooth: 0.4 };
const MIN_TRIS = 300;
let triIn = 0, triOut = 0;
const built = [];
for (const { p, pos, tissue } of processed) {
  xform(pos);
  const w = weld(pos, tissue, 0.00002 / S * S); // ~0.02 mm
  const tris = w.index.length / 3;
  triIn += tris;
  let index = w.index;
  const target = Math.max(Math.min(tris, MIN_TRIS), Math.floor(tris * RATIO[p.kind]));
  if (target < tris) {
    const [simp] = MeshoptSimplifier.simplify(index, w.pos, 3, target * 3, 0.0015, ['LockBorder']);
    if (simp.length >= 3 * 12) index = simp;
  }
  const c = compact(w.pos, [{ array: w.tissue, size: 1 }], index);
  const normal = computeNormals(c.pos, c.index);
  const tis = c.attrs[0];
  let fibre = null, center, axis;
  if (p.kind === 'muscle' || p.kind === 'tendon') ({ fibre, center, axis } = fibreField(c.pos, tis));
  else ({ center, axis } = pca(c.pos));
  triOut += c.index.length / 3;
  built.push({ p, pos: c.pos, normal, tissue: tis, fibre, index: c.index, center, axis });
}
console.log(`triangles ${triIn} -> ${triOut}`);

// ---------- metadata ----------
const meta = [];
const usedIds = new Set();
for (const b of built) {
  const { o, kind } = b.p;
  const { base, side } = baseAndSide(o.name);
  const anc = ancestors(o);
  const groups = anc.filter((a) => /g$/.test(a)).map(stripG);
  const isMuscleLayer = kind === 'muscle' || kind === 'tendon';
  const region = isMuscleLayer ? regionOf(anc, MUSCLE_REGIONS) : b.p.joint ? (/menisc/i.test(o.name) ? 'Lower limb & pelvis' : /Interpubic|symphysis/i.test(o.name) ? 'Lower limb & pelvis' : 'Spine') : regionOf(anc, BONE_REGIONS);
  const group = groups[0] ? clean(groups[0]) : region;
  // parent muscle: "Short head of biceps femoris" -> "Biceps femoris"
  let parent = null;
  const pm = isMuscleLayer && clean(base.replace(/[()]/g, '')).match(/^.*? (?:head|part|belly|parts) of (.+)$/i);
  if (pm) parent = pm[1].charAt(0).toUpperCase() + pm[1].slice(1);
  // per-part bounding sphere
  let r = 0;
  for (let i = 0; i < b.pos.length; i += 3) r = Math.max(r, Math.hypot(b.pos[i] - b.center[0], b.pos[i + 1] - b.center[1], b.pos[i + 2] - b.center[2]));
  let id = o.name.replace(/[^A-Za-z0-9_\-()]/g, '_');
  while (usedIds.has(id)) id += '_';
  usedIds.add(id);
  b.id = id;
  meta.push({
    id, layer: isMuscleLayer ? 'muscle' : 'bone', kind, name: clean(base.replace(/[()]/g, '')), side, region, group, parent,
    center: b.center.map((v) => +v.toFixed(4)), radius: +r.toFixed(4), axis: b.axis.map((v) => +v.toFixed(3)),
  });
}

// ---------- attachments (muscle origin / insertion areas on bones) ----------
const muscleBases = new Map(); // lowercased base -> name
for (const m of meta) if (m.layer === 'muscle') muscleBases.set(baseAndSide(m.id).base.toLowerCase(), m.name);
const attBuilt = [];
const attMeta = [];
for (const o of attachments) {
  const mm = o.name.match(/^(.*?)(o|e)(\d*)([rl]?)$/);
  if (!mm) continue;
  const [, base, oe, , s] = mm;
  const target = muscleBases.get(base.toLowerCase());
  if (!target) continue;
  const { g, flip } = tmpGeo(o);
  const pos = new Float32Array(g.attributes.position.array);
  const nv = pos.length / 3;
  if (flip) for (let i = 0; i < nv; i += 3) for (let k = 0; k < 3; k++) { const t = pos[i * 3 + 3 + k]; pos[i * 3 + 3 + k] = pos[i * 3 + 6 + k]; pos[i * 3 + 6 + k] = t; }
  xform(pos);
  const w = weld(pos, new Float32Array(nv), 0.00002);
  let index = w.index;
  const tris = index.length / 3;
  const tgt = Math.max(Math.min(tris, 120), Math.floor(tris * 0.35));
  if (tgt < tris) { const [simp] = MeshoptSimplifier.simplify(index, w.pos, 3, tgt * 3, 0.002, []); if (simp.length >= 36) index = simp; }
  const c = compact(w.pos, [{ array: w.tissue, size: 1 }], index);
  const normal = computeNormals(c.pos, c.index);
  let id = `att_${o.name.replace(/[^A-Za-z0-9_\-()]/g, '_')}`;
  while (usedIds.has(id)) id += '_';
  usedIds.add(id);
  attBuilt.push({ id, pos: c.pos, normal, index: c.index });
  attMeta.push({ id, muscle: target, type: oe === 'o' ? 'origin' : 'insertion', side: s === 'r' ? 'right' : s === 'l' ? 'left' : null });
}
console.log(`attachments matched: ${attMeta.length}`);

// ---------- write GLBs ----------
async function writeGlb(file, items, withTissue, withFibre) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('anatomy');
  for (const it of items) {
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(it.pos).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(it.normal)).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(it.pos.length / 3 > 65535 ? it.index : new Uint16Array(it.index)).setBuffer(buffer));
    if (withTissue) {
      const t = new Uint8Array(it.tissue.length);
      for (let i = 0; i < t.length; i++) t[i] = Math.round(Math.min(1, Math.max(0, it.tissue[i])) * 255);
      prim.setAttribute('_TISSUE', doc.createAccessor().setType('SCALAR').setArray(t).setNormalized(true).setBuffer(buffer));
    }
    if (withFibre && it.fibre) {
      const f = new Int8Array(it.fibre.length);
      for (let i = 0; i < f.length; i++) f[i] = Math.round(it.fibre[i] * 127);
      prim.setAttribute('_FIBRE', doc.createAccessor().setType('VEC3').setArray(f).setNormalized(true).setBuffer(buffer));
    }
    const mesh = doc.createMesh(it.id).addPrimitive(prim);
    scene.addChild(doc.createNode(it.id).setMesh(mesh));
  }
  await doc.transform(
    reorder({ encoder: MeshoptEncoder, target: 'size' }),
    quantize({ pattern: /^(POSITION|NORMAL)$/, quantizePosition: 16, quantizeNormal: 10, quantizationVolume: 'scene' }),
  );
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  await io.write(file, doc);
  console.log(path.basename(file), (fs.statSync(file).size / 1e6).toFixed(2), 'MB');
}

const byLayer = (l) => built.filter((b) => meta.find((m) => m.id === b.id).layer === l);
await writeGlb(path.join(OUT_MODELS, 'muscles.glb'), byLayer('muscle'), true, true);
await writeGlb(path.join(OUT_MODELS, 'bones.glb'), byLayer('bone'), true, false);
await writeGlb(path.join(OUT_MODELS, 'attachments.glb'), attBuilt, false, false);

fs.writeFileSync(path.join(OUT_DATA, 'parts.json'), JSON.stringify({ height: BODY_HEIGHT, parts: meta, attachments: attMeta }));
console.log('parts.json', meta.length, 'parts');
