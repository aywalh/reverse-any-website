// Self-test for tools/extract.mjs against tests/fixture/index.html.
// The fixture holds three cases that must behave differently:
//   #card   hover transition           420ms, two properties
//   #pulse  infinite CSS keyframes     900ms, loops, NOT the measurement window width
//   #reveal scroll reveal via IO       600ms, only measurable after a real reload
//
// All three have been measured wrongly before. That is why they are here.
//
// Run: node tests/extract.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// The port can be overridden: if something already runs on it, the test would
// otherwise measure the foreign page and report a selector error that is none.
const PORT = Number(process.env.PARITY_TEST_PORT ?? 4191);
const OUT = join(ROOT, 'tests/.out');

const run = (script, args) => new Promise((res, rej) => {
  const c = spawn(process.execPath, [join(ROOT, script), ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  c.stdout.on('data', d => { out += d; });
  c.stderr.on('data', d => { err += d; });
  c.on('exit', code => code === 0 ? res(out) : rej(new Error(`${script} exit ${code}\n${err}${out}`)));
});

const server = spawn(process.execPath, [join(ROOT, 'tools/serve.mjs'), join(ROOT, 'tests/fixture'), String(PORT)],
  { cwd: ROOT, stdio: 'ignore' });
const stop = () => { server.kill(); };
process.on('exit', stop);

const meta = slug => JSON.parse(readFileSync(join(OUT, slug, 'metadata.json'), 'utf8'));
const url = `http://localhost:${PORT}/`;
let failed = 0;
const check = (name, fn) => { try { fn(); console.log('  ✓ ' + name); } catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); } };

