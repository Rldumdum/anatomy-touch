import * as THREE from 'three';
import type { Anatomy, Part } from './anatomy';
import type { SoftTissue } from './soft';
import type { Viewer } from './viewer';
import { ALIASES, close, fullLabel, norm, pretty } from './names';
import infoData from './data/info.json';

type Info = Record<string, { summary: string; function: string; structure: string; url: string | null }>;
const INFO = infoData as Info;

const SCOPES: { id: string; label: string; regions: string[] | null }[] = [
  { id: 'all', label: 'Body', regions: null },
  { id: 'upper', label: 'Arm', regions: ['Upper limb'] },
  { id: 'lower', label: 'Leg', regions: ['Lower limb'] },
  { id: 'trunk', label: 'Trunk', regions: ['Thorax', 'Abdomen', 'Back', 'Pelvis'] },
  { id: 'head', label: 'Head', regions: ['Head', 'Neck'] },
];

/** The muscles most anatomy courses expect you to know, as whole muscles. */
export const CORE = new Set([
  // upper limb
  'Deltoid muscle', 'Biceps brachii', 'Triceps brachii', 'Brachialis muscle', 'Brachioradialis muscle', 'Coracobrachialis muscle',
  'Supraspinatus muscle', 'Infraspinatus muscle', 'Teres major muscle', 'Teres minor muscle', 'Subscapularis muscle',
  'Flexor carpi radialis', 'Palmaris longus muscle', 'Flexor carpi ulnaris', 'Extensor carpi radialis longus', 'Extensor digitorum',
  'Extensor carpi ulnaris', 'Pronator teres', 'Anconeus muscle',
  // trunk
  'Pectoralis major muscle', 'Pectoralis minor muscle', 'Serratus anterior muscle', 'Rectus abdominis muscle',
  'External abdominal oblique muscle', 'Internal abdominal oblique muscle', 'Transversus abdominis muscle', 'Latissimus dorsi muscle',
  'Trapezius muscle', 'Rhomboid major muscle', 'Rhomboid minor muscle', 'Levator scapulae', 'Diaphragm', 'External intercostal muscles',
  'Quadratus lumborum muscle', 'Longissimus thoracis muscle',
  // head & neck
  'Sternocleidomastoid muscle', 'Temporalis muscle', 'Masseter', 'Frontalis muscle', 'Occipitalis muscle', 'Orbicularis oris muscle',
  'Orbicularis oculi', 'Zygomaticus major muscle', 'Platysma', 'Bucinator', 'Splenius capitis muscle', 'Scalenus anterior muscle',
  'Sternohyoid muscle', 'Digastric muscle',
  // lower limb
  'Gluteus maximus muscle', 'Gluteus medius muscle', 'Gluteus minimus muscle', 'Tensor fasciae latae', 'Sartorius muscle',
  'Rectus femoris muscle', 'Vastus lateralis muscle', 'Vastus medialis muscle', 'Vastus intermedius muscle', 'Adductor longus',
  'Adductor magnus', 'Adductor brevis', 'Gracilis muscle', 'Pectineus muscle', 'Iliacus muscle', 'Psoas major', 'Piriformis muscle',
  'Biceps femoris', 'Semitendinosus muscle', 'Semimembranosus muscle', 'Gastrocnemius', 'Soleus muscle', 'Tibialis anterior muscle',
  'Fibularis longus muscle', 'Fibularis brevis muscle', 'Extensor digitorum longus', 'Tibialis posterior muscle',
]);

interface Item { key: string; region: string; group: string; parent: string | null; parts: Part[] }
interface Progress { status: Record<string, 'correct' | 'missed'>; points: number; best: number }

