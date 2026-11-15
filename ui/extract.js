// parity ui — selective extraction.
//
// The picker runs in the parent window and reads the iframe's DOM directly.
// That only works because the inspected page comes from the same server as
// this interface (see serveSite in ui/server.mjs). That is also why nothing is
// written into the page — no injected overlay, no postMessage, no scripts that
// could collide with the page's own.

const $ = id => document.getElementById(id);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// ── Progress ────────────────────────────────────────────────────────────────
// The same eleven steps tools/extract.mjs reports.
const STEPS = [
  ['element', 'Element found'], ['animation', 'Animation detected'], ['trigger', 'Trigger detected'],
  ['css', 'CSS inspected'], ['js', 'JavaScript inspected'], ['deps', 'Dependencies checked'],
  ['original', 'Original preview'], ['isolatability', 'Isolatability'], ['isolated', 'Isolated preview'],
  ['code', 'Code prepared'], ['export', 'Export ready'],
];
const stepEl = {};

export const initPipeline = () => {
  if (Object.keys(stepEl).length) return;
  for (const [key, label] of STEPS) {
    const b = el('div', 'step');
    b.append(el('span', 'n', label), el('span', 'v', '·'));
    $('xpipeline').append(b);
    stepEl[key] = b;
  }
};
const resetSteps = () => {
  for (const [k] of STEPS) { if (!stepEl[k]) continue; delete stepEl[k].dataset.s; stepEl[k].querySelector('.v').textContent = '·'; }
};

// ── State ───────────────────────────────────────────────────────────────────
const state = {
  url: null,          // original URL — measured against this
  picked: null,       // element in the iframe
  selector: null,
  scope: 'element',
  trigger: 'auto',
  meta: null,         // metadata.json of the last analysis
  base: null,         // /extractions/<slug>
};

const frame = () => $('frame');
const fdoc = () => { try { return frame().contentDocument; } catch { return null; } };

// ── Selector for an element ─────────────────────────────────────────────────
// Must be unique in the document, otherwise extract later measures a different
// element than the one clicked. So it is checked against the DOM, not just
// assembled.
const CSSesc = s => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/([^\w-])/g, '\\$1');

const uniqueSelector = (doc, node) => {
  if (!doc || !node || node.nodeType !== 1) return null;
  const one = sel => { try { return doc.querySelectorAll(sel).length === 1; } catch { return false; } };
  if (node.id && one('#' + CSSesc(node.id))) return '#' + CSSesc(node.id);

  const parts = [];
  for (let n = node; n && n.nodeType === 1 && n !== doc.documentElement; n = n.parentElement) {
    if (n.id && one('#' + CSSesc(n.id))) { parts.unshift('#' + CSSesc(n.id)); break; }

    let s = n.tagName.toLowerCase();
    // Generated (hash-like) classes are no good as anchors — they change with
    // the target page's next build.
    const cls = [...n.classList].filter(c => /^[a-zA-Z][\w-]{1,40}$/.test(c) && !/^[a-z]+-[a-z0-9]{6,}$/i.test(c)).slice(0, 3);
    if (cls.length) s += '.' + cls.map(CSSesc).join('.');

    const parent = n.parentElement;
    if (parent) {
      const siblings = [...parent.children].filter(c => { try { return c.matches(s); } catch { return false; } });
      if (siblings.length > 1) {
        const sameTag = [...parent.children].filter(c => c.tagName === n.tagName);
        s += ':nth-of-type(' + (sameTag.indexOf(n) + 1) + ')';
      }
    }
    parts.unshift(s);
    const test = parts.join(' > ');
    if (one(test)) return test;
  }
  return parts.join(' > ');
};

const domPathOf = node => {
  const parts = [];
  for (let n = node; n && n.nodeType === 1; n = n.parentElement) {
    const p = n.parentElement;
    const i = p ? [...p.children].filter(c => c.tagName === n.tagName).indexOf(n) : 0;
    parts.unshift(n.tagName.toLowerCase() + (i > 0 ? ':nth-of-type(' + (i + 1) + ')' : ''));
  }
  return parts.join(' > ');
};

