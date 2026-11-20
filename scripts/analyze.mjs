// Explore the BodyParts3D IS-A tree: list muscle and bone leaf concepts with their element files.
import fs from 'node:fs';
import path from 'node:path';

const RAW = path.resolve(import.meta.dirname, '../raw');
const tsv = (f) => fs.readFileSync(path.join(RAW, f), 'utf8').trim().split(/\r?\n/).slice(1).map((l) => l.split('\t'));

const names = new Map(tsv('isa_parts_list_e.txt').map(([id, , en]) => [id, en]));
const children = new Map();
for (const [p, , c] of tsv('isa_inclusion_relation_list.txt')) {
  if (!children.has(p)) children.set(p, []);
  children.get(p).push(c);
}
const elements = new Map();
for (const [id, , fj] of tsv('isa_element_parts.txt')) {
  if (!elements.has(id)) elements.set(id, []);
  elements.get(id).push(fj);
}

function descendants(root) {
  const out = new Set();
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    for (const c of children.get(n) || []) if (!out.has(c)) { out.add(c); stack.push(c); }
  }
  return out;
}

const mode = process.argv[2] || 'muscle';
const root = mode === 'bone' ? 'FMA5018' : 'FMA5022';
const set = descendants(root);
const leaves = [...set].filter((id) => !(children.get(id) || []).length);
const rows = leaves.map((id) => [id, names.get(id), (elements.get(id) || []).length]).sort((a, b) => a[1].localeCompare(b[1]));
for (const r of rows) console.log(r.join('\t'));
console.error(`${mode}: ${set.size} concepts, ${leaves.length} leaves, with elements: ${rows.filter((r) => r[2]).length}`);
