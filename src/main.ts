import './style.css';
import * as THREE from 'three';
import { Viewer } from './viewer';
import { Anatomy, displaySide, type Layer, type Part } from './anatomy';
import { SoftTissue } from './soft';
import { Input } from './input';
import { Quiz, viewDirFor } from './quiz';
import { fullLabel, nameParts, norm, pretty } from './names';
import infoData from './data/info.json';

type Info = Record<string, { summary: string; function: string; structure: string; url: string | null }>;
const INFO = infoData as Info;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const viewer = new Viewer($<HTMLCanvasElement>('scene'));
const anatomy = new Anatomy();
const soft = new SoftTissue();
viewer.scene.add(anatomy.root);

let mode: 'explore' | 'quiz' = 'explore';
let quiz: Quiz;

// ---------- toast ----------
let toastTimer = 0;
function toast(msg: string, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), ms);
}

// ---------- HUD fade ----------
let interactions = 0;
function noteInteraction() {
  interactions++;
  if (interactions === 4) $('hud').classList.add('fade');
}
setTimeout(() => $('hud').classList.add('fade'), 14000);

// ---------- selection & info card ----------
const KIND_LABEL: Record<string, string> = { muscle: 'Muscle', tendon: 'Tendon / aponeurosis', bone: 'Bone', cartilage: 'Cartilage', tooth: 'Tooth' };

function fallbackInfo(p: Part) {
  if (/Intervertebral disc/.test(p.name)) return 'A fibrocartilaginous cushion between adjacent vertebral bodies. Its tough outer annulus fibrosus surrounds a gel-like nucleus pulposus, letting the spine bend while absorbing load.';
  if (/Nucleus pulposus/.test(p.name)) return 'The gel-like core of an intervertebral disc. It distributes pressure evenly across the disc; when it herniates through the annulus it can compress spinal nerves.';
  if (/symphysis/i.test(p.name)) return 'A secondary cartilaginous joint where two bones are united by fibrocartilage, allowing only slight movement.';
  return '';
}

function renderInfo(p: Part | null) {
  const card = $('info');
  if (!p || mode !== 'explore') { card.hidden = true; return; }
  card.hidden = false;
  $('info-crumb').textContent = [p.region, p.group !== p.region ? p.group.toLowerCase() : ''].filter(Boolean).join(' / ');
  const { title, sub } = nameParts(p.name, p.parent);
  $('info-name').textContent = title;
  $('info-sub').textContent = sub;
  const facts = $('info-chips');
  facts.innerHTML = '';
  const fact = (text: string, onClick?: () => void) => {
    const c = document.createElement(onClick ? 'button' : 'span');
    c.textContent = text;
    if (onClick) c.addEventListener('click', onClick);
    facts.appendChild(c);
  };
  fact([displaySide(p), KIND_LABEL[p.kind] ?? p.kind].filter(Boolean).join(' ').toLowerCase().replace(/^./, (s) => s.toUpperCase()));
  if (p.parent) fact(`Show whole ${pretty(p.parent).toLowerCase()}`, () => isolateFamily(p));
  const otherSide = anatomy.parts.find((q) => q.name === p.name && q !== p && q.side);
  if (otherSide) fact(`Go to ${otherSide.side} side`, () => selectPart(otherSide, true));

  const isMuscle = p.layer === 'muscle' && p.kind === 'muscle';
  (card.querySelector('[data-act="flex"]') as HTMLElement).hidden = !isMuscle;
  const isoBtn = card.querySelector('[data-act="isolate"] span') as HTMLElement;
  isoBtn.textContent = anatomy.isolated ? 'Exit isolate' : 'Isolate';
  card.querySelector('[data-act="isolate"]')!.classList.toggle('on', !!anatomy.isolated);
  $('info-legend').hidden = !(isMuscle && anatomy.showAttachments && anatomy.layerOn.bone && anatomy.hasAttachments(p));

  const info = INFO[p.name] ?? (p.parent ? INFO[p.parent] : undefined);
  const body = $('info-body');
  body.innerHTML = '';
  const para = (text: string) => { const el = document.createElement('p'); el.textContent = text; body.appendChild(el); };
  const head = (text: string) => { const el = document.createElement('h3'); el.textContent = text; body.appendChild(el); };
  if (info) {
    if (!INFO[p.name] && p.parent) { head(`About the ${pretty(p.parent).toLowerCase()}`); }
    para(info.summary);
    if (info.function) { head('Function'); para(info.function); }
    else if (info.structure) { head('Structure'); para(info.structure); }
    if (info.url) {
      const src = document.createElement('p');
      src.className = 'src';
      src.innerHTML = `Adapted from <a href="${info.url}" target="_blank" rel="noopener">Wikipedia</a> · CC BY-SA`;
      body.appendChild(src);
    }
  } else {
    const t = fallbackInfo(p);
    if (t) para(t);
  }
  card.scrollTop = 0;
}

