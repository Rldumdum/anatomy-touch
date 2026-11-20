import * as THREE from 'three';
import type { Anatomy, Part } from './anatomy';
import type { SoftTissue } from './soft';
import type { Viewer } from './viewer';
import { ALIASES, close, norm, pretty } from './names';
import infoData from './data/info.json';

type Info = Record<string, { summary: string; function: string; structure: string; url: string | null }>;
const INFO = infoData as Info;

const SCOPES: { id: string; label: string; regions: string[] | null }[] = [
  { id: 'all', label: 'All', regions: null },
  { id: 'upper', label: 'Arm', regions: ['Upper limb'] },
  { id: 'lower', label: 'Leg', regions: ['Lower limb'] },
  { id: 'trunk', label: 'Trunk', regions: ['Thorax', 'Abdomen', 'Back', 'Pelvis'] },
  { id: 'head', label: 'Head & neck', regions: ['Head', 'Neck'] },
];

export const CORE = new Set([
  // upper limb
  'Clavicular part of deltoid muscle', 'Acromial part of deltoid muscle', 'Scapular spinal part of deltoid muscle',
  'Long head of biceps brachii', 'Short head of biceps brachii', 'Long head of triceps brachii', 'Lateral head of triceps brachii',
  'Medial head of triceps brachii', 'Brachialis muscle', 'Brachioradialis muscle', 'Coracobrachialis muscle', 'Supraspinatus muscle',
  'Infraspinatus muscle', 'Teres major muscle', 'Teres minor muscle', 'Subscapularis muscle', 'Flexor carpi radialis',
  'Palmaris longus muscle', 'Humeral head of flexor carpi ulnaris', 'Extensor carpi radialis longus', 'Extensor digitorum',
  'Humeral head of extensor carpi ulnaris', 'Superficial head of pronator teres', 'Anconeus muscle',
  // trunk
  'Clavicular head of pectoralis major muscle', 'Sternocostal head of pectoralis major muscle', 'Pectoralis minor muscle',
  'Serratus anterior muscle', 'Rectus abdominis muscle', 'External abdominal oblique muscle', 'Internal abdominal oblique muscle',
  'Transversus abdominis muscle', 'Latissimus dorsi muscle', 'Descending part of trapezius muscle', 'Transverse part of trapezius muscle',
  'Ascending part of trapezius muscle', 'Rhomboid major muscle', 'Rhomboid minor muscle', 'Levator scapulae', 'Diaphragm',
  'External intercostal muscles', 'Quadratus lumborum muscle', 'Longissimus thoracis muscle',
  // head & neck
  'Sternocleidomastoid muscle', 'Temporalis muscle', 'Superficial part of masseter', 'Frontalis muscle', 'Occipitalis muscle',
  'Orbicularis oris muscle', 'Orbital part of orbicularis oculi', 'Zygomaticus major muscle', 'Platysma', 'Bucinator',
  'Splenius capitis muscle', 'Scalenus anterior muscle', 'Sternohyoid muscle',
  // lower limb
  'Gluteus maximus muscle', 'Gluteus medius muscle', 'Gluteus minimus muscle', 'Tensor fasciae latae', 'Sartorius muscle',
  'Rectus femoris muscle', 'Vastus lateralis muscle', 'Vastus medialis muscle', 'Vastus intermedius muscle', 'Adductor longus',
  'Adductor magnus', 'Adductor brevis', 'Gracilis muscle', 'Pectineus muscle', 'Iliacus muscle', 'Psoas major', 'Piriformis muscle',
  'Long head of biceps femoris', 'Short head of biceps femoris', 'Semitendinosus muscle', 'Semimembranosus muscle',
  'Medial head of gastrocnemius', 'Lateral head of gastrocnemius', 'Soleus muscle', 'Tibialis anterior muscle',
  'Fibularis longus muscle', 'Fibularis brevis muscle', 'Extensor digitorum longus', 'Tibialis posterior muscle',
]);

interface Item { name: string; region: string; group: string; parent: string | null; parts: Part[] }
interface Progress { status: Record<string, 'correct' | 'missed'>; points: number; best: number }