// What on this element promises motion at all — a preview only, the real
// answer comes from the measurement.
const hintFor = node => {
  const doc = fdoc();
  if (!doc || !doc.defaultView) return '—';
  const c = doc.defaultView.getComputedStyle(node);
  const bits = [];
  if (parseFloat(c.transitionDuration) > 0) bits.push('transition ' + c.transitionDuration.split(',')[0].trim());
  if (c.animationName && c.animationName !== 'none') bits.push('@keyframes ' + c.animationName.split(',')[0].trim());
  try { const a = node.getAnimations({ subtree: true }); if (a.length) bits.push(a.length + ' running animation(s)'); } catch {}
  if (node.querySelector('canvas') || node.tagName === 'CANVAS') bits.push('Canvas');
  if (node.querySelector('video') || node.tagName === 'VIDEO') bits.push('Video');
  if (node.querySelector('svg')) bits.push('SVG');
  return bits.length ? bits.join(' · ') : 'no CSS motion at rest — trigger needed';
};

// ── Highlight ───────────────────────────────────────────────────────────────
// The frame is drawn in the parent window. Writing into the page would change
// its layout — and thereby distort exactly what is to be measured here.
const drawHighlight = node => {
  const hl = $('hl');
  if (!node) { hl.hidden = true; return; }
  const r = node.getBoundingClientRect();
  const f = frame().getBoundingClientRect();
  if (!r.width && !r.height) { hl.hidden = true; return; }
  hl.hidden = false;
  hl.style.left = (f.left + r.left) + 'px';
  hl.style.top = (f.top + r.top) + 'px';
  hl.style.width = r.width + 'px';
  hl.style.height = r.height + 'px';
  $('hl-tag').textContent = node.tagName.toLowerCase()
    + (node.id ? '#' + node.id : '')
    + ([...node.classList].slice(0, 2).map(c => '.' + c).join(''))
    + '  ' + Math.round(r.width) + '×' + Math.round(r.height);
};

const pick = node => {
  if (!node || node.nodeType !== 1) return;
  state.picked = node;
  const doc = fdoc();
  state.selector = uniqueSelector(doc, node);
  $('p-sel').textContent = state.selector || '—';
  $('p-path').textContent = domPathOf(node);
  $('p-hint').textContent = hintFor(node);
  $('sel-count').textContent = (() => {
    try { return doc.querySelectorAll(state.selector).length + ' matches'; } catch { return 'selector not checkable'; }
  })();
  $('sec-pick').hidden = false;
  $('analyse').disabled = false;
  node.scrollIntoView?.({ block: 'nearest' });
  drawHighlight(node);
};

// ── Wire up the iframe ──────────────────────────────────────────────────────
let wired = false;
const wireFrame = () => {
  const doc = fdoc();
  if (!doc) { $('pick-c').textContent = 'page not readable'; return; }
  wired = true;
  $('pick-c').textContent = 'hover with the mouse, then click';

  doc.addEventListener('mousemove', e => {
    const n = doc.elementFromPoint(e.clientX, e.clientY);
    if (n && n !== state.hover) { state.hover = n; drawHighlight(n); }
  }, true);
  doc.addEventListener('mouseleave', () => drawHighlight(state.picked), true);

  // Capture phase: the page must not intercept the click first, and it must
  // not navigate either — otherwise the inspect target is gone.
  doc.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    pick(doc.elementFromPoint(e.clientX, e.clientY));
  }, true);
  doc.addEventListener('submit', e => e.preventDefault(), true);

  // Scrolling in the iframe moves the element out from under the frame.
  doc.addEventListener('scroll', () => drawHighlight(state.picked), true);
  frame().contentWindow.addEventListener('resize', () => drawHighlight(state.picked));
};

window.addEventListener('scroll', () => state.picked && drawHighlight(state.picked), true);

// ── Relatives ───────────────────────────────────────────────────────────────
const REL = {
  parent: n => n.parentElement,
  child: n => n.firstElementChild,
  prev: n => n.previousElementSibling,
  next: n => n.nextElementSibling,
};
document.addEventListener('click', e => {
  const b = e.target.closest?.('.nav-rel button');
  if (!b || !state.picked) return;
  const next = REL[b.dataset.rel]?.(state.picked);
  if (next) pick(next);
});

// ── Chips ───────────────────────────────────────────────────────────────────
const wireChips = (id, key) => {
  $(id).addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    for (const x of $(id).querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
    state[key] = b.dataset[key];
  });
};