const STORE_KEY = 'anatomy-touch.quiz.v2';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class Quiz {
  active = false;
  private items = new Map<string, Item>();
  private scope = 'all';
  private set: 'core' | 'all' = 'core';
  private partsMode = false;
  private current: { item: Item; group: Part[]; hints: number; wrong: number; chained: boolean; done: boolean } | null = null;
  private progress: Progress = { status: {}, points: 0, best: 0 };
  private streak = 0;
  toast: (msg: string) => void = () => {};

  constructor(private anatomy: Anatomy, private viewer: Viewer, private soft: SoftTissue) {
    this.buildItems();
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (saved && saved.status) this.progress = saved;
    } catch { /* storage unavailable */ }
    this.bindUi();
  }

  /** Whole-muscle mode groups heads/parts under their parent muscle. */
  private buildItems() {
    this.items.clear();
    for (const p of this.anatomy.parts) {
      if (p.layer !== 'muscle' || p.kind !== 'muscle') continue;
      const key = this.partsMode ? p.name : p.parent ?? p.name;
      let it = this.items.get(key);
      if (!it) {
        it = { key, region: p.region, group: p.group, parent: this.partsMode ? p.parent : null, parts: [] };
        this.items.set(key, it);
      }
      it.parts.push(p);
    }
    if (import.meta.env.DEV) for (const c of CORE) if (![...this.items.values()].some((it) => it.key === c || it.parent === c)) console.warn('core muscle missing:', c);
  }

  private save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.progress)); } catch { /* ignore */ }
  }

  private isCore(it: Item) { return CORE.has(it.key) || (!!it.parent && CORE.has(it.parent)); }
  private inRegion(it: Item) {
    const s = SCOPES.find((x) => x.id === this.scope)!;
    return !s.regions || s.regions.includes(it.region);
  }
  private scoped() { return [...this.items.values()].filter((it) => this.inRegion(it) && (this.set === 'all' || this.isCore(it))); }
  private label(it: Item) { return fullLabel(it.key, it.parent); }

  // ---------- lifecycle ----------
  enter() {
    this.active = true;
    $('quizbar').hidden = false;
    this.paintTints();
    this.renderBar();
    this.toast('Tap any muscle and type its name, or press Next muscle.');
  }

  exit() {
    this.active = false;
    $('quizbar').hidden = true;
    $('quizcard').hidden = true;
    this.current = null;
    this.anatomy.clearTints();
    this.anatomy.clearReveal();
    this.viewer.invalidate();
  }

  private itemFor(part: Part) {
    return this.items.get(this.partsMode ? part.name : part.parent ?? part.name);
  }

  /** Called when the user taps a part in quiz mode. */
  onTap(part: Part | null) {
    if (!part) return;
    if (part.layer !== 'muscle') { this.toast('That’s a bone. The quiz covers muscles.'); return; }
    const item = this.itemFor(part);
    if (!item) { this.toast('That’s a tendon or aponeurosis. Try the fleshy part of a muscle.'); return; }
    this.ask(item, part, false);
  }

  next() {
    const pool = this.scoped().filter((it) => !this.progress.status[it.key] && it !== this.current?.item);
    if (!pool.length) {
      const all = this.scoped();
      const right = all.filter((it) => this.progress.status[it.key] === 'correct').length;
      this.toast(`Set complete: ${right} of ${all.length} named. Long-press the score to start over.`);
      return;
    }
    const item = pool[Math.floor(Math.random() * pool.length)];
    const sides = [...new Set(item.parts.map((p) => p.side))];
    const side = sides[Math.floor(Math.random() * sides.length)];
    const part = item.parts.find((p) => p.side === side)!;
    const group = item.parts.filter((p) => p.side === side);
    if (group.some((p) => !this.anatomy.isVisible(p))) {
      this.anatomy.layerOn.muscle = true;
      this.anatomy.hidden = this.anatomy.hidden.filter((h) => !group.includes(h));
      this.anatomy.isolated = null;
      this.anatomy.refresh();
    }
    this.ask(item, part, true);
    const box = new THREE.Box3();
    for (const p of group) box.union(p.mesh.geometry.boundingBox!);
    const s = box.getBoundingSphere(new THREE.Sphere());
    const eye = this.viewer.focus(s.center, Math.max(s.radius * 1.5, 0.12), viewDirFor(part));
    const peeled = this.anatomy.reveal(group, eye);
    if (peeled) this.toast(`Peeled ${peeled} muscle${peeled > 1 ? 's' : ''} out of the way.`);
  }

  private ask(item: Item, part: Part, chained: boolean) {
    const group = item.parts.filter((p) => p.side === part.side);
    this.current = { item, group, hints: 0, wrong: 0, chained, done: false };
    this.anatomy.select(part, group);
    $('quizcard').hidden = false;
    $('quiz-prompt').textContent = item.parent ? 'Name this head or part' : 'Name this muscle';
    const input = $<HTMLInputElement>('quiz-input');
    input.value = '';
    input.disabled = false;
    $('quiz-feedback').className = 'feedback';
    $('quiz-feedback').textContent = this.progress.status[item.key] === 'correct' ? 'You’ve named this one before.' : '';
    $('quiz-hints').innerHTML = '';
    $('quiz-choices').innerHTML = '';
    this.updateHintButton();
    // keep the iPad keyboard down until they reach for it
    if (!matchMedia('(pointer: coarse)').matches) input.focus();
  }

  // ---------- answering ----------
  private accepted(it: Item) {
    const names = [it.key, ...(ALIASES[it.key] ?? [])];
    // in whole-muscle mode, naming a specific head of it is also right
    if (!this.partsMode) for (const p of it.parts) names.push(p.name, ...(ALIASES[p.name] ?? []));
    return names;
  }

  private submit(raw: string) {
    const c = this.current;
    if (!c || c.done) return;
    const answer = raw.trim();
    if (!answer) return;
    const { item } = c;
    if (this.accepted(item).some((t) => close(answer, t))) return this.correct();
    if (item.parent && [item.parent, ...(ALIASES[item.parent] ?? [])].some((t) => close(answer, t))) {
      this.feedback('close', `Close. It’s part of the ${pretty(item.parent).toLowerCase()} — which part or head?`);
      return;
    }
    const other = [...this.items.values()].find((it) => it !== item && this.accepted(it).some((t) => close(answer, t)));
    c.wrong++;
    this.streak = 0;
    this.feedback('bad', other ? `No, the ${this.label(other).toLowerCase()} is somewhere else.` : c.wrong >= 3 ? 'Not quite. A hint might help.' : 'Not quite. Try again.');
    const input = $('quiz-input');
    input.classList.remove('shake');
    void input.offsetWidth;
    input.classList.add('shake');
    const p = c.group[0];
    this.soft.press(p, p.centerV, new THREE.Vector3(0, 0, 1));
    setTimeout(() => this.soft.release(p, 0.7), 90);
    this.renderBar();
  }

  private answerHtml(it: Item) {
    const name = this.label(it);
    const official = it.parent ? it.key : pretty(it.key) !== name ? it.key : '';
    return `<span class="answer">${name}${official ? `<small>${official}</small>` : ''}</span>`;
  }

  private correct() {
    const c = this.current!;
    c.done = true;
    const pts = Math.max(2, 10 - c.hints * 2 - c.wrong);
    const first = this.progress.status[c.item.key] !== 'correct';
    this.progress.status[c.item.key] = 'correct';
    if (first) this.progress.points += pts;
    this.streak++;
    this.progress.best = Math.max(this.progress.best, this.streak);
    this.save();
    this.feedback('ok', `Correct${first ? `, +${pts}` : ''}${this.answerHtml(c.item)}`);
    $<HTMLInputElement>('quiz-input').disabled = true;
    for (const p of c.group) this.soft.flex(p);
    this.paintTints();
    this.renderBar();
    if (c.chained) setTimeout(() => { if (this.current === c && this.active) this.next(); }, 1700);
  }

  private reveal() {
    const c = this.current;
    if (!c || c.done) return;
    c.done = true;
    if (this.progress.status[c.item.key] !== 'correct') this.progress.status[c.item.key] = 'missed';
    this.streak = 0;
    this.save();
    this.feedback('close', `It’s the${this.answerHtml(c.item)}`);
    $<HTMLInputElement>('quiz-input').disabled = true;
    this.paintTints();
    this.renderBar();
  }

  private feedback(kind: 'ok' | 'bad' | 'close', html: string) {
    const el = $('quiz-feedback');
    el.className = `feedback ${kind}`;
    el.innerHTML = html;
  }

  // ---------- hints ----------
  private infoFor(it: Item) {
    return INFO[it.key] ?? (it.parent ? INFO[it.parent] : undefined) ?? INFO[it.parts[0].name];
  }

  private hint() {
    const c = this.current;
    if (!c || c.done || c.hints >= 4) return;
    c.hints++;
    const { item } = c;
    const box = $('quiz-hints');
    const add = (label: string, html: string) => {
      const d = document.createElement('div');
      d.className = 'hint';
      d.innerHTML = `<b>${label}</b>${html}`;
      box.appendChild(d);
    };
    if (c.hints === 1) {
      add('where', `${item.region}${item.group && item.group !== item.region ? `, ${item.group.toLowerCase()}` : ''}`);
    } else if (c.hints === 2) {
      const info = this.infoFor(item);
      const text = info ? info.function || info.summary : '';
      add('what it does', text ? redact(clip(text, 230), item.key, item.parent) : 'No description for this one. Try the next hint.');
    } else if (c.hints === 3) {
      add('letters', `<span class="pattern">${pattern(this.label(item))}</span>`);
    } else {
      this.choices();
    }
    this.updateHintButton();
  }

  private updateHintButton() {
    const used = this.current?.hints ?? 0;
    const btn = $<HTMLButtonElement>('quiz-hint');
    btn.disabled = used >= 4;
    btn.querySelector('span')!.textContent = used >= 3 ? 'Choices' : `Hint ${used + 1} of 4`;
  }

  private choices() {
    const c = this.current!;
    const pool = [...this.items.values()].filter((it) => it !== c.item && it.region === c.item.region && (this.set === 'all' || this.isCore(it)));
    const opts = [c.item];
    while (opts.length < 4 && pool.length) opts.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    opts.sort(() => Math.random() - 0.5);
    const box = $('quiz-choices');
    box.innerHTML = '';
    for (const o of opts) {
      const b = document.createElement('button');
      b.textContent = this.label(o);
      b.onclick = () => {
        if (c.done) return;
        if (o === c.item) { $<HTMLInputElement>('quiz-input').value = this.label(o); this.correct(); }
        else { b.classList.add('wrong'); b.disabled = true; c.wrong++; this.streak = 0; this.renderBar(); }
      };
      box.appendChild(b);
    }
  }

  // ---------- presentation ----------
  private paintTints() {
    this.anatomy.clearTints();
    if (!this.active) return;
    for (const it of this.items.values()) {
      const st = this.progress.status[it.key];
      if (!st) continue;
      for (const p of it.parts) this.anatomy.setTint(p, st === 'correct' ? 0x6fbf8a : 0xd99a5b, 0.7);
    }
    this.viewer.invalidate();
  }

  private renderBar() {
    const all = this.scoped();
    const named = all.filter((it) => this.progress.status[it.key] === 'correct').length;
    $('quiz-progress').textContent = `${named}/${all.length} named`;
    $('quiz-points').textContent = `${this.progress.points} pts`;
    $('quiz-streak').textContent = this.streak >= 2 ? `${this.streak} in a row` : '';
    for (const b of $('quiz-scope').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.scope === this.scope));
    for (const b of $('quiz-set').querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-pressed', String(b.dataset.set === this.set));
    const inRegion = [...this.items.values()].filter((it) => this.inRegion(it));
    $('n-core').textContent = String(inRegion.filter((it) => this.isCore(it)).length);
    $('n-all').textContent = String(inRegion.length);
    $('quiz-parts').setAttribute('aria-pressed', String(this.partsMode));
  }

  private reset() {
    this.progress = { status: {}, points: 0, best: this.progress.best };
    this.streak = 0;
    this.save();
    this.paintTints();
    this.renderBar();
    this.toast('Quiz progress cleared.');
  }

  private bindUi() {
    const scopeBox = $('quiz-scope');
    for (const s of SCOPES) {
      const b = document.createElement('button');
      b.textContent = s.label;
      b.dataset.scope = s.id;
      b.onclick = () => { this.scope = s.id; this.renderBar(); };
      scopeBox.appendChild(b);
    }
    for (const b of $('quiz-set').querySelectorAll<HTMLButtonElement>('button')) {
      b.onclick = () => { this.set = b.dataset.set as 'core' | 'all'; this.renderBar(); };
    }
    $('quiz-parts').onclick = () => {
      this.partsMode = !this.partsMode;
      this.buildItems();
      if (this.current) { $('quizcard').hidden = true; this.current = null; this.anatomy.select(null); }
      this.paintTints();
      this.renderBar();
      this.toast(this.partsMode ? 'Now naming each head and part separately, e.g. long head of biceps.' : 'Now naming whole muscles, e.g. biceps brachii.');
    };
    $('quiz-next').onclick = () => this.next();
    $('quiz-form').onsubmit = (e) => { e.preventDefault(); this.submit($<HTMLInputElement>('quiz-input').value); };
    $('quiz-hint').onclick = () => this.hint();
    $('quiz-reveal').onclick = () => this.reveal();
    $('quiz-skip').onclick = () => this.next();
    $('quizcard').querySelector('.close')!.addEventListener('click', () => {
      $('quizcard').hidden = true;
      this.current = null;
      this.anatomy.select(null);
    });
    let timer = 0;
    const score = $('quizbar').querySelector('.score') as HTMLElement;
    score.addEventListener('pointerdown', () => { timer = window.setTimeout(() => this.reset(), 900); });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) score.addEventListener(ev, () => clearTimeout(timer));
  }
}

