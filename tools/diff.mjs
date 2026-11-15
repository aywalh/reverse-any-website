// Counter-measurement: compare a source report directory against a clone one.
// This is the point of the whole tool — a clone measured only against itself
// proves nothing.
//
// Usage: node tools/diff.mjs <sourceDir> <cloneDir>
//
// Auto-detects VERIFY.json / INTERACTIONS.json / RESPONSIVE.json in both dirs.
// Exit code 1 if anything meaningful differs, so it works in CI.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { emit } from './_emit.mjs';

const [, , A, B] = process.argv;
if (!A || !B) {
  console.error('usage: node tools/diff.mjs <sourceDir> <cloneDir>');
  process.exit(2);
}

const read = (d, f) => existsSync(join(d, f)) ? JSON.parse(readFileSync(join(d, f), 'utf8')) : null;
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m';
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fmt = v => v === undefined ? '—' : (typeof v === 'object' ? JSON.stringify(v) : String(v));

let rows = [], mismatches = 0, checked = 0, offOrigin = null;
const cmp = (label, a, b, { soft = false } = {}) => {
  checked++;
  const same = eq(a, b);
  if (!same && !soft) mismatches++;
  rows.push({ label, a: fmt(a), b: fmt(b), same, soft });
  emit({ ev: 'row', kind: 'diff', label, source: fmt(a), clone: fmt(b), match: same, soft });
};

// ── verify ────────────────────────────────────────────────────────────────
const va = read(A, 'VERIFY.json'), vb = read(B, 'VERIFY.json');
if (va && vb) {
  cmp('title', va.initial.title, vb.initial.title);
  cmp('canvas count', va.initial.canvases.length, vb.initial.canvases.length);
  cmp('canvas rendering', va.afterScroll.canvasNonBlank?.map(n => n > 8), vb.afterScroll.canvasNonBlank?.map(n => n > 8));
  cmp('scrollHeight', va.initial.scrollHeight, vb.initial.scrollHeight);
  // Only meaningful once both reports carry it; older evidence predates the field.
  if (va.initial.scrollLocked !== undefined && vb.initial.scrollLocked !== undefined)
    cmp('document scrolls', !va.initial.scrollLocked, !vb.initial.scrollLocked);
  cmp('scrollY reached', va.afterScroll.scrollY, vb.afterScroll.scrollY);
  cmp('images loaded', `${va.afterScroll.imagesLoaded}/${va.afterScroll.imagesTotal}`,
                       `${vb.afterScroll.imagesLoaded}/${vb.afterScroll.imagesTotal}`);
  cmp('fonts loaded', va.initial.fonts.length, vb.initial.fonts.length);
  // Off-origin noise is not a clone defect. localize strips trackers and the
  // guard blocks the rest, so a tracked original will always show requests,
  // statuses and errors a clone structurally cannot have. Counting them means
  // no real site can ever reach parity — the fix has to cover all three places
  // they show up, not just the first one that was noticed.
  const own = r => { try { return new URL(r.url).host; } catch { return ''; } };
  const hostOf = u => { try { return new URL(u).host; } catch { return ''; } };
  const split = (r, list) => {
    const h = own(r), inn = [], out = [];
    for (const x of list ?? []) (hostOf(x.url) === h ? inn : out).push(x);
    return { inn, out };
  };

  const fa = split(va, va.failed), fb = split(vb, vb.failed);
  const na = split(va, va.notFound), nb = split(vb, vb.notFound);

  // Foreign hosts the clone was never going to reach. Console messages that name
  // one of them describe a request that was removed on purpose.
  const foreign = new Set([...fa.out, ...fb.out, ...na.out, ...nb.out].map(x => hostOf(x.url)).filter(Boolean));
  // Every blocked request also prints one "Failed to load resource" line, and
  // that line carries no host — so it cannot be matched by name. It can be
  // accounted for by number: at most as many of them are dropped as the side
  // actually had off-origin failures. Bounded, so it can never hide a real one.
  const ownErrors = (r, offCount) => {
    const named = (r.errors ?? []).filter(e => ![...foreign].some(h => e.includes(h)));
    let budget = offCount;
    return named.filter(e => {
      if (budget > 0 && /Failed to load resource/i.test(e)) { budget--; return false; }
      return true;
    });
  };

  const offA = fa.out.length + na.out.length, offB = fb.out.length + nb.out.length;
  cmp('console errors', ownErrors(va, offA).length, ownErrors(vb, offB).length);
  cmp('http >= 400', na.inn.length, nb.inn.length);
  cmp('failed requests', fa.inn.length, fb.inn.length);

  if (offA || offB) offOrigin = { source: offA, clone: offB, hosts: [...foreign] };
}

// ── did either side render at all? ────────────────────────────────────────
// Two blank pages match perfectly. Without this the strongest possible result
// and the most worthless one look the same from the outside.
let emptyNote = null;
if (va && vb && va.initial.nodes !== undefined && vb.initial.nodes !== undefined) {
  const blank = r => r.initial.nodes < 60 && r.initial.textLength < 40
                  && r.initial.canvases.length === 0 && r.initial.imagesTotal === 0;
  const [ba, bb] = [blank(va), blank(vb)];
  if (ba && bb) emptyNote = 'neither side rendered anything → the run proves nothing';
  else if (ba !== bb) { checked++; mismatches++;
    rows.push({ label: 'page rendered', a: ba ? 'nothing' : 'yes', b: bb ? 'nothing' : 'yes', same: false });
    emit({ ev: 'row', kind: 'diff', label: 'page rendered', source: ba ? 'nothing' : 'yes', clone: bb ? 'nothing' : 'yes', match: false });
  }
}

