// Renders public/icon.svg to public/apple-touch-icon.png (180x180) for iOS home screen.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const pub = path.resolve(import.meta.dirname, '../public');
const svg = fs.readFileSync(path.join(pub, 'icon.svg'), 'utf8').replace('rx="14"', 'rx="0"');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 180, height: 180 } });
await page.setContent(`<html><body style="margin:0">${svg.replace('<svg ', '<svg width="180" height="180" ')}</body></html>`);
await page.screenshot({ path: path.join(pub, 'apple-touch-icon.png') });
await browser.close();
console.log('wrote apple-touch-icon.png');
