// Playwright visual check on an iPad-sized touch viewport.
//   node scripts/shots.mjs [baseUrl] [only]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:5260';
const ONLY = process.argv[3] || '';
const OUT = path.resolve(import.meta.dirname, '../shots');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, hasTouch: true, isMobile: false });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const t0 = Date.now();
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.getElementById('loader')?.classList.contains('done'), null, { timeout: 120000 });
console.log('loaded in', ((Date.now() - t0) / 1000).toFixed(1), 's');
await page.waitForTimeout(1500);

const shot = async (name) => {
  if (ONLY && !name.includes(ONLY)) return;
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log('shot', name);
};
const api = (fn, arg) => page.evaluate(fn, arg);

await shot('01-home');

// Zoomed muscle detail
await api(() => { const { anatomy, viewer } = window.__anatomy; const p = anatomy.parts.find((q) => q.name === 'Long head of biceps brachii' && q.side === 'right'); viewer.focus(p.centerV, p.radius * 1.1); });
await page.waitForTimeout(1800);
await shot('02-arm-closeup');

// Press and hold on the screen centre -> visible dent
await page.evaluate(() => {
  const { input, soft } = window.__anatomy;
  const hit = input.pickAt(innerWidth / 2, innerHeight / 2);
  window.__held = hit;
  if (hit) soft.press(hit.part, hit.point, hit.normal);
});
await page.waitForTimeout(500);
await shot('03-press-dent');
await page.evaluate(() => { const h = window.__held; if (h) window.__anatomy.soft.release(h.part, 1); });
await page.waitForTimeout(90);
await shot('03b-release-jiggle');
await page.touchscreen.tap(590, 410);
await page.waitForTimeout(800);
await shot('04-selected-card');

// Back view
await api(() => { const { viewer } = window.__anatomy; viewer.home(); });
await page.waitForTimeout(400);
await api(() => { const { viewer } = window.__anatomy; viewer.orbitBy(Math.PI, 0); });
await page.waitForTimeout(1200);
await shot('05-back');

// Bones only
await page.click('#tg-muscles');
await api(() => window.__anatomy.viewer.home());
await page.waitForTimeout(1800);
await shot('06-bones');
await page.click('#tg-muscles');

// X-ray
await page.click('#tg-xray');
await page.waitForTimeout(600);
await shot('07-xray');
await page.click('#tg-xray');

// Selected muscle with attachments
await api(() => { const { anatomy, selectPart } = window.__anatomy; const p = anatomy.parts.find((q) => q.name === 'Tibialis anterior muscle' && q.side === 'right'); selectPart(p, true); });
await page.waitForTimeout(2500);
await shot('08-attachments');

// Contract animation at peak, compared with relaxed
await api(() => { const { anatomy, selectPart } = window.__anatomy; const p = anatomy.parts.find((q) => q.name === 'Long head of biceps brachii' && q.side === 'right'); selectPart(p, true); });
await page.waitForTimeout(2200);
await shot('09a-relaxed');
await page.click('[data-act="flex"]');
await page.waitForTimeout(250);
await shot('09b-contract');

// Quiz
await page.click('[data-mode="quiz"]');
await page.waitForTimeout(400);
await page.click('#quiz-next');
await page.waitForTimeout(2200);
await shot('10-quiz');
await page.click('#quiz-hint');
await page.click('#quiz-hint');
await page.click('#quiz-hint');
await shot('11-quiz-hints');
const answer = await api(() => window.__anatomy.quiz['current'].item.name);
await page.fill('#quiz-input', answer.toLowerCase().replace(' muscle', ''));
await page.click('#quiz-form button[type=submit]');
await page.waitForTimeout(300);
await shot('12-quiz-correct');

// Portrait
await page.setViewportSize({ width: 820, height: 1180 });
await page.click('[data-mode="explore"]');
await api(() => { const { anatomy, selectPart, viewer } = window.__anatomy; viewer.home(); const p = anatomy.parts.find((q) => q.name === 'Rectus abdominis muscle'); selectPart(p, false); });
await page.waitForTimeout(1800);
await shot('13-portrait');

// Browser
await page.click('#btn-search');
await page.fill('#browser-q', 'glut');
await shot('14-browser');

console.log('errors:', errors.length ? '\n' + [...new Set(errors)].slice(0, 20).join('\n') : 'none');
await browser.close();
