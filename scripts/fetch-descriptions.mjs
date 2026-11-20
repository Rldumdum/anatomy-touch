// Fetch Z-Anatomy (Wikipedia-derived, CC BY-SA) descriptions for every part and distil them into src/data/info.json
//   node scripts/fetch-descriptions.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE = path.join(ROOT, 'raw/desc');
fs.mkdirSync(CACHE, { recursive: true });
const BASE = 'https://raw.githubusercontent.com/LluisV/Z-Anatomy/PC-Version/Resources/Descriptions/OriginalDescriptions/';

const files = fs.readFileSync(path.join(ROOT, 'raw/desc_files.txt'), 'utf8').split(/\r?\n/).filter(Boolean);
const lookup = new Map(files.map((f) => [f.replace(/\.txt$/, '').replace(/[()]/g, '').toLowerCase().trim(), f]));
const { parts } = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/parts.json'), 'utf8'));

const ORDINAL = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'];
const REGION = { C: 'cervical', T: 'thoracic', L: 'lumbar' };
function candidates(name) {
  const n = name.toLowerCase();
  const out = [n, n.replace(/ muscle$/, ''), `${n} muscle`, n.replace(/ muscles$/, ''), n.replace(/ bone$/, '')];
  const v = name.match(/^Vertebra ([CTL])(\d+)$/);
  if (v) out.push(`${ORDINAL[+v[2]]} ${REGION[v[1]]} vertebra`, `${REGION[v[1]]} vertebrae`);
  if (/^Atlas/.test(name)) out.push('atlas', 'atlas c1');
  if (/^Axis/.test(name)) out.push('axis', 'axis c2');
  if (/^Intervertebral disc/.test(name)) out.push('intervertebral disc');
  if (/^Nucleus pulposus/.test(name)) out.push('nucleus pulposus');
  if (/rib$/.test(n)) out.push('rib', 'ribs');
  if (/phalanx/.test(n)) out.push(/hand/.test(n) ? 'phalanges of hand' : 'phalanges of foot', 'phalanx');
  if (/metacarpal/.test(n)) out.push('metacarpal bones', 'metacarpal');
  if (/metatarsal/.test(n)) out.push('metatarsal bones', 'metatarsal');
  if (/costal cartilage/.test(n)) out.push('costal cartilage');
  if (/incisor|molar|canine|premolar/.test(n)) out.push(n.replace(/^(upper|lower) /, ''), 'tooth', 'teeth');
  return out;
}

async function getDesc(file) {
  const cachePath = path.join(CACHE, file.replace(/[\\/:*?"<>|]/g, '_'));
  if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath, 'utf8');
  const res = await fetch(BASE + encodeURIComponent(file));
  if (!res.ok) return null;
  const t = await res.text();
  fs.writeFileSync(cachePath, t);
  return t;
}

function distil(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const url = lines.map((l) => l.trim()).reverse().find((l) => /^https?:\/\//.test(l)) || null;
  const body = lines.filter((l) => !/^https?:\/\//.test(l.trim()));
  const sections = { _: [] };
  let cur = '_';
  for (const raw of body) {
    const l = raw.trim();
    const h = l.match(/^=+\s*(.*?)\s*=+$/);
    if (h) { cur = h[1].toLowerCase(); sections[cur] ??= []; continue; }
    if (l) sections[cur].push(l);
  }
  const intro = sections._.filter((l) => l !== l.toUpperCase() || l.length > 60); // drop the ALL-CAPS title
  const take = (arr, max) => {
    let out = '';
    for (const p of arr) { if ((out + ' ' + p).length > max && out) break; out = (out ? out + ' ' : '') + p; }
    return out.replace(/\s+/g, ' ').trim();
  };
  const fnKey = Object.keys(sections).find((k) => /^(function|action|actions)$/.test(k));
  const strKey = Object.keys(sections).find((k) => /^(structure|origin|insertion|attachments)$/.test(k));
  return {
    summary: take(intro, 520),
    function: fnKey ? take(sections[fnKey], 360) : '',
    structure: strKey ? take(sections[strKey], 360) : '',
    url,
  };
}

const names = [...new Set(parts.map((p) => p.name))];
const info = {};
let hit = 0;
const queue = [...names];
async function worker() {
  while (queue.length) {
    const name = queue.shift();
    const file = candidates(name).map((c) => lookup.get(c)).find(Boolean);
    if (!file) continue;
    const text = await getDesc(file);
    if (!text) continue;
    info[name] = distil(text);
    hit++;
  }
}
await Promise.all(Array.from({ length: 12 }, worker));
const ordered = Object.fromEntries(Object.keys(info).sort().map((k) => [k, info[k]]));
fs.writeFileSync(path.join(ROOT, 'src/data/info.json'), JSON.stringify(ordered));
console.log(`descriptions: ${hit}/${names.length}`);
console.log('missing:', names.filter((n) => !info[n]).join(' | '));