// ── interactions ──────────────────────────────────────────────────────────
const ia = read(A, 'INTERACTIONS.json'), ib = read(B, 'INTERACTIONS.json');
let stepNotes = [];
if (ia && ib) {
  cmp('interaction steps passed', `${ia.passed}/${ia.total}`, `${ib.passed}/${ib.total}`);
  const mapA = new Map(ia.results.map(r => [r.name, r]));
  const mapB = new Map(ib.results.map(r => [r.name, r]));
  for (const [name, ra] of mapA) {
    const rb = mapB.get(name);
    if (!rb) { stepNotes.push({ name, note: 'only present in source', bad: true }); mismatches++; continue; }
    if (ra.ok !== rb.ok) {
      stepNotes.push({ name, note: `source ${ra.ok ? 'ok' : 'fail'} · clone ${rb.ok ? 'ok' : 'fail'}`, bad: true });
      mismatches++;
    } else if (!ra.ok && !rb.ok) {
      // Same failure on both sides = harness limit, not a clone defect.
      stepNotes.push({ name, note: 'failed on both sides → limit of the measurement', bad: false });
    } else if (!eq(ra.value, rb.value)) {
      stepNotes.push({ name, note: `value differs: ${fmt(ra.value).slice(0, 60)} vs ${fmt(rb.value).slice(0, 60)}`, bad: null });
    }
  }
}

// ── responsive ────────────────────────────────────────────────────────────
const ra_ = read(A, 'RESPONSIVE.json'), rb_ = read(B, 'RESPONSIVE.json');
let respBad = [];
if (ra_ && rb_) {
  const byW = new Map(rb_.rows.map(r => [r.w, r]));
  for (const row of ra_.rows) {
    const o = byW.get(row.w);
    if (!o) { respBad.push(`${row.w}px missing from the clone run`); continue; }
    if (row.scrollHeight !== o.scrollHeight) respBad.push(`${row.w}px: scrollHeight ${row.scrollHeight} vs ${o.scrollHeight}`);
    if (row.desktopNav !== o.desktopNav || row.burger !== o.burger) respBad.push(`${row.w}px: nav mode differs`);
    if (o.overflowX > 0) respBad.push(`${row.w}px: clone has ${o.overflowX}px horizontal overflow`);
  }
  checked++;
  if (respBad.length) mismatches++;
  rows.push({ label: `responsive (${ra_.rows.length} widths)`, a: `${ra_.rows.length} measured`,
              b: respBad.length ? `${respBad.length} differences` : 'all identical', same: !respBad.length });
  emit({ ev: 'row', kind: 'diff', label: `responsive (${ra_.rows.length} widths)`,
         source: `${ra_.rows.length} measured`, clone: respBad.length ? `${respBad.length} differences` : 'all identical',
         match: !respBad.length, detail: respBad });
}

// ── output ────────────────────────────────────────────────────────────────
if (!rows.length) {
  console.error(`No comparable reports found in ${A} and ${B}.`);
  console.error('Expected: VERIFY.json, INTERACTIONS.json or RESPONSIVE.json in both directories.');
  process.exit(2);
}

const w = Math.max(...rows.map(r => r.label.length), 12);
const wa = Math.max(...rows.map(r => r.a.length), 6, A.length);
console.log(`\n${D}Source:${X} ${A}\n${D}Clone: ${X} ${B}\n`);
console.log(`  ${'Metric'.padEnd(w)}  ${'Source'.padEnd(wa)}  Clone`);
console.log(`  ${'─'.repeat(w)}  ${'─'.repeat(wa)}  ${'─'.repeat(20)}`);
for (const r of rows) {
  const mark = r.same ? `${G}✓${X}` : `${R}✗${X}`;
  const bcol = r.same ? '' : R;
  console.log(`${mark} ${r.label.padEnd(w)}  ${r.a.padEnd(wa)}  ${bcol}${r.b}${X}`);
}

if (offOrigin) {
  const note = `source ${offOrigin.source} · clone ${offOrigin.clone} — ${offOrigin.hosts.join(', ')}`;
  emit({ ev: 'note', kind: 'offOrigin', name: 'off-origin requests', note, bad: false });
  console.log(`
  ${D}Off-origin requests (not counted):${X} ${note}`);
}

for (const s of stepNotes) emit({ ev: 'note', kind: 'step', name: s.name, note: s.note, bad: s.bad });
if (stepNotes.length) {
  console.log(`\n  ${D}Interaction steps:${X}`);
  for (const s of stepNotes) {
    const c = s.bad === true ? R : s.bad === false ? Y : D;
    console.log(`  ${c}·${X} ${s.name}: ${c}${s.note}${X}`);
  }
}
if (respBad.length) {
  console.log(`\n  ${R}Responsive differences:${X}`);
  respBad.slice(0, 20).forEach(s => console.log(`  · ${s}`));
}

if (emptyNote) {
  emit({ ev: 'note', kind: 'empty', name: 'page rendered', note: emptyNote, bad: true });
  console.log(`
  ${R}⚠ ${emptyNote}${X}`);
}

const ok = mismatches === 0 && !emptyNote;
emit({ ev: 'done', cmd: 'diff', ok, mismatches, checked, exit: ok ? 0 : 1 });
const verdict = ok ? '✓ Parity reached'
  : mismatches ? `✗ ${mismatches} of ${checked} checks differ`
  : '✗ No result — there was nothing to compare';
console.log(`
${ok ? G : R}${verdict}${X}`);
if (ok) console.log(`${D}  Matching failures on both sides do not count as a defect.${X}\n`);
else console.log('');
process.exit(ok ? 0 : 1);
