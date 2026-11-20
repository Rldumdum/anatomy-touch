// Verifies the press dent: compares pixels around the contact point before / during a press.
import { chromium } from 'playwright';
const BASE = process.argv[2] || 'http://localhost:5260';
const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await (await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true })).newPage();
await page.goto(BASE);
await page.waitForFunction(() => document.getElementById('loader')?.classList.contains('done'), null, { timeout: 120000 });
await page.evaluate(() => { const { anatomy, viewer } = window.__anatomy; const p = anatomy.parts.find((q) => q.name === 'Sternocostal head of pectoralis major muscle' && q.side === 'right'); viewer.focus(p.centerV, p.radius * 0.8, new (p.centerV.constructor)(0, 0, 1)); });
await page.waitForTimeout(2500);
const clip = { x: 490, y: 310, width: 200, height: 200 };
const before = await page.screenshot({ clip, path: 'shots/dent-before.png' });
const info = await page.evaluate(() => {
  const { input, soft } = window.__anatomy;
  const hit = input.pickAt(590, 410);
  window.__h = hit;
  if (!hit) return 'no hit';
  soft.press(hit.part, hit.point, hit.normal);
  return `${hit.part.name} sigma=${hit.part.uniforms.uSigma.value.toFixed(3)}`;
});
await page.waitForTimeout(600);
const dentVal = await page.evaluate(() => window.__h?.part.uniforms.uDent.value);
const during = await page.screenshot({ clip, path: 'shots/dent-during.png' });
let diff = 0;
for (let i = 0; i < Math.min(before.length, during.length); i++) if (before[i] !== during[i]) diff++;
console.log(info, 'uDent=', dentVal, 'bytes differing=', diff);
await browser.close();
