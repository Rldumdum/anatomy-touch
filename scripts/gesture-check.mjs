// Smoke test: gesture mode starts with a fake camera and the MediaPipe hand model loads.
import { chromium } from 'playwright';
const BASE = process.argv[2] || 'http://localhost:5260';
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-angle=d3d11', '--enable-gpu'] });
const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, permissions: ['camera'] });
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
await page.goto(BASE);
await page.waitForFunction(() => document.getElementById('loader')?.classList.contains('done'), null, { timeout: 120000 });
await page.click('#btn-gesture');
const status = await page.waitForFunction(
  () => { const t = document.getElementById('gesture-status')?.textContent || ''; return /Show your hand|Hand detected|Rotating|Pinch|Aiming|Zooming/.test(t) ? t : false; },
  null,
  { timeout: 60000 },
).then((h) => h.jsonValue()).catch(() => 'TIMEOUT: ' + logs.join(' | '));
console.log('gesture status:', status);
await page.screenshot({ path: 'shots/15-gesture.png' });
await browser.close();