function selectPart(p: Part | null, focus = false) {
  anatomy.select(p);
  renderInfo(p);
  if (p && focus) viewer.focus(p.centerV, p.radius, viewDirFor(p));
  viewer.invalidate();
}

function isolateFamily(p: Part) {
  const fam = anatomy.parts.filter((q) => q.parent === p.parent && q.side === p.side);
  anatomy.isolate(fam);
  const box = new THREE.Box3();
  for (const q of fam) box.expandByObject(q.mesh);
  const s = box.getBoundingSphere(new THREE.Sphere());
  viewer.focus(s.center, s.radius, viewDirFor(p));
  renderInfo(p);
}

$('info').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
  const p = anatomy.selected;
  if (!btn || !p) return;
  switch (btn.dataset.act) {
    case 'focus':
      viewer.focus(p.centerV, p.radius, viewDirFor(p));
      break;
    case 'isolate':
      if (anatomy.isolated) { anatomy.isolate(null); viewer.home(); }
      else { anatomy.isolate([p]); viewer.focus(p.centerV, p.radius, viewDirFor(p)); }
      renderInfo(p);
      break;
    case 'hide':
      anatomy.hide(p);
      selectPart(null);
      toast(`Peeled away the ${fullLabel(p.name, p.parent).toLowerCase()}. Restore brings it back.`);
      break;
    case 'flex':
      soft.flex(p);
      viewer.invalidate();
      break;
  }
});
$('info').querySelector('.close')!.addEventListener('click', () => selectPart(null));

// ---------- rail ----------
function bindToggle(id: string, get: () => boolean, set: (on: boolean) => void) {
  const el = $(id);
  const paint = () => el.setAttribute('aria-pressed', String(get()));
  el.addEventListener('click', () => { set(!get()); paint(); renderInfo(anatomy.selected); viewer.invalidate(); });
  paint();
  return paint;
}
const paintMuscles = bindToggle('tg-muscles', () => anatomy.layerOn.muscle, (on) => {
  if (!on && !anatomy.layerOn.bone) anatomy.setLayer('bone', true), paintBones();
  anatomy.setLayer('muscle', on);
  if (!on && anatomy.selected?.layer === 'muscle') selectPart(null);
});
const paintBones = bindToggle('tg-bones', () => anatomy.layerOn.bone, (on) => {
  if (!on && !anatomy.layerOn.muscle) anatomy.setLayer('muscle', true), paintMuscles();
  anatomy.setLayer('bone', on);
  if (!on && anatomy.selected?.layer === 'bone') selectPart(null);
});
bindToggle('tg-xray', () => anatomy.xray, (on) => {
  anatomy.setXray(on);
  if (on && !anatomy.layerOn.bone) { anatomy.setLayer('bone', true); paintBones(); }
});
bindToggle('tg-attach', () => anatomy.showAttachments, (on) => anatomy.setShowAttachments(on));
$('btn-reset').addEventListener('click', () => {
  viewer.home();
  anatomy.autoPeeled.clear();
  anatomy.isolate(null);
  selectPart(null);
});
$('btn-showall').addEventListener('click', () => {
  anatomy.showAll();
  renderInfo(anatomy.selected);
  toast('Everything is back in place.');
});
anatomy.onChange = () => {
  const n = anatomy.hidden.length + anatomy.autoPeeled.size + (anatomy.isolated ? 1 : 0);
  const btn = $<HTMLButtonElement>('btn-showall');
  btn.disabled = n === 0;
  const badge = btn.querySelector('.badge') as HTMLElement;
  const peeled = anatomy.hidden.length + anatomy.autoPeeled.size;
  badge.hidden = peeled === 0;
  badge.textContent = String(peeled);
  viewer.invalidate();
};

// ---------- mode ----------
function setMode(m: 'explore' | 'quiz') {
  mode = m;
  for (const b of document.querySelectorAll<HTMLButtonElement>('.top .seg button')) b.setAttribute('aria-selected', String(b.dataset.mode === m));
  selectPart(null);
  if (m === 'quiz') {
    if (!anatomy.layerOn.muscle) { anatomy.setLayer('muscle', true); paintMuscles(); }
    if (anatomy.xray) { anatomy.setXray(false); $('tg-xray').setAttribute('aria-pressed', 'false'); }
    quiz.enter();
  } else quiz.exit();
}
for (const b of document.querySelectorAll<HTMLButtonElement>('.top .seg button')) b.addEventListener('click', () => setMode(b.dataset.mode as 'explore' | 'quiz'));