const STORE_KEY = 'anatomy-touch.quiz.v1';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class Quiz {
  active = false;
  private items = new Map<string, Item>();
  private scope = 'all';
  private coreOnly = true;
  private current: { item: Item; part: Part; hints: number; wrong: number; chained: boolean; done: boolean } | null = null;
  private progress: Progress = { status: {}, points: 0, best: 0 };
  private streak = 0;
  toast: (msg: string) => void = () => {};

  constructor(private anatomy: Anatomy, private viewer: Viewer, private soft: SoftTissue) {
    for (const p of anatomy.parts) {
      if (p.layer !== 'muscle' || p.kind !== 'muscle') continue;
      let it = this.items.get(p.name);
      if (!it) { it = { name: p.name, region: p.region, group: p.group, parent: p.parent, parts: [] }; this.items.set(p.name, it); }
      it.parts.push(p);
    }
    if (import.meta.env.DEV) for (const c of CORE) if (!this.items.has(c)) console.warn('core muscle missing from data:', c);
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (saved && saved.status) this.progress = saved;
    } catch { /* storage unavailable */ }
    this.bindUi();
  }

  private save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.progress)); } catch { /* ignore */ }
  }

  private inScope(it: Item) {
    const s = SCOPES.find((x) => x.id === this.scope)!;
    return (!s.regions || s.regions.includes(it.region)) && (!this.coreOnly || CORE.has(it.name));
  }
  private scoped() { return [...this.items.values()].filter((it) => this.inScope(it)); }

  // ---------- lifecycle ----------
  enter() {
    this.active = true;
    $('quizbar').hidden = false;
    this.paintTints();
    this.renderBar();
    this.toast('Tap any muscle and name it — or press “Next muscle”.');
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

  /** Called when the user taps a part in quiz mode. */
  onTap(part: Part | null) {
    if (!part) return;
    if (part.layer !== 'muscle') { this.toast('That’s a bone — the quiz is about muscles.'); return; }
    const item = this.items.get(part.name);
    if (!item) { this.toast('That’s a tendon or sheet — try a muscle belly.'); return; }
    this.ask(item, part, false);
  }

  next() {
    const pool = this.scoped().filter((it) => !this.progress.status[it.name] && it !== this.current?.item);
    if (!pool.length) {
      const all = this.scoped();
      const right = all.filter((it) => this.progress.status[it.name] === 'correct').length;
      this.toast(`Scope complete: ${right}/${all.length} correct. Reset by long-pressing the score.`);
      return;
    }
    const item = pool[Math.floor(Math.random() * pool.length)];
    const visible = item.parts.filter((p) => this.anatomy.isVisible(p));
    const part = (visible.length ? visible : item.parts)[Math.floor(Math.random() * (visible.length || item.parts.length))];
    if (!this.anatomy.isVisible(part)) {
      this.anatomy.layerOn.muscle = true;
      this.anatomy.hidden = this.anatomy.hidden.filter((h) => h !== part);
      this.anatomy.isolated = null;
      this.anatomy.refresh();
    }
    this.ask(item, part, true);
    const eye = this.viewer.focus(part.centerV, Math.max(part.radius * 1.6, 0.12), viewDirFor(part));
    const peeled = this.anatomy.reveal(part, eye);
    if (peeled) this.toast(`Peeled ${peeled} muscle${peeled > 1 ? 's' : ''} away so you can see it.`);
  }

  private ask(item: Item, part: Part, chained: boolean) {
    this.current = { item, part, hints: 0, wrong: 0, chained, done: false };
    this.anatomy.select(part);
    const card = $('quizcard');
    card.hidden = false;
    const input = $<HTMLInputElement>('quiz-input');
    input.value = '';
    input.disabled = false;
    $('quiz-feedback').className = 'feedback';
    $('quiz-feedback').innerHTML = this.progress.status[item.name] === 'correct' ? 'You’ve named this one before — again?' : '';
    $('quiz-hints').innerHTML = '';
    $('quiz-choices').innerHTML = '';
    this.updateHintButton();
    // don't pop the iPad keyboard over the model unless they reach for it
    if (!matchMedia('(pointer: coarse)').matches) input.focus();
  }

  // ---------- answering ----------
  private submit(raw: string) {
    const c = this.current;
    if (!c || c.done) return;
    const answer = raw.trim();
    if (!answer) return;
    const { item } = c;
    const targets = [item.name, ...(ALIASES[item.name] ?? [])];
    if (targets.some((t) => close(answer, t))) return this.correct();
    if (item.parent && close(answer, item.parent)) {
      this.feedback('close', `Close — that’s part of the <b>${pretty(item.parent)}</b>. Which part or head?`);
      return;
    }
    // named a different muscle?
    const other = [...this.items.values()].find((it) => it !== item && [it.name, ...(ALIASES[it.name] ?? [])].some((t) => close(answer, t)));
    c.wrong++;
    this.streak = 0;
    this.feedback('bad', other ? `No — the ${pretty(other.name)} is elsewhere.` : c.wrong >= 3 ? 'Not quite. Try a hint or reveal.' : 'Not quite — try again.');
    const input = $('quiz-input');
    input.classList.remove('shake');
    void input.offsetWidth;
    input.classList.add('shake');
    this.soft.press(c.part, c.part.centerV, new THREE.Vector3(0, 0, 1));
    setTimeout(() => this.soft.release(c.part, 0.7), 90);
    this.renderBar();
  }

  private correct() {
    const c = this.current!;
    c.done = true;
    const pts = Math.max(2, 10 - c.hints * 2 - c.wrong);
    const first = this.progress.status[c.item.name] !== 'correct';
    this.progress.status[c.item.name] = 'correct';
    if (first) this.progress.points += pts;
    this.streak++;
    this.progress.best = Math.max(this.progress.best, this.streak);
    this.save();
    this.feedback('ok', `Correct${first ? ` · +${pts}` : ''}<span class="answer">${c.item.name}</span>`);
    $<HTMLInputElement>('quiz-input').disabled = true;
    this.soft.flex(c.part);
    this.paintTints();
    this.renderBar();
    if (c.chained) setTimeout(() => { if (this.current === c && this.active) this.next(); }, 1600);
  }

  private reveal() {
    const c = this.current;
    if (!c || c.done) return;
    c.done = true;
    if (this.progress.status[c.item.name] !== 'correct') this.progress.status[c.item.name] = 'missed';
    this.streak = 0;
    this.save();
    this.feedback('close', `It’s the<span class="answer">${c.item.name}</span>`);
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
      add('Where', `${item.region}${item.group && item.group !== item.region ? ` · ${item.group}` : ''}`);
    } else if (c.hints === 2) {
      const info = INFO[item.name] ?? (item.parent ? INFO[item.parent] : undefined);
      const text = info ? info.function || info.summary : '';
      add('What it does', text ? redact(clip(text, 230), item.name, item.parent) : 'No description available — try the next hint.');
    } else if (c.hints === 3) {
      add('Letters', `<span class="pattern">${pattern(item.name)}</span>`);
    } else {
      this.choices();
    }
    this.updateHintButton();
  }

  private updateHintButton() {
    const used = this.current?.hints ?? 0;
    const btn = $<HTMLButtonElement>('quiz-hint');
    btn.disabled = used >= 4;
    btn.querySelector('span')!.textContent = used >= 3 ? 'Show choices' : `Hint ${used + 1}/4`;
  }

  private choices() {
    const c = this.current!;
    const pool = [...this.items.values()].filter((it) => it !== c.item && it.region === c.item.region && (CORE.has(it.name) || !this.coreOnly));
    const opts = [c.item];
    while (opts.length < 4 && pool.length) opts.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    opts.sort(() => Math.random() - 0.5);
    const box = $('quiz-choices');
    box.innerHTML = '';
    for (const o of opts) {
      const b = document.createElement('button');
      b.textContent = pretty(o.name);
      b.onclick = () => {
        if (c.done) return;
        if (o === c.item) { $<HTMLInputElement>('quiz-input').value = o.name; this.correct(); }
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
      const st = this.progress.status[it.name];
      if (!st) continue;
      for (const p of it.parts) this.anatomy.setTint(p, st === 'correct' ? 0x3ddc97 : 0xffa04a, 0.75);
    }
    this.viewer.invalidate();
  }

  private renderBar() {
    const all = this.scoped();
    const named = all.filter((it) => this.progress.status[it.name] === 'correct').length;
    $('quiz-progress').textContent = `${named} / ${all.length} named`;
    $('quiz-points').textContent = `${this.progress.points} pts`;
    $('quiz-streak').textContent = this.streak >= 2 ? `🔥 ${this.streak}` : '';
    for (const b of $('quiz-scope').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.scope === this.scope));
  }

  private reset() {
    this.progress = { status: {}, points: 0, best: this.progress.best };
    this.streak = 0;
    this.save();
    this.paintTints();
    this.renderBar();
    this.toast('Quiz progress reset.');
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
    $<HTMLInputElement>('quiz-core').onchange = (e) => { this.coreOnly = (e.target as HTMLInputElement).checked; this.renderBar(); };
    $('quiz-next').onclick = () => this.next();
    $('quiz-form').onsubmit = (e) => { e.preventDefault(); this.submit($<HTMLInputElement>('quiz-input').value); };
    $('quiz-hint').onclick = () => this.hint();
    $('quiz-reveal').onclick = () => this.reveal();
    $('quiz-skip').onclick = () => this.next();
    $('quizcard').querySelector('.card-close')!.addEventListener('click', () => {
      $('quizcard').hidden = true;
      this.current = null;
      this.anatomy.select(null);
    });
    // long-press the score to reset
    let timer = 0;
    const score = $('quizbar').querySelector('.score') as HTMLElement;
    score.addEventListener('pointerdown', () => { timer = window.setTimeout(() => this.reset(), 900); });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) score.addEventListener(ev, () => clearTimeout(timer));
  }
}

/** Camera direction that looks at a part from outside the body. */
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
    out = out.replace(new RegExp(`\\b${stem}[a-z]*`, 'gi'), '▢▢▢');
  }
  return out;
}

function pattern(name: string) {
  return name
    .replace(/ muscle$/, '')
    .split(' ')
    .map((w) => (w.length <= 2 ? w : w[0].toUpperCase() + '_'.repeat(w.length - 1)))
    .join('&nbsp;&nbsp;');
}