try {
  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
  await new Promise(r => setTimeout(r, 800));

  // ── Hover transition ──────────────────────────────────────────────────────
  await run('tools/extract.mjs', [url, '--selector', '#card', '--out', join(OUT, 'card'), '--repeat', '2']);
  const card = meta('card');
  console.log('\n#card — hover transition');
  check('trigger detected automatically as hover', () => assert.equal(card.triggers[0], 'hover'));
  check('transform and opacity detected as moving', () => {
    assert.ok(card.properties.includes('transform'), 'transform missing in ' + JSON.stringify(card.properties));
    assert.ok(card.properties.includes('opacity'), 'opacity missing');
  });
  check('duration close to the declared 420ms', () => {
    assert.ok(card.timing.durationMs > 300 && card.timing.durationMs < 600, 'was ' + card.timing.durationMs);
  });
  check('graded isolatable', () => assert.equal(card.isolatability, 'isolatable'));
  // The fixture has NO prefers-reduced-motion rule. Checking that via running
  // animations at rest wrongly yields "respected" here — on a hover effect
  // nothing ever runs at rest.
  check('reduced motion correctly detected as ignored', () => {
    assert.equal(card.reducedMotion.probed, true);
    assert.equal(card.reducedMotion.respected, false, 'fixture has no reduced-motion rule');
  });
  check('isolated version written', () => {
    assert.ok(existsSync(join(OUT, 'card/vanilla/index.html')));
    assert.match(readFileSync(join(OUT, 'card/vanilla/style.css'), 'utf8'), /:hover/);
  });

  // ── Infinite keyframes ────────────────────────────────────────────────────
  await run('tools/extract.mjs', [url, '--selector', '#pulse', '--out', join(OUT, 'pulse'), '--repeat', '2']);
  const pulse = meta('pulse');
  console.log('\n#pulse — infinite CSS keyframes');
  check('detected as loop', () => assert.equal(pulse.triggers[0], 'loop'));
  check('duration 900ms from the engine, not from sampling', () => {
    assert.equal(pulse.timing.durationMs, 900, 'was ' + pulse.timing.durationMs);
    assert.equal(pulse.timing.durationSource, 'engine');
  });
  check('infinite loop flagged', () => assert.equal(pulse.timing.loops, true));
  check('sampled value reported separately', () => {
    assert.ok(pulse.timing.sampledDurationMs > 1500, 'sampling should report the window width');
  });
  check('keyframes in the isolated CSS', () => {
    assert.match(readFileSync(join(OUT, 'pulse/vanilla/style.css'), 'utf8'), /@(-\w+-)?keyframes\s+pulse/);
  });

  // ── Scroll reveal ─────────────────────────────────────────────────────────
  await run('tools/extract.mjs', [url, '--selector', '#reveal', '--out', join(OUT, 'reveal'), '--repeat', '2']);
  const rev = meta('reveal');
  console.log('\n#reveal — scroll reveal via IntersectionObserver');
  check('detected as scroll', () => assert.equal(rev.triggers[0], 'scroll'));
  check('motion measured at all', () => {
    assert.ok(rev.properties.length > 0, 'nothing measured — does the reveal fire before the measurement?');
  });
  check('duration close to the declared 600ms', () => {
    assert.ok(rev.timing.durationMs > 400 && rev.timing.durationMs < 900, 'was ' + rev.timing.durationMs);
  });
  check('IntersectionObserver captured with threshold', () => {
    assert.equal(rev.dependencies.intersectionObservers[0].threshold, 0.25);
  });
  check('only partially isolatable because of the scroll dependency', () => assert.equal(rev.isolatability, 'partial'));

  // ── Rebuild ───────────────────────────────────────────────────────────────
  // Every check here covers a mistake the generator has already made.
  // A rebuild that is wrong is worse than none.
  for (const slug of ['card', 'pulse', 'reveal']) await run('tools/rebuild.mjs', [join(OUT, slug)]);
  const cardCss = readFileSync(join(OUT, 'card/rebuilt/style.css'), 'utf8');
  const pulseCss = readFileSync(join(OUT, 'pulse/rebuilt/style.css'), 'utf8');
  const revCss = readFileSync(join(OUT, 'reveal/rebuilt/style.css'), 'utf8');
  const revJs = readFileSync(join(OUT, 'reveal/rebuilt/script.js'), 'utf8');

  console.log('\nRebuild');
  check('every property gets its own timing', () => {
    // "transition: transform, opacity 420ms ease" is valid syntax and still
    // wrong — transform would then run with 0s.
    const t = /transition:([\s\S]*?);/.exec(cardCss);
    assert.ok(t, 'no transition produced');
    // Split at the top level: the commas in cubic-bezier(.22, 1, .36, 1)
    // belong to the curve, not to the list.
    const parts = t[1].split(/,(?![^(]*\))/);
    assert.equal(parts.length, 2, 'expected two properties, got: ' + t[1].trim());
    for (const p of parts) assert.match(p, /\d+ms/, 'without duration: ' + p.trim());
  });
  check('transform is readable, no matrix()', () => {
    assert.doesNotMatch(cardCss, /matrix\(/, 'matrix() instead of translate/scale');
    assert.match(cardCss, /translateY\(-12px\)|scale\(1\.03\)/);
  });
  check('measured layout width not baked in', () => {
    // A block element's width is its parent's width, not a property of the
    // component.
    assert.doesNotMatch(cardCss.split('@media')[0], /^\s*width:/m, 'width taken over from the layout');
  });
  check('declared size is kept', () => {
    assert.match(pulseCss, /width:\s*64px/, 'the 64px circle needs its size');
  });
  check('keyframes with real offsets', () => {
    assert.match(pulseCss, /@keyframes/);
    assert.match(pulseCss, /0%\s*\{[\s\S]*?100%\s*\{/);
  });
  check('no sampled in-between frame in the base state', () => {
    // For an infinite loop the first measured frame is a random point in the
    // middle of the animation — it does not belong in the base rule.
    const base = pulseCss.split('@keyframes')[0];
    assert.doesNotMatch(base, /opacity:\s*0\.\d{3,}/, 'in-between value in the base state');
  });
  check('the reveal\'s state rule is not empty', () => {
    // opacity:1 and transform:none ARE the target — filtering them out as
    // defaults yields an empty rule and an invisible rebuild.
    const st = /\.[\w-]+\.is-visible\s*\{([\s\S]*?)\}/.exec(revCss);
    assert.ok(st, 'no is-visible rule');
    assert.match(st[1], /opacity:\s*1/, 'end state missing: ' + st[1].trim());
  });
  check('reduced motion does not hide the reveal', () => {
    const rm = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*)\}/.exec(revCss);
    assert.ok(rm, 'no reduced-motion block');
    assert.match(rm[1], /opacity:\s*1/, 'content would stay invisible');
  });
  check('reduced motion does not freeze the hover', () => {
    // For a hover the end state would be wrong here — the card would then
    // stay lifted permanently.
    const rm = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*)\}/.exec(cardCss);
    assert.doesNotMatch(rm[1], /translateY/, 'hover end state wrongly set');
  });
  check('measured IO threshold ends up in the rebuild', () => {
    assert.match(revJs, /threshold:\s*0\.25/);
    assert.match(revJs, /rootMargin/);
  });
  check('demos also run on double-click (file://)', () => {
    // type="module" is blocked by the CORS rule when opened via file://.
    // The demo then looks intact and is dead: no trigger, no controls.
    for (const f of ['card/rebuilt/index.html', 'card/vanilla/index.html', 'reveal/rebuilt/index.html']) {
      const html = readFileSync(join(OUT, f), 'utf8');
      assert.doesNotMatch(html, /<script[^>]*type=["']module["']/, 'module script in ' + f);
    }
    assert.doesNotMatch(readFileSync(join(OUT, 'card/rebuilt/script.js'), 'utf8'), /^\s*(export|import)\s/m,
      'export/import forces a module');
  });
  check('React and Svelte produced', () => {
    assert.ok(existsSync(join(OUT, 'card/react/Component.jsx')));
    assert.ok(existsSync(join(OUT, 'card/svelte/Component.svelte')));
    const jsx = readFileSync(join(OUT, 'card/react/Component.jsx'), 'utf8');
    assert.doesNotMatch(jsx, /useRef/, 'unused ref on the hover trigger');
  });
  check('rebuild uses only its own selectors, anchored on the slug', () => {
    // The whole point: the rebuild takes over no selector structure from the
    // source page. Every rule hangs off its own root name — no `.wrap`, no
    // descendant selector that only exists in the original.
    for (const [slug, css] of [['card', cardCss], ['pulse', pulseCss], ['reveal', revCss]]) {
      const selectors = css
        .replace(/\/\*[\s\S]*?\*\//g, '')                 // strip comments
        .split('\n')
        .filter(l => l.trim().endsWith('{'))
        .map(l => l.replace('{', '').trim())
        // @keyframes/@media are at-rules, not selectors; neither are the
        // percentage marks and from/to inside them.
        .filter(s => s && !s.startsWith('@') && !/^\d+%$/.test(s) && s !== 'from' && s !== 'to');
      assert.ok(selectors.length, 'no selectors in ' + slug);
      for (const s of selectors) {
        assert.ok(s.startsWith('.' + slug), `foreign selector in ${slug}: "${s}"`);
      }
    }
  });

  // ── ZIP ───────────────────────────────────────────────────────────────────
  // A home-made archive format is only believable once it can be read back.
  // Checked against the central directory, not against our own idea of the
  // layout.
  console.log('\nZIP');
  {
    const { zip } = await import('../tools/zip.mjs');
    const { inflateRawSync } = await import('node:zlib');
    const cases = [
      { name: 'a.txt', data: 'hallo\n'.repeat(200) },                 // compressible
      { name: 'sub/dir/b.css', data: '.x{color:red}' },               // subdirectory
      { name: 'ümlaut/größe.txt', data: 'Straße & Gruß' },            // UTF-8 name
      { name: 'raw.bin', data: Buffer.from([0, 1, 2, 253, 254, 255]) }, // binary, barely compressible
    ];
    const buf = zip(cases);

    check('signatures and entry count are right', () => {
      assert.equal(buf.readUInt32LE(0), 0x04034b50, 'no local header at the start');
      const eocdAt = buf.length - 22;
      assert.equal(buf.readUInt32LE(eocdAt), 0x06054b50, 'no end-of-central-directory');
      assert.equal(buf.readUInt16LE(eocdAt + 10), cases.length);
    });

    check('every entry can be extracted again', () => {
      const eocdAt = buf.length - 22;
      let p = buf.readUInt32LE(eocdAt + 16);          // start of the central directory
      const got = new Map();
      for (let i = 0; i < cases.length; i++) {
        assert.equal(buf.readUInt32LE(p), 0x02014b50, 'directory entry ' + i + ' broken');
        const method = buf.readUInt16LE(p + 10);
        const csize = buf.readUInt32LE(p + 20);
        const usize = buf.readUInt32LE(p + 24);
        const nlen = buf.readUInt16LE(p + 28);
        const local = buf.readUInt32LE(p + 42);
        const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
        // The local header repeats the name — the data follows it.
        const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const body = buf.slice(dataAt, dataAt + csize);
        const raw = method === 8 ? inflateRawSync(body) : body;
        assert.equal(raw.length, usize, 'size mismatch for ' + name);
        got.set(name, raw);
        p += 46 + nlen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
      }
      for (const c of cases) {
        const raw = got.get(c.name);
        assert.ok(raw, 'entry missing: ' + c.name);
        const want = Buffer.isBuffer(c.data) ? c.data : Buffer.from(c.data, 'utf8');
        assert.ok(raw.equals(want), 'content differs for ' + c.name);
      }
    });

    check('UTF-8 flag set for names with umlauts', () => {
      // Without bit 11 Windows reads the name in the old code page — and
      // "größe.txt" turns into gibberish.
      assert.equal(buf.readUInt16LE(6) & 0x0800, 0x0800);
    });

    check('incompressible data stays uncompressed', () => {
      // Deflate on random data makes the file bigger. Store it raw then.
      const tiny = zip([{ name: 'r.bin', data: Buffer.from([0, 1, 2, 253, 254, 255]) }]);
      assert.equal(tiny.readUInt16LE(8), 0, 'should have been stored raw');
    });
  }

  // ── Schema ────────────────────────────────────────────────────────────────
  console.log('\nSchema');
  const FIELDS = ['id', 'slug', 'title', 'source', 'route', 'selector', 'domPath', 'category', 'triggers',
    'techniques', 'properties', 'timing', 'easing', 'dependencies', 'assets', 'responsive', 'accessibility',
    'reducedMotion', 'isolatability', 'confidence', 'previews', 'code', 'status', 'warnings', 'createdAt'];
  check('all required fields present', () => {
    for (const f of FIELDS) assert.ok(f in card, 'field missing: ' + f);
  });
  const STATUS = ['candidate', 'inspected', 'isolated', 'rebuilt', 'verified', 'exported', 'needs-review', 'not-isolatable'];
  check('status is an allowed value', () => {
    for (const m of [card, pulse, rev]) assert.ok(STATUS.includes(m.status), 'unknown: ' + m.status);
  });
  check('isolatability is an allowed value', () => {
    for (const m of [card, pulse, rev]) assert.ok(['isolatable', 'partial', 'reference-only', 'not-analysable'].includes(m.isolatability));
  });

  console.log(failed ? `\n✗ ${failed} check(s) failed\n` : '\n✓ all checks passed\n');
} finally {
  stop();
}
process.exit(failed ? 1 : 0);