// ---------- browser ----------
let browserLayer: Layer = 'muscle';
function renderBrowser() {
  const q = norm($<HTMLInputElement>('browser-q').value);
  const words = q.split(' ').filter(Boolean);
  const list = $('browser-list');
  list.innerHTML = '';
  const byName = new Map<string, Part[]>();
  for (const p of anatomy.parts) {
    if (p.layer !== browserLayer) continue;
    const label = fullLabel(p.name, p.parent);
    const n = norm(`${label} ${p.name}`);
    if (words.length && !words.every((w) => n.includes(w))) continue;
    if (!byName.has(label)) byName.set(label, []);
    byName.get(label)!.push(p);
  }
  const regions = new Map<string, [string, Part[]][]>();
  for (const [name, ps] of [...byName].sort((a, b) => a[0].localeCompare(b[0]))) {
    const r = ps[0].region;
    if (!regions.has(r)) regions.set(r, []);
    regions.get(r)!.push([name, ps]);
  }
  if (!regions.size) list.innerHTML = '<p class="empty">Nothing matches that. Try part of a name, like “glut” or “radius”.</p>';
  for (const [region, rows] of [...regions].sort((a, b) => a[0].localeCompare(b[0]))) {
    const h = document.createElement('h4');
    h.textContent = `${region} — ${rows.length}`;
    list.appendChild(h);
    for (const [name, ps] of rows) {
      const row = document.createElement('div');
      row.className = 'row';
      const nm = document.createElement('div');
      nm.className = 'nm';
      const small = document.createElement('small');
      small.textContent = ps[0].group !== region ? ps[0].group : '';
      nm.textContent = name;
      nm.appendChild(small);
      row.appendChild(nm);
      const sides = document.createElement('div');
      sides.className = 'sides';
      const sorted = [...ps].sort((a, b) => (a.side === 'left' ? -1 : 1) - (b.side === 'left' ? -1 : 1));
      for (const p of sorted) {
        const b = document.createElement('button');
        b.textContent = p.side ? p.side[0].toUpperCase() : '•';
        b.setAttribute('aria-label', `${name}${p.side ? `, ${p.side}` : ''}`);
        b.addEventListener('click', (e) => { e.stopPropagation(); goTo(p); });
        sides.appendChild(b);
      }
      row.appendChild(sides);
      row.addEventListener('click', () => goTo(sorted.find((p) => p.side === 'right') ?? sorted[0]));
      list.appendChild(row);
    }
  }
}
function goTo(p: Part) {
  if (!anatomy.layerOn[p.layer]) { anatomy.setLayer(p.layer, true); (p.layer === 'muscle' ? paintMuscles : paintBones)(); }
  if (anatomy.hidden.includes(p) || (anatomy.isolated && !anatomy.isolated.has(p))) { anatomy.hidden = anatomy.hidden.filter((h) => h !== p); anatomy.isolated = null; anatomy.refresh(); }
  if (mode === 'quiz') setMode('explore');
  selectPart(p, false);
  const eye = viewer.focus(p.centerV, p.radius, viewDirFor(p));
  if (p.layer === 'muscle') {
    const n = anatomy.reveal(p, eye);
    if (n) toast(`Peeled ${n} overlying muscle${n > 1 ? 's' : ''} away. Restore puts them back.`);
  }
  if (matchMedia('(max-width: 900px), (orientation: portrait)').matches) $('browser').hidden = true;
}
$('btn-search').addEventListener('click', () => {
  const d = $('browser');
  d.hidden = !d.hidden;
  if (!d.hidden && matchMedia('(orientation: portrait), (max-width: 760px)').matches) $('info').hidden = true;
  if (!d.hidden) { renderBrowser(); if (!matchMedia('(pointer: coarse)').matches) $('browser-q').focus(); }
});
$('browser-close').addEventListener('click', () => { $('browser').hidden = true; });
$('browser-q').addEventListener('input', renderBrowser);
for (const b of document.querySelectorAll<HTMLButtonElement>('#browser-tabs button')) {
  b.addEventListener('click', () => {
    browserLayer = b.dataset.layer as Layer;
    for (const o of document.querySelectorAll('#browser-tabs button')) o.setAttribute('aria-selected', String(o === b));
    renderBrowser();
  });
}

