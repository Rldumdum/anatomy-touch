// Usage: node scripts/inspect-fbx.mjs raw/fbx/MuscularSystem100.fbx > raw/muscles_tree.txt
import { loadFbx } from './fbx-util.mjs';

const root = loadFbx(process.argv[2]);
let meshes = 0, tris = 0;
function walk(o, d) {
  let t = 0;
  if (o.isMesh) {
    meshes++;
    const g = o.geometry;
    t = (g.index ? g.index.count : g.attributes.position.count) / 3;
    tris += t;
  }
  const mat = o.isMesh ? (Array.isArray(o.material) ? o.material.map((m) => m.name).join('+') : o.material?.name) : '';
  console.log(`${'  '.repeat(d)}${o.type}:${o.name}${o.isMesh ? ` tris=${t} mat=${mat}` : ''} kids=${o.children.length}`);
  for (const c of o.children) walk(c, d + 1);
}
walk(root, 0);
console.error(`meshes=${meshes} tris=${tris}`);
