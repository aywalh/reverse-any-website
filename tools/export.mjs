// Export of a single extraction — everything parity can hand out of a result
// without another project.
//
// Usage: node tools/export.mjs <extraction-dir> [--video] [--single] [--zip] [--all]
//   --video    recording of the preview as .webm
//   --single   a standalone HTML file, everything inline, runs on double-click
//   --zip      the whole directory as an archive
//   --all      all three (default when nothing is given)
//
// Deliberately generic formats. Selective extraction is complete within parity
// and depends on no other project — whoever wants to take a result elsewhere
// takes the ZIP, the JSON, the single file or the component files.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync, copyFileSync } from 'node:fs';
import { join, relative, sep, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';
import { zip } from './zip.mjs';
import { emit } from './_emit.mjs';

const argv = process.argv.slice(2);
const DIR = argv[0];
if (!DIR) {
  console.error('usage: node tools/export.mjs <extraction-dir> [--video] [--single] [--zip] [--all]');
  process.exit(2);
}
const picked = ['video', 'single', 'zip'].filter(f => argv.includes('--' + f));
const WANT = new Set(argv.includes('--all') || !picked.length ? ['video', 'single', 'zip'] : picked);

const metaPath = join(DIR, 'metadata.json');
if (!existsSync(metaPath)) { console.error(`✗ ${metaPath} not found`); process.exit(1); }
const m = JSON.parse(readFileSync(metaPath, 'utf8'));
const SLUG = m.slug || basename(DIR);

// Which version is shown: the independent rebuild if there is one. Otherwise the
// isolated one — then the video shows original code, and it says so.
const useRebuilt = !!m.code?.rebuilt && existsSync(join(DIR, 'rebuilt/index.html'));
const previewDir = useRebuilt ? 'rebuilt' : 'vanilla';
const previewPage = join(DIR, previewDir, 'index.html');

// For a WebGL or canvas scene the isolated version is an empty rectangle: the
// content comes from JS that does not run here. A video of it shows nothing.
// So the original page is recorded instead, aligned to the target — it stays
// documentable that way, which is exactly the point of "reference only".
const recordSource = !useRebuilt && m.isolatability === 'reference-only';

const done = {};

// ── Video ───────────────────────────────────────────────────────────────────
// Playwright records by itself; an extra tool would be a dependency for
// something already in the house.
if (WANT.has('video') && (recordSource || existsSync(previewPage))) {
  const { chromium } = await import('playwright');
  const tmp = join(tmpdir(), 'parity-video-' + Date.now());
  const browser = await chromium.launch(recordSource
    ? { args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] }
    : {});
  let ctx;
  const trigger = (m.triggers || ['load'])[0];
  try {
    const size = recordSource ? { width: 1280, height: 720 } : { width: 900, height: 600 };
    ctx = await browser.newContext({ viewport: size, recordVideo: { dir: tmp, size } });
    const page = await ctx.newPage();

    if (recordSource) {
      // The original page, aligned to the target. A WebGL scene takes much
      // longer to settle — models, textures, decoders.
      await page.goto(m.source, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(9000);
      await page.locator(m.selector).first().scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1500);
    } else {
      await page.goto(pathToFileURL(resolvePath(previewPage)).href, { waitUntil: 'load', timeout: 20000 });
      await page.waitForTimeout(1200);
    }

    const dur = Math.min(2500, (m.timing?.durationMs ?? 600) + 600);
    const target = recordSource ? m.selector : useRebuilt ? '.' + (m.rebuild?.root || SLUG) : '#parity-stage';

    // Three times, so the motion reads as motion in the video and not as a
    // single twitch at the start.
    const rounds = recordSource ? 3 : 3;
    for (let i = 0; i < rounds; i++) {
      if (recordSource) {
        // The real page has no remote control — the trigger has to be fired
        // with mouse and keyboard as if by hand.
        const box = await page.locator(target).first().boundingBox().catch(() => null);
        const cx = box ? box.x + box.width / 2 : size.width / 2;
        const cy = box ? box.y + box.height / 2 : size.height / 2;
        if (trigger === 'drag' || trigger === 'pointer') {
          await page.mouse.move(cx, cy + 140);
          await page.mouse.down();
          await page.mouse.move(cx + (i - 1) * 60, cy - 180, { steps: 18 });
          await page.mouse.up();
        } else if (trigger === 'hover') {
          await page.mouse.move(2, 2); await page.waitForTimeout(300);
          await page.mouse.move(cx, cy, { steps: 12 });
        } else if (trigger === 'click') {
          await page.mouse.click(cx, cy).catch(() => {});
        } else if (trigger === 'scroll') {
          await page.mouse.wheel(0, 400); await page.waitForTimeout(600); await page.mouse.wheel(0, -400);
        }
        await page.waitForTimeout(2200);
      } else if (trigger === 'hover') {
        // Real mouse pointer: CSS :hover does not react to a synthetic event.
        await page.mouse.move(2, 2);
        await page.waitForTimeout(400);
        await page.locator(target).first().hover({ timeout: 4000, force: true }).catch(() => {});
        await page.waitForTimeout(dur);
      } else {
        await page.evaluate(() => window.parityPreview?.reset?.()).catch(() => {});
        await page.waitForTimeout(300);
        await page.evaluate(() => window.parityPreview?.fire?.()).catch(() => {});
        await page.waitForTimeout(dur);
      }
      if (m.timing?.loops && !recordSource) break;   // a loop repeats itself
    }
    await page.waitForTimeout(500);
    await ctx.close();
    ctx = null;

    const src = await page.video()?.path();
    if (src && existsSync(src)) {
      copyFileSync(src, join(DIR, 'preview.webm'));
      done.video = 'preview.webm';
      m.previews = { ...m.previews, video: 'preview.webm', videoShows: recordSource ? 'original' : previewDir };
      emit({ ev: 'shot', cmd: 'export', mark: 'preview-video', path: join(DIR, 'preview.webm') });
    }
  } catch (e) {
    console.error('  Video failed: ' + String(e).slice(0, 140));
  } finally {
    await ctx?.close().catch(() => {});
    await browser.close().catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── Standalone single file ──────────────────────────────────────────────────
// Inline the CSS and JS so the file runs on its own. That is exactly why people
// want a single file: attach it, pass it on, double-click it.
if (WANT.has('single') && existsSync(previewPage)) {
  let html = readFileSync(previewPage, 'utf8');
  const inline = (file, open, close) => {
    const p = join(DIR, previewDir, file);
    if (!existsSync(p)) return '';
    return open + '\n' + readFileSync(p, 'utf8') + '\n' + close;
  };
  html = html
    .replace(/<link rel="stylesheet" href="style\.css">/, inline('style.css', '<style>', '</style>'))
    .replace(/<script src="script\.js"><\/script>/, inline('script.js', '<script>', '<\/script>'));

  const banner = `<!--
  ${m.title} — measured by parity from ${m.source}.
  ${useRebuilt
    ? 'Independent rebuild: written from the measurement, without the source page\'s CSS.'
    : 'WARNING: isolated version with the source page\'s ORIGINAL code. Analysis result,\n  not a component of yours — do not publish.'}
  Trigger ${(m.triggers || [])[0]} · ${m.timing?.durationMs ?? '—'}ms · ${(m.easing || [])[0] ?? '—'}
-->
`;
  const out = `${SLUG}.component.html`;
  writeFileSync(join(DIR, out), banner + html, 'utf8');
  done.single = out;
  m.code = { ...m.code, single: out, singleShows: previewDir };
}

// ── ZIP ─────────────────────────────────────────────────────────────────────
if (WANT.has('zip')) {
  const zipName = `${SLUG}.zip`;
  const walk = (d, base = '') => {
    const out = [];
    for (const e of readdirSync(d)) {
      // An archive containing itself would be half in or not in at all,
      // depending on order — and in no case what anyone expects.
      if (e === zipName) continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) out.push(...walk(p, base + e + '/'));
      else out.push({ name: base + e, data: readFileSync(p) });
    }
    return out;
  };
  // metadata.json is written last, so put the current state in here already
  // rather than the state from before the video.
  const files = walk(DIR).filter(f => f.name !== 'metadata.json');
  files.unshift({ name: 'metadata.json', data: JSON.stringify(m, null, 2) });
  files.push({ name: 'LIESMICH.txt', data:
`${m.title}
Measured by parity from ${m.source}
Selector: ${m.selector}
Trigger:  ${(m.triggers || []).join(', ')}
Duration: ${m.timing?.durationMs ?? '—'}ms (${m.timing?.durationSource ?? '—'})
Grade:    ${m.isolatability} (confidence ${m.confidence})

What is in here
---------------
metadata.json   the complete measurement
report.md       the readable report
vanilla/        ISOLATED: the source page's original markup and original CSS.
                Analysis result. Do not publish.
${m.code?.rebuilt ? `rebuilt/        REBUILD: written from the measurement, does not know
                the original CSS. Independent.
react/          the same rebuild as a React component
svelte/         the same rebuild as a Svelte component
` : `NOT-REBUILT.md  why no rebuild was produced for this target
`}preview-*.png   captures for comparison
${done.video ? 'preview.webm    recording of the preview\n' : ''}${done.single ? done.single + '   everything in one file, runs on double-click\n' : ''}
Third-party assets and fonts are NOT included, only linked.
Check licences before any reuse.
` });

  writeFileSync(join(DIR, zipName), zip(files));
  done.zip = zipName;
  m.code = { ...m.code, zip: zipName };
}

writeFileSync(metaPath, JSON.stringify(m, null, 2), 'utf8');

emit({ ev: 'done', cmd: 'export', out: DIR, ...done, shows: previewDir, exit: 0 });
console.log(`✓ ${DIR}`);
for (const [k, v] of Object.entries(done)) console.log(`  ${k.padEnd(7)} ${v}`);
if (!Object.keys(done).length) console.log('  nothing produced — is the preview missing?');
else if (recordSource) console.log('  Note: video of the ORIGINAL PAGE — the isolated version would be an empty canvas.');
 else if (!useRebuilt) console.log('  Note: shows the ISOLATED version (original code) — there is no rebuild.');
