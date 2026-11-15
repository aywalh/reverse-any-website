// parity ui — consumes the NDJSON stream from /api/events and draws it.
// No framework: six panels do not justify one.
//
// Two methods share this one stream: full clone (below in this file,
// unchanged) and selective extraction (ui/extract.js). The server only ever
// runs one of them at a time, so one channel is enough.
import * as X from './extract.js';

const $ = id => document.getElementById(id);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

// ── Pipeline ────────────────────────────────────────────────────────────────
const STEPS = ['capture', 'localize', 'fetch', 'verify', 'interact', 'responsive', 'diff'];
const stepEl = {};
for (const name of STEPS) {
  const b = el('div', 'step');
  b.append(el('span', 'n', name), el('span', 'v', '·'));
  $('pipeline').append(b);
  stepEl[name] = b;
}
const setStep = (name, s, v) => {
  const b = stepEl[name];
  if (!b) return;
  b.dataset.s = s;
  if (v != null) b.querySelector('.v').textContent = v;
};
const resetSteps = () => { for (const n of STEPS) { delete stepEl[n].dataset.s; stepEl[n].querySelector('.v').textContent = '·'; } };

const SUMMARY = {
  capture:    e => e.resources + ' Res.',
  localize:   e => e.bytes + ' B',
  fetch:      e => e.downloaded + '/' + e.known,
  verify:     e => e.notFound + ' missing',
  interact:   e => e.passed + '/' + e.total,
  responsive: e => e.rows + ' widths',
  diff:       e => (e.ok ? 'parity' : e.mismatches + ' diff.'),
};

// ── 404-Loop ────────────────────────────────────────────────────────────────
const loop = { rounds: new Map(), assets: 0 };

const roundCard = n => {
  if (loop.rounds.has(n)) return loop.rounds.get(n);
  if (!loop.rounds.size) $('loop').textContent = '';
  const box = el('div', 'round pending');
  const big = el('div', 'big');
  big.append(el('span', null, '0'), Object.assign(el('small'), { textContent: 'files' }));
  const bar = el('div', 'bar'); bar.append(el('i'));
  box.append(el('h3', null, 'Round ' + n), big, bar, el('div', 'tick'));
  $('loop').append(box);
  const card = { box, num: big.firstChild, unit: big.lastChild, bar: bar.firstChild, tick: box.lastChild, n: 0 };
  loop.rounds.set(n, card);
  return card;
};

const onAsset = e => {
  const c = loop.rounds.get(loop.current);
  if (!c) return;
  c.n++;
  c.num.textContent = c.n;
  c.tick.textContent = (e.status ? e.status + ' ' : '') + e.path;
  c.bar.style.width = Math.min(100, (c.n % 200) / 2) + '%';
  $('loop-c').textContent = loop.assets + ' files total';
  loop.assets++;
};

const closeRound = e => {
  const c = loop.rounds.get(e.round);
  if (!c) return;
  c.bar.style.width = '100%';
  c.box.className = 'round ' + (e.missing ? 'pending' : 'solved');
  c.num.textContent = e.missing === 0 ? c.n : c.n;
  c.unit.textContent = e.missing === 0
    ? 'files · 0 missing'
    : 'files · ' + e.missing + ' missing';
  c.tick.textContent = e.missing === 0
    ? 'nothing open — the clone requests nothing that does not exist'
    : e.missing + ' paths go into the next round';
};

// ── Counter-measurement ─────────────────────────────────────────────────────
let diffTable = null, notesBox = null;

const diffRow = e => {
  if (!diffTable) {
    $('diff').textContent = '';
    diffTable = el('table');
    $('diff').append(diffTable);
  }
  const tr = el('tr', 'new ' + (e.match ? 'match' : 'miss'));
  tr.append(el('td', 'm', e.match ? '✓' : '✗'), el('td', 'l', e.label),
            el('td', 'v a', e.source), el('td', 'v b', e.clone));
  diffTable.append(tr);
  $('diff-c').textContent = diffTable.rows.length + ' checks';
};

const diffNote = e => {
  if (!notesBox) { notesBox = el('div', 'notes'); $('diff').append(notesBox); }
  const cls = e.bad === true ? 'bad' : e.bad === false ? 'limit' : '';
  notesBox.append(el('div', cls, '· ' + e.name + ': ' + e.note));
};

const verdict = e => {
  $('verdict').className = 'verdict ' + (e.ok ? 'ok' : 'bad');
  $('verdict').textContent = e.ok ? '✓ Parity reached' : '✗ ' + e.mismatches + ' of ' + e.checked + ' checks differ';
  if (e.ok) $('verdict').append(el('small', null, 'Matching failures on both sides do not count as a defect.'));
};

// ── Screenshot blend ────────────────────────────────────────────────────────
// Option 1 from the plan: the original usually cannot be embedded because of
// X-Frame-Options, so the captures at the same scroll marks stand here instead.
const shots = new Map();   // mark -> { source, clone }
let blendUI = null, activeMark = null;

const MARK_LABEL = m => m === 'desktop-top' ? 'top' : m === 'mobile-top' ? 'mobile' : m + '%';

const onShot = e => {
  const side = e.path.includes('/capture/source/') ? 'source'
             : e.path.includes('/capture/clone/') ? 'clone' : null;
  if (!side) return;
  const m = shots.get(e.mark) || {};
  m[side] = e.path + '?t=' + Date.now();   // round 2 rewrites the same names
  shots.set(e.mark, m);
  renderBlend();
};

const ORDER = ['desktop-top', '0', '25', '50', '75', '100', 'mobile-top'];
const ready = () => ORDER.filter(m => shots.get(m)?.source && shots.get(m)?.clone);