const POSTERIOR = /\bBack\b|posterior|gluteal|gluteus|biceps femoris|semitend|semimemb|gastrocnemius|soleus|plantaris|popliteus|triceps|infraspinatus|teres|rhomboid|trapezius|latissimus|scapular spinal|splenius|occipitalis|piriformis|gemellus|obturator internus|quadratus femoris|anconeus|extensor (carpi|digitorum$|digiti|indicis|pollicis)|abductor pollicis longus|supinator|calcaneal|serratus posterior|iliocostalis|longissimus|spinalis|multifidus|semispinalis|rotatores|interspinales|intertransversarii|capitis/i;
const MEDIAL = /adductor|gracilis|pectineus|sartorius|vastus medialis|flexor carpi|palmaris|pronator|flexor digitorum superficialis|tibialis posterior|flexor digitorum longus|flexor hallucis longus/i;

/** Camera direction that looks at a part from outside the body (front by default). */
export function viewDirFor(p: Part) {
  const c = p.centerV;
  const key = `${p.region} ${p.group} ${p.name}`;
  const lateral = Math.sign(c.x) || 1;
  const out = new THREE.Vector3(lateral * Math.min(Math.abs(c.x) * 3, 0.7), 0.15, 1);
  if (POSTERIOR.test(key) && !/anterior/i.test(p.name)) out.z = -1;
  if (MEDIAL.test(key)) out.x = -lateral * 0.35;
  if (p.region === 'Head' && /lateral|temporal|masseter|pterygoid|bucinator|zygomatic|risorius/i.test(p.name)) out.x = lateral * 1.2;
  return out.normalize();
}

function clip(s: string, n: number) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return cut.slice(0, cut.lastIndexOf(' ')) + '…';
}

function redact(text: string, name: string, parent: string | null) {
  const words = new Set([...norm(name).split(' '), ...(parent ? norm(parent).split(' ') : [])].filter((w) => w.length >= 4 && !['part', 'head', 'belly'].includes(w)));
  let out = text;
  for (const w of words) {
    const stem = w.length > 6 ? w.slice(0, w.length - 2) : w;
    out = out.replace(new RegExp(`\\b${stem}[a-z]*`, 'gi'), '▁▁▁');
  }
  return out;
}

function pattern(label: string) {
  return label
    .replace(/,/g, '')
    .split(' ')
    .map((w) => (w.length <= 2 ? w : w[0].toUpperCase() + '_'.repeat(w.length - 1)))
    .join('&nbsp;&nbsp;');
}