// ── Kick off the analysis ───────────────────────────────────────────────────
const post = async (path, body) => {
  const r = await fetch(path, { method: 'POST', body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.err || ('HTTP ' + r.status));
  return j;
};

export const openSite = async url => {
  state.url = url;
  $('inspect-empty').textContent = 'fetching page…';
  try {
    await post('/api/inspect', { url });
  } catch (e) {
    $('inspect-empty').textContent = 'Error: ' + e.message;
  }
};

const startAnalysis = async () => {
  if (!state.selector || !state.url) return;
  resetSteps();
  $('analyse').disabled = true;
  $('info').innerHTML = '<div class="empty">analysis running…</div>';
  $('preview').innerHTML = '<div class="empty">analysis running…</div>';
  $('code').innerHTML = '<div class="empty">analysis running…</div>';
  try {
    await post('/api/extract', {
      url: state.url, selector: state.selector, scope: state.scope,
      trigger: state.trigger, title: $('p-title').value.trim() || undefined,
    });
  } catch (e) {
    $('info').innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>';
    $('analyse').disabled = false;
  }
};

// ── Render the result ───────────────────────────────────────────────────────
const ISO_LABEL = {
  isolatable: ['isolatable', 'ok'],
  partial: ['partially isolatable', 'limit'],
  'reference-only': ['documentable as reference only', 'limit'],
  'not-analysable': ['not analysable', 'bad'],
};

const kv = (parent, label, value, cls) => {
  const row = el('div', 'kv');
  row.append(el('b', null, label));
  const v = el('span', cls || null);
  if (value instanceof Node) v.append(value); else v.textContent = value ?? '—';
  row.append(v);
  parent.append(row);
  return row;
};

const renderInfo = m => {
  const box = el('div');
  const [isoText, isoCls] = ISO_LABEL[m.isolatability] || [m.isolatability, ''];

  kv(box, 'Name', m.title);
  kv(box, 'Element type', m.category);
  kv(box, 'Selector', Object.assign(el('code'), { textContent: m.selector }));
  kv(box, 'DOM path', Object.assign(el('code', 'wrapcode'), { textContent: m.domPath }));
  kv(box, 'Trigger', m.triggers.join(', '));
  kv(box, 'Technique', m.techniques.join(', ') || '—');
  kv(box, 'Libraries', m.dependencies.libraries.join(', ') || 'none detected');
  kv(box, 'Assets', m.assets.length ? m.assets.length + ' third-party files' : 'none');
  kv(box, 'Fonts', m.fonts.join(' · ') || '—');

  const t = m.timing;
  kv(box, 'Timing', t.durationMs != null
    ? `${t.durationMs}ms${t.delayMs ? ' · delay ' + t.delayMs + 'ms' : ''} (${t.durationSource})${t.loops ? ' · infinite loop' : ''}`
    : 'no measurable duration');
  kv(box, 'Easing', m.easing.join(' · ') || '—');
  kv(box, 'Properties', m.properties.join(', ') || 'no motion measured');
  kv(box, 'Repeats', `measured ${t.repeats}×${t.stableAcrossRepeats === false ? ' — not matching' : t.stableAcrossRepeats ? ', matching' : ''}`);

  const rm = m.reducedMotion;
  kv(box, 'Reduced Motion',
    !rm.probed ? 'not measured'
    : rm.respected === null ? 'no motion declared — nothing to reduce'
    : rm.respected ? '✓ the source page responds to it'
    : '✗ the source page ignores the setting',
    rm.respected === false ? 'bad' : rm.respected === true ? 'ok' : '');
  kv(box, 'Accessibility', [
    m.accessibility.interactive ? 'interactive' : 'static',
    m.accessibility.focusable ? 'focusable' : 'not focusable',
    m.accessibility.hasText ? 'with text' : 'without text',
  ].join(' · '));
  kv(box, 'Isolatability', isoText, isoCls);
  kv(box, 'Confidence', String(m.confidence), m.confidence >= 0.8 ? 'ok' : m.confidence >= 0.5 ? 'limit' : 'bad');
  kv(box, 'Status', m.status);

  if (m.warnings.length) {
    const w = el('div', 'notes');
    w.append(el('div', null, m.warnings.length + ' note(s):'));
    for (const x of m.warnings) w.append(el('div', 'limit', '· ' + x));
    box.append(w);
  }
  $('info').innerHTML = '';
  $('info').append(box);
  $('info-c').textContent = isoText;
};

// ── Preview ─────────────────────────────────────────────────────────────────
const PREVIEW_TABS = [
  ['original', 'Original'],
  ['isolated', 'Isolated'],
  ['rebuilt', 'Rebuilt'],
  ['comparison', 'Comparison'],
];
let previewTab = 'original';

const renderPreview = m => {
  const base = state.base;
  const box = el('div');

  const tabs = el('div', 'chips');
  for (const [key, label] of PREVIEW_TABS) {
    const b = el('button', null, label);
    b.dataset.tab = key;
    b.setAttribute('aria-pressed', String(key === previewTab));
    b.onclick = () => { previewTab = key; renderPreview(m); };
    tabs.append(b);
  }
  box.append(tabs);

  const stage = el('div', 'pstage');
  box.append(stage);

  const shot = (file, alt) => {
    const i = el('img', 'pshot');
    i.src = base + '/' + file + '?t=' + Date.now();
    i.alt = alt;
    return i;
  };
  const note = (txt, cls) => el('div', 'pnote ' + (cls || ''), txt);

  if (previewTab === 'original') {
    if (m.previews.original) {
      const pair = el('div', 'pair');
      const a = el('figure'); a.append(shot(m.previews.original, 'Original before the trigger'), el('figcaption', null, 'before the trigger'));
      pair.append(a);
      if (m.previews.originalAfter) {
        const b = el('figure'); b.append(shot(m.previews.originalAfter, 'Original after the trigger'), el('figcaption', null, 'after ' + m.triggers[0]));
        pair.append(b);
      }
      stage.append(pair);
      stage.append(note('Captures from the running original page. Embedding the original live fails on most production sites because of X-Frame-Options.'));
    } else stage.append(note('No original capture — the element could not be captured.', 'bad'));
  }

  if (previewTab === 'isolated') {
    if (m.previews.isolated || m.code.vanilla) {
      const wrap = el('div', 'framewrap live');
      const f = el('iframe');
      f.id = 'pframe';
      f.src = base + '/vanilla/index.html?t=' + Date.now();
      f.title = 'Isolated preview';
      wrap.append(f);
      stage.append(controls(), wrap);
      stage.append(note('Original markup and original CSS, reduced to the target. Not an implementation of your own — do not publish.'));
    } else stage.append(note('No isolated version produced.', 'bad'));
  }

  if (previewTab === 'rebuilt') {
    if (m.code.rebuilt) {
      const wrap = el('div', 'framewrap live');
      const f = el('iframe');
      f.id = 'pframe';
      f.src = base + '/rebuilt/index.html?t=' + Date.now();
      f.title = 'Rebuilt preview';
      wrap.append(f);
      stage.append(controls(), wrap);
      stage.append(note(`Newly written from the measurement — .${m.rebuild?.root} as ${m.rebuild?.technique}, `
        + `trigger ${m.rebuild?.trigger}. Does not know the source page's CSS.`));
      if (m.rebuild?.notes?.length) {
        const ul = el('ul', 'why');
        for (const n of m.rebuild.notes.slice(1)) ul.append(el('li', null, n));
        if (ul.children.length) stage.append(ul);
      }
    } else {
      // Honesty is mandatory here. An empty frame with the original in it
      // would be a lie, and so would a guessed rebuild.
      stage.append(note('No independent version is produced for this target.', 'limit'));
      const why = el('ul', 'why');
      if (m.isolatability === 'reference-only')
        why.append(el('li', null, 'Documentable as reference only: ' + (m.warnings[0] || 'the runtime cannot be cut out.')));
      for (const t of ['webgl', 'canvas', 'three', 'rive']) {
        if (m.techniques?.includes(t)) { why.append(el('li', null, `The content comes from ${t} — what is drawn there is in no CSS rule.`)); break; }
      }
      why.append(el('li', null, 'What there is: the complete measurement, the report and the isolated version with original code.'));
      stage.append(why);
    }
  }

  if (previewTab === 'comparison') {
    // Original against the INDEPENDENT version as soon as there is one — that
    // is the comparison that proves something. The isolated version contains
    // the same CSS as the original; putting it alongside mainly shows that
    // copying works.
    const rightFile = m.previews.rebuilt || m.previews.isolated;
    const rightLabel = m.previews.rebuilt ? 'Rebuilt' : 'Isolated';
    if (m.previews.original && rightFile) {
      const wrap = el('div', 'blend');
      const a = el('img', 'a'), b = el('img', 'b');
      a.src = base + '/' + m.previews.original + '?t=' + Date.now();
      b.src = base + '/' + rightFile + '?t=' + Date.now();
      wrap.append(a, b, el('div', 'lab l', 'Original'), el('div', 'lab r', rightLabel));
      const range = el('input');
      Object.assign(range, { type: 'range', min: 0, max: 100, value: 50 });
      range.addEventListener('input', () => { b.style.opacity = range.value / 100; });
      b.style.opacity = .5;
      stage.append(wrap, range, el('div', 'hint', `Slider: left original, right ${rightLabel.toLowerCase()} version`));
      if (!m.previews.rebuilt) stage.append(note('Compared against the isolated version — there is no independent version for this target.', 'limit'));
    } else stage.append(note('One of the two captures needed for the comparison is missing.', 'limit'));
  }

  // Export
  const ex = el('div', 'exports');
  ex.append(el('span', 'lbl', 'Export:'));
  const dl = (href, label, name) => {
    const a = el('a', 'ghostlink', label);
    a.href = href; a.download = name || '';
    return a;
  };
  if (m.previews.original) ex.append(dl(base + '/' + m.previews.original, 'Screenshot Original'));
  if (m.previews.isolated) ex.append(dl(base + '/' + m.previews.isolated, 'Screenshot isolated'));
  ex.append(dl(base + '/report.md', 'Analysis report'));
  ex.append(dl(base + '/metadata.json', 'Metadata JSON'));
  ex.append(dl(base + '/vanilla/index.html', 'Isolated demo'));
  if (m.code.rebuilt) ex.append(dl(base + '/rebuilt/index.html', 'Rebuild demo'));
  if (m.code.react) ex.append(dl(base + '/react/Component.jsx', 'React component'));
  if (m.code.svelte) ex.append(dl(base + '/svelte/Component.svelte', 'Svelte component'));
  if (m.previews.rebuilt) ex.append(dl(base + '/' + m.previews.rebuilt, 'Screenshot rebuild'));
  if (m.previews.video) ex.append(dl(base + '/' + m.previews.video, 'Video (webm)'));
  if (m.code.single) ex.append(dl(base + '/' + m.code.single, 'Single file'));
  if (m.code.zip) ex.append(dl(base + '/' + m.code.zip, 'ZIP (everything)'));
  box.append(ex);

  $('preview').innerHTML = '';
  $('preview').append(box);
  $('prev-c').textContent = PREVIEW_TABS.find(t => t[0] === previewTab)[1];
};

// Controls for the isolated preview. The generated script.js in the iframe
// listens to postMessage — which is why this works without access to its internals.
const controls = () => {
  const bar = el('div', 'controls');
  const send = (cmd, arg) => {
    const f = $('pframe');
    f?.contentWindow?.postMessage({ parity: { cmd, arg } }, '*');
  };
  for (const [cmd, label] of [['play', 'Play'], ['pause', 'Pause'], ['restart', 'Restart'], ['reset', 'Reset'], ['fire', 'Fire trigger']]) {
    const b = el('button', 'ghost', label);
    b.onclick = () => send(cmd, null);
    bar.append(b);
  }

  const rate = el('select', 'ghost');
  for (const v of ['0.25', '0.5', '1', '2']) {
    const o = el('option', null, v + '×'); o.value = v; if (v === '1') o.selected = true;
    rate.append(o);
  }
  rate.onchange = () => send('rate', Number(rate.value));
  bar.append(rate);

  const sep = el('span', 'sep');
  bar.append(sep);

  for (const [w, label] of [[null, 'Desktop'], [390, 'Mobile']]) {
    const b = el('button', 'ghost', label);
    b.onclick = () => { const f = $('pframe'); if (f) f.style.maxWidth = w ? w + 'px' : ''; };
    bar.append(b);
  }

  const rm = el('button', 'ghost', 'Reduced Motion');
  rm.setAttribute('aria-pressed', 'false');
  rm.onclick = () => {
    const f = $('pframe');
    const d = f?.contentDocument;
    if (!d) return;
    const on = rm.getAttribute('aria-pressed') === 'true';
    let s = d.getElementById('parity-rm');
    if (on) { s?.remove(); rm.setAttribute('aria-pressed', 'false'); return; }
    s = d.createElement('style');
    s.id = 'parity-rm';
    s.textContent = '*,*::before,*::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important;scroll-behavior:auto!important}';
    d.head.append(s);
    rm.setAttribute('aria-pressed', 'true');
  };
  rm.title = 'Simulates prefers-reduced-motion in the preview. How the original page responds to it is in the analysis.';
  bar.append(rm);

  const full = el('button', 'ghost', 'Fullscreen');
  full.onclick = () => $('pframe')?.parentElement?.requestFullscreen?.();
  bar.append(full);

  return bar;
};

// ── Code ────────────────────────────────────────────────────────────────────
// A small regex highlighter instead of a library. It colours strings, comments,
// keywords and numbers — a reading pane needs no more.
const highlight = (src, lang) => {
  let s = esc(src);
  const box = [];
  const stash = (re, cls) => { s = s.replace(re, m => { box.push('<i class="' + cls + '">' + m + '</i>'); return '' + (box.length - 1) + ''; }); };
  stash(/\/\*[\s\S]*?\*\/|(^|\s)\/\/[^\n]*/gm, 'c-com');
  stash(/&quot;[^&]*?&quot;|&#39;[^&]*?&#39;|"[^"\n]*"|'[^'\n]*'|`[^`]*`/g, 'c-str');
  if (lang === 'html') stash(/&lt;\/?[a-zA-Z][\w-]*/g, 'c-kw');
  else if (lang === 'css') { stash(/@[a-z-]+/g, 'c-kw'); stash(/[.#][a-zA-Z_][\w-]*/g, 'c-sel'); stash(/[a-z-]+(?=\s*:)/g, 'c-prop'); }
  else stash(/\b(const|let|var|function|return|if|else|for|of|in|new|class|export|import|await|async|window|document|null|true|false)\b/g, 'c-kw');
  stash(/\b\d+(\.\d+)?(ms|s|px|%|em|rem|deg)?\b/g, 'c-num');
  return s.replace(/(\d+)/g, (_, i) => box[Number(i)]);
};

const renderCode = async m => {
  const base = state.base;
  // Two origins, clearly separated. "Isolated" is the source page's original
  // code, "Rebuild" is written from the measurement. Mix them up and you
  // publish someone else's code as your own.
  const files = [
    ['Isolated · HTML', 'vanilla/index.html', 'html'],
    ['Isolated · CSS', 'vanilla/style.css', 'css'],
    ['Isolated · JS', 'vanilla/script.js', 'js'],
    ...(m.code.rebuilt ? [
      ['Rebuild · HTML', 'rebuilt/index.html', 'html'],
      ['Rebuild · CSS', 'rebuilt/style.css', 'css'],
      ['Rebuild · JS', 'rebuilt/script.js', 'js'],
    ] : []),
    ...(m.code.react ? [['React', 'react/Component.jsx', 'js']] : []),
    ...(m.code.svelte ? [['Svelte', 'svelte/Component.svelte', 'html']] : []),
    ['Metadata', 'metadata.json', 'js'],
    ['Report', 'report.md', 'md'],
    ...(m.code.rebuilt ? [] : [['Why no rebuild', 'NOT-REBUILT.md', 'md']]),
  ];
  const box = el('div');
  const tabs = el('div', 'chips');
  const pane = el('div');
  let active = 0;

  const show = async i => {
    active = i;
    for (const [j, b] of [...tabs.children].entries()) b.setAttribute('aria-pressed', String(j === i));
    const [label, file, lang] = files[i];
    pane.innerHTML = '<div class="empty">loading…</div>';
    let text;
    try {
      const r = await fetch(base + '/' + file);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      text = await r.text();
    } catch (e) {
      pane.innerHTML = '<div class="pnote bad">' + esc(label) + ' not available: ' + esc(e.message) + '</div>';
      return;
    }
    pane.innerHTML = '';

    const bar = el('div', 'codebar');
    const copy = el('button', 'ghost', 'Copy');
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(text); copy.textContent = 'copied ✓'; setTimeout(() => { copy.textContent = 'Copy'; }, 1400); }
      catch { copy.textContent = 'clipboard blocked'; }
    };
    const down = el('a', 'ghostlink', 'Download');
    down.href = base + '/' + file; down.download = file.split('/').pop();
    bar.append(copy, down, el('span', 'muted', file + ' · ' + text.length + ' characters'));

    const pre = el('pre', 'code');
    pre.innerHTML = highlight(text.slice(0, 200000), lang);
    pane.append(bar, pre);
  };

  for (const [i, [label]] of files.entries()) {
    const b = el('button', null, label);
    b.setAttribute('aria-pressed', String(i === 0));
    b.onclick = () => show(i);
    tabs.append(b);
  }

  // What comes from where — the most important sentence on this page.
  const missing = el('div', 'notes');
  missing.append(el('div', 'bad', '· Isolated = the source page\'s original markup and original CSS. Analysis result, do not publish.'));
  if (m.code.rebuilt)
    missing.append(el('div', 'ok', '· Rebuild, React and Svelte = written from the measurement, without the source page\'s CSS. Independent.'));
  else
    missing.append(el('div', 'limit', '· There is no rebuild for this target — see the "Why no rebuild" tab.'));
  if (m.assets.length) missing.append(el('div', 'bad', '· ' + m.assets.length + ' third-party assets are only linked, not shipped'));
  if (m.fonts.length) missing.append(el('div', 'bad', '· the source page\'s fonts — check the licence before any reuse'));

  box.append(tabs, pane, missing);
  $('code').innerHTML = '';
  $('code').append(box);
  $('code-c').textContent = m.code.cssRules + ' CSS rules';
  await show(0);
};

// ── Results: everything already extracted ───────────────────────────────────
// parity's own results area. Every extraction stays here, can be reopened and
// exported individually — without another project.
let listFilter = 'all';

export const loadList = async () => {
  let list = [];
  try { list = await (await fetch('/api/extractions')).json(); } catch { return; }
  $('list-c').textContent = list.length ? list.length + ' saved' : '';
  if (!list.length) {
    $('list').innerHTML = '<div class="empty">Nothing extracted yet. Open a page above, click an element, start the analysis.</div>';
    return;
  }

  const box = el('div');

  // Filter by isolatability — that is the distinction that counts: what can be
  // reused, what is only documented.
  const counts = { all: list.length };
  for (const x of list) counts[x.isolatability] = (counts[x.isolatability] || 0) + 1;
  const chips = el('div', 'chips');
  for (const key of ['all', 'isolatable', 'partial', 'reference-only', 'not-analysable']) {
    if (key !== 'all' && !counts[key]) continue;
    const b = el('button', null, (key === 'all' ? 'All' : ISO_LABEL[key]?.[0] || key) + ' · ' + (counts[key] || 0));
    b.setAttribute('aria-pressed', String(key === listFilter));
    b.onclick = () => { listFilter = key; loadList(); };
    chips.append(b);
  }
  box.append(chips);

  const grid = el('div', 'results');
  const shown = list.filter(x => listFilter === 'all' || x.isolatability === listFilter);

  for (const x of shown) {
    const card = el('article', 'result');
    const b = '/extractions/' + x.slug;

    const thumbFile = x.previews?.rebuilt || x.previews?.isolated || x.previews?.original;
    const thumb = el('div', 'rthumb');
    if (thumbFile) {
      const img = el('img');
      img.src = b + '/' + thumbFile + '?t=' + Date.now();
      img.alt = '';
      img.loading = 'lazy';
      thumb.append(img);
    } else thumb.append(el('span', 'muted', 'no capture'));
    // The tile shows the rebuild if there is one — otherwise it has to say
    // that original code is shown here.
    thumb.append(el('span', 'rbadge ' + (x.previews?.rebuilt ? 'ok' : 'limit'),
      x.previews?.rebuilt ? 'rebuild' : x.previews?.isolated ? 'isolated' : 'original'));
    card.append(thumb);

    const body = el('div', 'rbody');
    const h = el('h3', null, x.title || x.slug);
    body.append(h);

    const meta = el('div', 'rmeta');
    meta.append(el('span', null, x.category));
    if ((x.triggers || []).length) meta.append(el('span', null, x.triggers.join(', ')));
    if (x.duration != null) meta.append(el('span', null, x.duration + 'ms'));
    const [isoText, isoCls] = ISO_LABEL[x.isolatability] || [x.isolatability, ''];
    meta.append(el('span', isoCls, isoText));
    meta.append(el('span', x.confidence >= .8 ? 'ok' : x.confidence >= .5 ? 'limit' : 'bad', 'Confidence ' + x.confidence));
    if (x.warnings) meta.append(el('span', 'limit', x.warnings + ' notes'));
    body.append(meta);

    try {
      body.append(el('div', 'rsrc', new URL(x.source).host + new URL(x.source).pathname));
    } catch { body.append(el('div', 'rsrc', x.source)); }

    const actions = el('div', 'ractions');
    const open = el('button', 'ghost', 'Open');
    open.onclick = () => { showResult(b); $('sec-info').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    actions.append(open);
    const link = (file, label) => {
      const a = el('a', 'ghostlink', label);
      a.href = b + '/' + file; a.download = '';
      return a;
    };
    if (x.code?.zip) actions.append(link(x.code.zip, 'ZIP'));
    if (x.previews?.video) actions.append(link(x.previews.video, 'Video'));
    if (x.code?.single) actions.append(link(x.code.single, 'Single file'));
    body.append(actions);

    card.append(body);
    grid.append(card);
  }

  box.append(grid);
  $('list').innerHTML = '';
  $('list').append(box);
};

const showResult = async base => {
  state.base = base;
  let m;
  try { m = await (await fetch(base + '/metadata.json?t=' + Date.now())).json(); }
  catch (e) { $('info').innerHTML = '<div class="pnote bad">metadata.json not readable: ' + esc(String(e)) + '</div>'; return; }
  state.meta = m;
  previewTab = m.code.rebuilt ? 'rebuilt' : m.previews.isolated ? 'isolated' : 'original';
  renderInfo(m);
  renderPreview(m);
  await renderCode(m);
  loadList();
};

// ── Event stream ────────────────────────────────────────────────────────────
export const handle = e => {
  switch (e.ev) {
    case 'inspect':
      if (e.status === 'start') { $('pick-c').textContent = 'fetching HTML…'; }
      if (e.status === 'ready') {
        $('inspect-empty').hidden = true;
        $('stage').hidden = false;
        const f = frame();
        wired = false;
        f.onload = () => wireFrame();
        f.src = e.frame + '?t=' + Date.now();
      }
      if (e.status === 'error') $('inspect-empty').textContent = 'The page could not be opened.';
      break;

    case 'extract':
      if (e.status === 'start') { resetSteps(); $('info-c').textContent = 'running'; }
      if (e.status === 'end')   { $('analyse').disabled = false; showResult(e.out); }
      if (e.status === 'error') { $('analyse').disabled = false; $('info').innerHTML = '<div class="pnote bad">Analysis failed — see the messages below.</div>'; }
      break;

    case 'step': {
      const b = stepEl[e.name];
      if (!b) break;
      b.dataset.s = 'done';
      const v = b.querySelector('.v');
      v.textContent =
        e.name === 'element' ? e.count + ' matches'
        : e.name === 'css' ? e.rules + ' rules'
        : e.name === 'js' ? (e.libs?.length ? e.libs.join(',') : e.listeners + ' listeners')
        : e.name === 'trigger' ? e.trigger
        : e.name === 'animation' ? (e.duration != null ? e.duration + 'ms' : (e.properties?.length ? e.properties.length + ' Props' : '—'))
        : e.name === 'isolatability' ? e.level
        : e.name === 'deps' ? (e.assets + ' Assets')
        : '✓';
      break;
    }

    case 'note':
      if (e.kind === 'extract') {
        let n = $('info').querySelector('.livenotes');
        if (!n) { n = el('div', 'notes livenotes'); $('info').append(n); }
        n.append(el('div', e.bad ? 'bad' : 'limit', '· ' + e.note));
      }
      break;
  }
};

// ── Start ───────────────────────────────────────────────────────────────────
export const init = () => {
  initPipeline();
  wireChips('scope-chips', 'scope');
  wireChips('trigger-chips', 'trigger');
  $('analyse').onclick = startAnalysis;
  loadList();
};