function renderBlend() {
  const pairs = ready();
  $('blend-c').textContent = pairs.length ? pairs.length + ' marks' : shots.size + ' captures, waiting for their counterpart';
  if (!pairs.length) return;

  if (!blendUI) {
    $('blend').textContent = '';
    const marks = el('div', 'marks');
    const stage = el('div', 'blend');
    const a = el('img', 'a'), b = el('img', 'b');
    stage.append(a, b, el('div', 'lab l', 'Original'), el('div', 'lab r', 'Clone'));
    const range = el('input');
    Object.assign(range, { type: 'range', min: 0, max: 100, value: 50 });
    const hint = el('div', 'hint', 'left original · right clone');
    range.addEventListener('input', () => { b.style.opacity = range.value / 100; });
    $('blend').append(marks, stage, range, hint);
    blendUI = { marks, a, b, range };
  }

  blendUI.marks.textContent = '';
  if (!pairs.includes(activeMark)) activeMark = pairs[0];
  for (const m of pairs) {
    const btn = el('button', 'ghost', MARK_LABEL(m));
    btn.setAttribute('aria-pressed', String(m === activeMark));
    btn.onclick = () => { activeMark = m; renderBlend(); };
    blendUI.marks.append(btn);
  }
  const p = shots.get(activeMark);
  blendUI.a.src = p.source;
  blendUI.b.src = p.clone;
  blendUI.b.style.opacity = blendUI.range.value / 100;
}

// ── Stream ──────────────────────────────────────────────────────────────────
const status = (txt, cls = '') => { $('status').className = 'status ' + cls; $('status').innerHTML = txt; };

const reset = () => {
  resetSteps();
  loop.rounds.clear(); loop.assets = 0; loop.current = null;
  $('loop').innerHTML = '<div class="empty">waiting for a run</div>';
  $('loop-c').textContent = '';
  diffTable = null; notesBox = null;
  $('diff').innerHTML = '<div class="empty">waiting for <code>diff</code></div>';
  $('diff-c').textContent = ''; $('verdict').className = ''; $('verdict').textContent = '';
  shots.clear(); blendUI = null; activeMark = null;
  $('blend').innerHTML = '<div class="empty">Screenshots appear once <code>verify --shots</code> has run</div>';
  $('blend-c').textContent = '';
};

// No dedup needed: on reconnect the server replays from index 0, and the
// first event of a run is 'run start' — which clears the view first. A
// counter here would instead swallow the next run, because its buffer starts
// at 0 again on the server.
const handle = e => {
  switch (e.ev) {
    case 'run':
      if (e.status === 'start') { reset(); status('running <b>' + e.url + '</b>'); $('go').disabled = true; }
      if (e.status === 'end')   { status(e.exit === 0 ? '<b>Parity</b>' : '<b>Difference</b>', e.exit === 0 ? 'ok' : 'bad'); $('go').disabled = false; }
      if (e.status === 'error') { status('<b>Error</b>', 'bad'); $('go').disabled = false; }
      break;
    case 'cmd':
      setStep(e.name, e.status === 'start' ? 'run' : 'done');
      if (e.status === 'end' && e.exit !== 0 && e.name !== 'diff') setStep(e.name, 'fail');
      break;
    case 'loop':
      if (e.status === 'start') { loop.current = e.round; roundCard(e.round); }
      else closeRound(e);
      break;
    case 'asset':  onAsset(e); break;
    case 'shot':   onShot(e); break;
    case 'row':    if (e.kind === 'diff') diffRow(e); break;
    // Notes from the extraction belong in its view, not under the
    // counter-measurement — otherwise they land in the wrong panel.
    case 'note':   if (e.kind !== 'extract') diffNote(e); break;
    case 'done':
      if (SUMMARY[e.cmd]) setStep(e.cmd, 'done', SUMMARY[e.cmd](e));
      if (e.cmd === 'diff') verdict(e);
      break;
    case 'idle':   $('go').disabled = false; break;
  }
};

new EventSource('/api/events').onmessage = m => {
  const e = JSON.parse(m.data);
  handle(e);      // Full Clone
  X.handle(e);    // Selective Extraction
};

// ── Controls ────────────────────────────────────────────────────────────────
const post = async (path, body) => {
  const r = await fetch(path, { method: 'POST', body: JSON.stringify(body) });
  if (!r.ok) status('<b>' + ((await r.json()).err || r.status) + '</b>', 'bad');
  return r.ok;
};

// ── Mode selection ──────────────────────────────────────────────────────────
// Two methods, clearly separated. Full clone stays the default — it is the
// existing flow and is not replaced by the extension.
let mode = 'clone';
const setMode = next => {
  mode = next;
  $('mode-clone').setAttribute('aria-selected', String(next === 'clone'));
  $('mode-extract').setAttribute('aria-selected', String(next === 'extract'));
  $('view-clone').hidden = next !== 'clone';
  $('view-extract').hidden = next !== 'extract';
  $('go').textContent = next === 'clone' ? 'Start run' : 'Open page';
  $('ev').hidden = next !== 'clone';
  if (next === 'extract') X.init();
};
$('mode-clone').onclick = () => setMode('clone');
$('mode-extract').onclick = () => setMode('extract');

$('f').onsubmit = ev => {
  ev.preventDefault();
  if (mode === 'extract') return void X.openSite($('url').value);
  $('go').disabled = true;
  post('/api/run', { url: $('url').value }).then(ok => { if (!ok) $('go').disabled = false; });
};

$('ev').onchange = ev => {
  const t = ev.target.value;
  ev.target.value = '';
  if (t) post('/api/demo', { target: t });
};