// ---------- help ----------
$('btn-help').addEventListener('click', () => { $('help').hidden = false; });
$('help').addEventListener('click', (e) => {
  if (e.target === $('help') || (e.target as HTMLElement).closest('.close')) $('help').hidden = true;
});

// ---------- gesture mode ----------
let gesture: import('./gesture').GestureControl | null = null;
let gesturePress: Part | null = null;
const cursorEl = $('hand-cursor');
$('btn-gesture').addEventListener('click', async () => {
  const btn = $('btn-gesture');
  const on = btn.getAttribute('aria-pressed') !== 'true';
  if (!on) {
    gesture?.stop();
    btn.setAttribute('aria-pressed', 'false');
    $('gesture-cam').hidden = true;
    cursorEl.hidden = true;
    viewer.hold('gesture', false);
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) { toast('This browser can’t use the camera.'); return; }
  btn.setAttribute('aria-pressed', 'true');
  $('gesture-cam').hidden = false;
  viewer.hold('gesture', true);
  try {
    const { GestureControl } = await import('./gesture');
    gesture ??= new GestureControl({
      rotate: (dx, dy) => viewer.orbitBy(dx * 5.5, dy * 3.5),
      zoom: (f) => viewer.zoomBy(f),
      cursor: (x, y, pose) => {
        cursorEl.hidden = false;
        cursorEl.style.transform = `translate(${x}px, ${y}px)`;
        cursorEl.className = `hand-cursor${pose === 'pinch' ? ' pinch' : pose === 'fist' ? ' fist' : ''}`;
      },
      pinchStart: (x, y) => {
        const hit = input.pickAt(x, y);
        gesturePress = hit?.part ?? null;
        if (hit) soft.press(hit.part, hit.point, hit.normal);
      },
      pinchMove: (x, y) => {
        if (!gesturePress) return;
        const hit = input.pickAt(x, y);
        if (hit?.part === gesturePress) soft.drag(gesturePress, hit.point);
      },
      pinchEnd: (_x, _y, quick) => {
        if (gesturePress) soft.release(gesturePress, 1);
        if (quick) handleTap(gesturePress);
        gesturePress = null;
      },
      status: (t) => { $('gesture-status').textContent = t; },
      lost: () => { cursorEl.hidden = true; },
    });
    await gesture.start();
  } catch (err) {
    console.error(err);
    toast('The camera didn’t start. Allow camera access in Settings and try again.');
    btn.setAttribute('aria-pressed', 'false');
    $('gesture-cam').hidden = true;
    viewer.hold('gesture', false);
  }
});

// ---------- input ----------
function handleTap(p: Part | null) {
  if (mode === 'quiz') { quiz.onTap(p); return; }
  selectPart(p);
}
const input = new Input(viewer, anatomy, soft, {
  onTap: handleTap,
  onDoubleTap: (p) => {
    if (mode === 'explore') selectPart(p);
    viewer.focus(p.centerV, p.radius, undefined);
  },
  onInteract: noteInteraction,
});

// ---------- frame loop ----------
viewer.onFrame = (dt, t) => {
  const a = soft.update(dt);
  const b = anatomy.update(dt, t);
  return a || b;
};
viewer.onQualityDrop = () => toast('Switched to lighter rendering to keep motion smooth.');

// ---------- boot ----------
(async () => {
  viewer.start();
  try {
    await anatomy.load((f, label) => {
      $('loader-bar').style.width = `${Math.round(f * 100)}%`;
      $('loader-text').textContent = label;
    });
  } catch (e) {
    console.error(e);
    $('loader-text').textContent = 'Could not load the 3D model. Check your connection and reload.';
    return;
  }
  quiz = new Quiz(anatomy, viewer, soft);
  quiz.toast = toast;
  const wholeMuscles = new Set(anatomy.parts.filter((p) => p.kind === 'muscle').map((p) => p.parent ?? p.name)).size;
  $('brand-count').textContent = `${wholeMuscles} muscles · full skeleton`;
  anatomy.refresh();
  viewer.invalidate();
  // let the first frames compile shaders behind the loader
  setTimeout(() => $('loader').classList.add('done'), 400);
  const params = new URLSearchParams(location.search);
  if (params.get('mode') === 'quiz') setMode('quiz');
  const sel = params.get('select');
  if (sel) { const p = anatomy.parts.find((q) => q.id === sel || q.name === sel); if (p) selectPart(p, true); }
  (window as any).__anatomy = { anatomy, viewer, soft, input, selectPart, setMode, get quiz() { return quiz; } };
})();
