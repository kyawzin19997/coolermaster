// Renders the macOS .dmg window background (app/src-tauri/dmg/background.html) to background.png:
// 1440x1220 pixels marked 144 dpi, so Finder shows it 720x610 and sharp on Retina screens.
// Headless, no window, no focus taken. Needs app/node_modules (the fonts) and a Playwright Chromium.
//
//   node scripts/ui/dmg-background.mjs
import { chromium } from 'playwright-core';
import { crc32 } from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = path.join(root, 'app', 'src-tauri', 'dmg');
const out = path.join(dir, 'background.png');

function findChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  for (const d of fs.existsSync(cache) ? fs.readdirSync(cache).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse() : []) {
    const mac = fs.readdirSync(path.join(cache, d)).find((x) => x.startsWith('chrome-mac'));
    if (!mac) continue;
    const app = fs.readdirSync(path.join(cache, d, mac)).find((x) => x.endsWith('.app'));
    if (app) {
      const bin = path.join(cache, d, mac, app, 'Contents', 'MacOS');
      return path.join(bin, fs.readdirSync(bin)[0]);
    }
  }
  return undefined;
}

const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await browser.newPage({ viewport: { width: 720, height: 610 }, deviceScaleFactor: 2 });
await page.goto(pathToFileURL(path.join(dir, 'background.html')).href);
await page.evaluate(() => document.fonts.ready);
const png = await page.screenshot();
await browser.close();
// Record pixels per meter immediately after IHDR so Finder displays the Retina asset at 720×610.
const physicalSize = Buffer.alloc(21);
physicalSize.writeUInt32BE(9);
physicalSize.write('pHYs', 4);
physicalSize.writeUInt32BE(5669, 8);
physicalSize.writeUInt32BE(5669, 12);
physicalSize[16] = 1;
physicalSize.writeUInt32BE(crc32(physicalSize.subarray(4, 17)), 17);
const chunks = [png.subarray(0, 33), physicalSize];
for (let offset = 33; offset < png.length;) {
  const next = offset + 12 + png.readUInt32BE(offset);
  if (png.toString('ascii', offset + 4, offset + 8) !== 'pHYs') chunks.push(png.subarray(offset, next));
  offset = next;
}
fs.writeFileSync(out, Buffer.concat(chunks));
console.log(`wrote ${out}`);
