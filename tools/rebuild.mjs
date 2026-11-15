// Rebuild — writes an independent version from a measurement.
//
// Usage: node tools/rebuild.mjs <extraction-dir> [--shot]
//
// The difference from vanilla/ is the whole point of this file:
//
//   vanilla/  = the source page's original markup and original CSS, cut out.
//               An analysis result. Must not be published.
//   rebuilt/  = newly written code from metadata.json. Does not know the
//               original CSS. Only measured values: duration, delay, easing,
//               start and end state, keyframe offsets, box values — and a
//               structure description (tag, role, text), no DOM copy.
//
// What cannot be rebuilt honestly is not rebuilt: NOT-REBUILT.md is written
// with the reason instead. A rebuild that passes the original off as its own
// work would be worse than none at all.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { emit } from './_emit.mjs';

const argv = process.argv.slice(2);
const DIR = argv[0];
const SHOT = argv.includes('--shot');
if (!DIR) {
  console.error('usage: node tools/rebuild.mjs <extraction-dir> [--shot]');
  process.exit(2);
}
const metaPath = join(DIR, 'metadata.json');
if (!existsSync(metaPath)) {
  console.error(`✗ ${metaPath} not found`);
  process.exit(1);
}
const m = JSON.parse(readFileSync(metaPath, 'utf8'));

// ── Can this be rebuilt honestly? ───────────────────────────────────────────
const blockers = [];
if (m.isolatability === 'reference-only') {
  // The reason for the grade, not the first warning that comes along. Font
  // licences are a note, but never the reason something cannot be rebuilt.
  const why = m.isolatabilityReasons?.length ? m.isolatabilityReasons : ['the runtime cannot be cut out.'];
  for (const r of why) blockers.push('Graded "reference only": ' + r);
}
if (m.isolatability === 'not-analysable')
  blockers.push('The target was not analysable.');
if (!m.structure)
  blockers.push('No structure description in the metadata — measured with an older version of extract. Please measure again.');
if (m.techniques?.some(t => ['webgl', 'canvas', 'three', 'rive'].includes(t)))
  blockers.push('The content comes from WebGL/canvas/Rive. What is drawn there is in no CSS rule.');

const props = Object.keys(m.states || {});
const kf = (m.timing?.keyframes || []).filter(k => k.offset != null);
const hasMotion = props.length > 0 || kf.length > 1;
if (!hasMotion && !blockers.length)
  blockers.push('Nothing changed on the measured trigger — there is no motion to rebuild. The static version is produced anyway.');

// Missing motion does not block, it only limits.
const hardBlocked = blockers.some(b => !b.startsWith('Nothing changed on the measured trigger'));

if (hardBlocked) {
  const md = `# Not rebuilt

**${m.title}** — \`${m.selector}\` on ${m.source}

No independent version is produced for this target:

${blockers.map(b => '- ' + b).join('\n')}

What there is instead:

- \`metadata.json\` — the complete measurement
- \`report.md\` — the readable report
- \`vanilla/\` — the isolated version with the source page's **original code**.
  Analysis result, not a component of yours. Do not publish.

An automatically generated replica would be guessed here, not measured.
`;
  writeFileSync(join(DIR, 'NOT-REBUILT.md'), md, 'utf8');
  for (const d of ['rebuilt', 'react', 'svelte']) rmSync(join(DIR, d), { recursive: true, force: true });
  m.code = { ...m.code, rebuilt: null, react: null, svelte: null };
  m.previews = { ...m.previews, rebuilt: null };
  if (m.status === 'rebuilt') m.status = 'isolated';
  writeFileSync(metaPath, JSON.stringify(m, null, 2), 'utf8');
  emit({ ev: 'done', cmd: 'rebuild', out: DIR, rebuilt: false, reasons: blockers, exit: 0 });
  console.log(`— ${m.title}: not rebuilt`);
  for (const b of blockers) console.log('  · ' + b);
  process.exit(0);
}

// ── Names that copy nothing ─────────────────────────────────────────────────
// Taking over the source page's class names would be copying. Only a small set
// of generic words is allowed — "title" belongs to nobody.
const GENERIC = new Set(['title', 'label', 'text', 'body', 'icon', 'image', 'media', 'header',
  'footer', 'content', 'inner', 'wrap', 'wrapper', 'item', 'link', 'button', 'badge', 'meta', 'caption']);
const ROOT = (m.slug || 'component').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'component';

const nameOf = (node, i, seen) => {
  const generic = (node.semantic || []).find(c => GENERIC.has(c.toLowerCase()));
  let base = generic ? generic.toLowerCase()
    : node.role ? node.role
    : { a: 'link', img: 'image', button: 'button', p: 'text', span: 'text',
        h1: 'title', h2: 'title', h3: 'title', h4: 'title', ul: 'list', li: 'item',
        svg: 'icon', figure: 'media', video: 'media' }[node.tag] || 'part';
  let name = base;
  let n = 2;
  while (seen.has(name)) name = base + '-' + n++;
  seen.add(name);
  return name;
};

// ── Markup ──────────────────────────────────────────────────────────────────
const VOID = new Set(['img', 'br', 'hr', 'input', 'source']);
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const buildMarkup = (node, cls, depth, classAttr) => {
  const pad = '  '.repeat(depth);
  const tag = /^[a-z][a-z0-9]*$/.test(node.tag) ? node.tag : 'div';
  const attrs = [`${classAttr}="${cls}"`];
  if (node.role) attrs.push(`role="${node.role}"`);
  if (node.label) attrs.push(`aria-label="${esc(node.label)}"`);
  if (tag === 'a') attrs.push('href="#"');
  if (tag === 'img') attrs.push(`src="" alt="${esc(node.label || '')}"`);
  if (VOID.has(tag)) return `${pad}<${tag} ${attrs.join(' ')}>`;

  const seen = new Set();
  const kids = (node.children || []).map((c, i) =>
    buildMarkup(c, cls + '__' + nameOf(c, i, seen), depth + 1, classAttr));
  const inner = [node.text ? '  '.repeat(depth + 1) + esc(node.text) : null, ...kids].filter(Boolean).join('\n');
  return inner
    ? `${pad}<${tag} ${attrs.join(' ')}>\n${inner}\n${pad}</${tag}>`
    : `${pad}<${tag} ${attrs.join(' ')}></${tag}>`;
};

// ── CSS from the measured values ────────────────────────────────────────────
// Only values that say something. Writing the browser defaults back out
// bloats the result and explains nothing.
const DEFAULT = {
  display: 'inline', 'flex-direction': 'row', 'align-items': 'normal', 'justify-content': 'normal',
  gap: 'normal', padding: '0px', margin: '0px', width: 'auto', height: 'auto', 'min-height': '0px',
  'max-width': 'none', 'box-sizing': 'content-box', 'background-color': 'rgba(0, 0, 0, 0)',
  border: 'none', 'border-radius': '0px', 'box-shadow': 'none', 'font-weight': '400',
  'letter-spacing': 'normal', 'text-transform': 'none', 'text-align': 'start',
  'text-decoration-line': 'none', opacity: '1', transform: 'none', overflow: 'visible',
  position: 'static', cursor: 'auto', 'white-space': 'normal',
};
// Size is layout, not a component property. The measured width of a block
// element is its parent's width at a 1440px viewport — writing it into a
// rebuild freezes a foreign page's layout and makes the component unusable.
// Only what the source page declares itself is taken over (e.g. a 64px circle).
const LAYOUT_ONLY = new Set(['width', 'height', 'max-width', 'min-height', 'margin']);
const declared = new Set(m.declaredBoxProps || []);
const isLayoutNoise = k => LAYOUT_ONLY.has(k) && !declared.has(k);

// display:block is the default for div/section/p — writing it explains
// nothing. For inline elements made into blocks, it does.
const BLOCKISH = new Set(['div', 'section', 'article', 'header', 'footer', 'main', 'nav', 'p', 'h1', 'h2', 'h3', 'h4', 'ul', 'li', 'figure']);

const meaningful = (k, v) => {
  if (!v || v === 'none' || v === 'auto' || v === 'normal' || v === DEFAULT[k]) return false;
  if (isLayoutNoise(k)) return false;
  if (k === 'display' && v === 'block' && BLOCKISH.has(m.structure?.tag)) return false;
  if (k === 'border' && /0px/.test(v)) return false;
  if (/^0px(\s+0px)*$/.test(v)) return false;
  return true;
};

// matrix(a,b,c,d,e,f) is correct and unreadable. Whoever touches the rebuild
// later should see translateY(-12px) scale(1.03), not six numbers.
const readableTransform = v => {
  const mm = /^matrix\(([^)]+)\)$/.exec(String(v).trim());
  if (!mm) return v;
  const [a, b, c, d, e, f] = mm[1].split(',').map(Number);
  if ([a, b, c, d, e, f].some(n => !Number.isFinite(n))) return v;
  const round = n => Math.abs(n) < 1e-4 ? 0 : Math.round(n * 1000) / 1000;
  const scaleX = round(Math.hypot(a, b));
  const scaleY = round((a * d - b * c) / (Math.hypot(a, b) || 1));
  const rotate = round((Math.atan2(b, a) * 180) / Math.PI);
  const out = [];
  if (round(e) || round(f)) out.push(round(f) && !round(e) ? `translateY(${round(f)}px)`
    : round(e) && !round(f) ? `translateX(${round(e)}px)`
    : `translate(${round(e)}px, ${round(f)}px)`);
  if (rotate) out.push(`rotate(${rotate}deg)`);
  if (scaleX !== 1 || scaleY !== 1) out.push(scaleX === scaleY ? `scale(${scaleX})` : `scale(${scaleX}, ${scaleY})`);
  return out.length ? out.join(' ') : 'none';
};

const value = (k, v) => (k === 'transform' ? readableTransform(v) : v);

// keepAll for state and keyframe rules. There the default value is the
// statement: "opacity: 1" and "transform: none" ARE the target of a reveal.
// Filtering them as noise yields an empty rule — and with it a rebuild that
// never makes the element visible.
const declBlock = (obj, indent = '  ', keepAll = false) => Object.entries(obj)
  .filter(([k, v]) => v != null && v !== '' && (keepAll || meaningful(k, v)))
  .map(([k, v]) => `${indent}${k}: ${value(k, v)};`).join('\n');

const dur = m.timing?.durationMs ?? 400;
const delay = m.timing?.delayMs ?? 0;
const easing = (m.easing || []).find(e => e && e !== 'ease' && e !== 'linear')
  || (m.easing || [])[0] || 'ease';
const iterations = m.timing?.loops ? 'infinite' : 1;
const trigger = (m.triggers || ['load'])[0];
const io = m.dependencies?.intersectionObservers?.[0];

// The start state is the measured from value, the target state the to value.
const fromDecl = {}, toDecl = {};
for (const [p, s] of Object.entries(m.states || {})) {
  if (meaningful(p, s.from) || s.from === '0' || /^0(\.\d+)?$/.test(s.from)) fromDecl[p] = s.from;
  toDecl[p] = s.to;
}

const keyframeBlock = () => {
  if (kf.length > 1) {
    // Real offsets from the engine.
    return kf.map(k => {
      const body = Object.entries(k)
        .filter(([key, v]) => !['offset', 'easing', 'composite', 'computedOffset'].includes(key) && v != null)
        .map(([key, v]) => `    ${key}: ${v};`).join('\n');
      return `  ${Math.round((k.offset ?? 0) * 100)}% {\n${body}\n  }`;
    }).join('\n');
  }
  const a = declBlock(fromDecl, '    ', true), b = declBlock(toDecl, '    ', true);
  return `  from {\n${a}\n  }\n  to {\n${b}\n  }`;
};

// For click/scroll/drag a class carries the state — CSS alone cannot, and a
// rebuild should not pretend it can.
const STATE_CLASS = { click: 'is-active', touch: 'is-active', scroll: 'is-visible', drag: 'is-active', pointer: 'is-active', idle: 'is-active', focus: null, hover: null, load: null, loop: null };
const stateClass = STATE_CLASS[trigger] ?? 'is-active';

const stateSelector =
  trigger === 'hover' ? `.${ROOT}:hover`
  : trigger === 'focus' ? `.${ROOT}:focus-visible, .${ROOT}:focus`
  : stateClass ? `.${ROOT}.${stateClass}`
  : null;

const usesKeyframes = trigger === 'loop' || trigger === 'load' || (!stateSelector && hasMotion);

// Every property needs its own timing. "transform, opacity 420ms ease" is
// valid CSS syntax and still wrong: only opacity would get the 420ms,
// transform would run with the default 0s — that is, not at all.
const transitionValue = props
  .map(p => `${p} ${dur}ms ${easing}${delay ? ' ' + delay + 'ms' : ''}`)
  .join(',\n              ');

// Under prefers-reduced-motion take away only the motion, not the content.
// For a reveal (start state invisible) the end state must be set, otherwise
// the element stays hidden for good. For a hover effect exactly that would be
// wrong — the card would then sit permanently in its hover state.
const revealsIntoView = ['scroll', 'load'].includes(trigger)
  && (parseFloat(fromDecl.opacity ?? '1') === 0 || (fromDecl.visibility === 'hidden'));

const baseBox = { ...m.box };
for (const k of Object.keys(fromDecl)) delete baseBox[k];
const baseDecl = [
  declBlock(baseBox),
  usesKeyframes ? '' : declBlock(fromDecl, '  ', true),
].filter(Boolean).join('\n');

// The demo page background follows the measured text colour. An element from
// a dark page brings light text along; on a white background the preview is
// then unreadable and the extraction looks broken although it is right. A
// background on the element itself beats both.
const demoBackground = (() => {
  const own = m.box?.['background-color'];
  if (own && own !== 'rgba(0, 0, 0, 0)' && !/^rgba\(.*,\s*0\)$/.test(own)) return '#f5f5f5';
  const rgb = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(m.box?.color || '');
  if (!rgb) return '#f5f5f5';
  const [r, g, b] = rgb.slice(1).map(Number);
  // Perceptually weighted luminance, not the arithmetic mean: green
  // contributes far more to perceived brightness than blue.
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.6 ? '#111111' : '#f5f5f5';
})();

const rmComment = m.reducedMotion?.respected === false
  ? 'The source page ignores prefers-reduced-motion. This rebuild does not.'
  : 'prefers-reduced-motion is respected, as in the source page.';

const css = `/* ${m.title} — independent rebuild.
 *
 * Written from the measurement in metadata.json, not from the source page's
 * CSS. The values below come from:
 *   Duration ${m.timing?.durationMs ?? '—'}ms  (${m.timing?.durationSource ?? '—'})
 *   Delay   ${m.timing?.delayMs ?? 0}ms
 *   Easing  ${easing}
 *   Trigger ${trigger}
 */

.${ROOT} {
${baseDecl}
${props.length && !usesKeyframes ? `  transition: ${transitionValue};` : ''}
${usesKeyframes && hasMotion ? `  animation: ${ROOT}-motion ${dur}ms ${easing}${delay ? ' ' + delay + 'ms' : ''} ${iterations}${m.timing?.declared?.direction && m.timing.declared.direction !== 'normal' ? ' ' + m.timing.declared.direction : ''} both;` : ''}
}
${stateSelector && !usesKeyframes ? `
${stateSelector} {
${declBlock(toDecl, '  ', true)}
}` : ''}
${usesKeyframes && hasMotion ? `
@keyframes ${ROOT}-motion {
${keyframeBlock()}
}` : ''}

/* ${rmComment} */
@media (prefers-reduced-motion: reduce) {
  .${ROOT} {
    transition-duration: 0.01ms;
    animation-duration: 0.01ms;
    animation-iteration-count: 1;
  }
${revealsIntoView ? `
  /* A reveal without animation must still be visible — otherwise reduced
     motion hides the content instead of only taking away the motion. */
  .${ROOT} {
${declBlock(toDecl, '    ', true)}
  }` : ''}
}
`.replace(/\n{3,}/g, '\n\n').replace(/\n\s*\n(\s*\})/g, '\n$1');

// ── Output ──────────────────────────────────────────────────────────────────
mkdirSync(join(DIR, 'rebuilt'), { recursive: true });
mkdirSync(join(DIR, 'react'), { recursive: true });
mkdirSync(join(DIR, 'svelte'), { recursive: true });
rmSync(join(DIR, 'NOT-REBUILT.md'), { force: true });

const htmlMarkup = buildMarkup(m.structure, ROOT, 2, 'class');
const needsJs = !!stateClass && stateClass !== null && !['hover', 'focus', 'load', 'loop'].includes(trigger);

const js = !needsJs ? `// Trigger "${trigger}" needs no JavaScript — the CSS carries the state.
// This file stays empty so index.html works unchanged.
` : trigger === 'scroll' ? `// Scroll reveal. Measured: IntersectionObserver with threshold ${io?.threshold ?? 0.25}${io?.rootMargin ? ', rootMargin "' + io.rootMargin + '"' : ''}.
// Once only — after revealing, it is no longer observed.
const io = new IntersectionObserver((entries, obs) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    e.target.classList.add('${stateClass}');
    obs.unobserve(e.target);
  }
}, { threshold: ${JSON.stringify(io?.threshold ?? 0.25)}, rootMargin: ${JSON.stringify(io?.rootMargin ?? '0px')} });

for (const el of document.querySelectorAll('.${ROOT}')) io.observe(el);
` : `// State change on ${trigger}.
for (const el of document.querySelectorAll('.${ROOT}')) {
  el.addEventListener('${trigger === 'touch' ? 'pointerdown' : trigger === 'drag' ? 'pointerdown' : 'click'}', () => {
    el.classList.toggle('${stateClass}');
  });
}
`;

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(m.title)} — parity rebuilt</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html, body { margin: 0; padding: 0; }
  body { display: grid; place-items: center; min-height: 100vh;
         background: ${demoBackground}; }
  #stage { padding: 60px; }
</style>
<link rel="stylesheet" href="style.css">
</head>
<body>
<div id="stage">
${htmlMarkup}
</div>
<!-- Classic script, not a module: type="module" is blocked by the CORS rule
     when opened via file://, and then the demo is dead as soon as someone
     downloads it and double-clicks. -->
<script src="script.js"></script>
<script>
  // The same remote control as the isolated preview, so the interface can
  // drive both the same way.
  const target = document.querySelector('.${ROOT}');
  const anims = () => (target ? target.getAnimations({ subtree: true }) : []);
  const api = {
    play: () => anims().forEach(a => a.play()),
    pause: () => anims().forEach(a => a.pause()),
    restart: () => anims().forEach(a => { a.cancel(); a.play(); }),
    reset: () => { anims().forEach(a => a.cancel()); target?.classList.remove('${stateClass || 'is-active'}'); },
    rate: v => anims().forEach(a => { a.playbackRate = Number(v) || 1; }),
    fire: () => {
${trigger === 'hover' ? `      target?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));`
  : trigger === 'focus' ? `      target?.focus();`
  : stateClass ? `      target?.classList.toggle('${stateClass}');`
  : `      api.restart();`}
    },
  };
  window.parityPreview = api;
  window.addEventListener('message', e => {
    const c = e.data && e.data.parity;
    if (c && typeof api[c.cmd] === 'function') api[c.cmd](c.arg);
  });
</script>
</body>
</html>`;

writeFileSync(join(DIR, 'rebuilt/index.html'), page, 'utf8');
writeFileSync(join(DIR, 'rebuilt/style.css'), css, 'utf8');
writeFileSync(join(DIR, 'rebuilt/script.js'), js, 'utf8');

// ── React ───────────────────────────────────────────────────────────────────
const pascal = ROOT.split('-').map(s => s[0].toUpperCase() + s.slice(1)).join('') || 'Component';
const jsxMarkup = buildMarkup(m.structure, ROOT, 2, 'className');

// A ref only where it is needed. An unused useRef is ballast every reader
// first has to recognise as such.
const usesRef = trigger === 'scroll';
const reactHooks = trigger === 'scroll' ? ['useEffect', 'useRef', 'useState']
  : needsJs ? ['useState'] : [];

const reactBody =
  trigger === 'scroll' ? `  const ref = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Measured: IntersectionObserver, threshold ${io?.threshold ?? 0.25}${io?.rootMargin ? ', rootMargin "' + io.rootMargin + '"' : ''}.
    const obs = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      setVisible(true);
      obs.unobserve(el);
    }, { threshold: ${JSON.stringify(io?.threshold ?? 0.25)}, rootMargin: ${JSON.stringify(io?.rootMargin ?? '0px')} });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
`
  : needsJs ? `  const [active, setActive] = useState(false);
` : '';

const reactCls = trigger === 'scroll' ? `\`${ROOT}\${visible ? ' ${stateClass}' : ''}\``
  : needsJs ? `\`${ROOT}\${active ? ' ${stateClass}' : ''}\``
  : `"${ROOT}"`;

const rootAttrs = [
  `className={${reactCls}}`.replace('className={"' + ROOT + '"}', `className="${ROOT}"`),
  usesRef ? 'ref={ref}' : null,
  needsJs && trigger !== 'scroll' ? `onClick={() => setActive(a => !a)}` : null,
].filter(Boolean).join(' ');

const jsx = `// ${m.title} — independent rebuild, React.
// Written from the measurement in metadata.json. Trigger: ${trigger}.
${reactHooks.length ? `import { ${reactHooks.join(', ')} } from 'react';\n` : ''}import './styles.css';

export default function ${pascal}() {
${reactBody}  return (
${jsxMarkup.replace(`class="${ROOT}"`, rootAttrs).replace(new RegExp(`className="${ROOT}"(?![-\\w])`), rootAttrs).replace(/^/gm, '  ')}
  );
}
`;
writeFileSync(join(DIR, 'react/Component.jsx'), jsx, 'utf8');
writeFileSync(join(DIR, 'react/styles.css'), css, 'utf8');

// ── Svelte ──────────────────────────────────────────────────────────────────
const svelteScript =
  trigger === 'scroll' ? `<script>
  import { onMount } from 'svelte';
  let el;
  let visible = false;

  onMount(() => {
    const io = new IntersectionObserver(([e], obs) => {
      if (!e.isIntersecting) return;
      visible = true;
      obs.unobserve(el);
    }, { threshold: ${JSON.stringify(io?.threshold ?? 0.25)}, rootMargin: ${JSON.stringify(io?.rootMargin ?? '0px')} });
    io.observe(el);
    return () => io.disconnect();
  });
</script>`
  : needsJs ? `<script>
  let el;
  let active = false;
</script>`
  : `<script>
  let el;
</script>`;

const svelteCls = trigger === 'scroll' ? `class="${ROOT}" class:${stateClass}={visible} bind:this={el}`
  : needsJs ? `class="${ROOT}" class:${stateClass}={active} bind:this={el} on:click={() => (active = !active)}`
  : `class="${ROOT}" bind:this={el}`;

const svelte = `<!-- ${m.title} — independent rebuild, Svelte. Trigger: ${trigger}. -->
${svelteScript}

${buildMarkup(m.structure, ROOT, 0, 'class').replace(`class="${ROOT}"`, svelteCls)}

<style>
${css.replace(/^/gm, '  ')}
</style>
`;
writeFileSync(join(DIR, 'svelte/Component.svelte'), svelte, 'utf8');

// ── Update the metadata ─────────────────────────────────────────────────────
m.code = { ...m.code, rebuilt: 'rebuilt/index.html', react: 'react/Component.jsx', svelte: 'svelte/Component.svelte' };
m.rebuild = {
  root: ROOT,
  trigger,
  stateClass: stateClass || null,
  technique: usesKeyframes ? 'css-keyframes' : stateSelector ? 'css-transition' : 'static',
  needsJs,
  fromMeasurement: true,
  animated: hasMotion,
  notes: [
    'Written from metadata.json, not from the source page\'s CSS.',
    ...(hasMotion ? [] : ['No measured motion — only the static state.']),
    ...(m.reducedMotion?.respected === false ? ['prefers-reduced-motion is respected here, unlike the original.'] : []),
    ...(m.assets?.length ? [m.assets.length + ' images/media are empty in the rebuild — third-party assets are not taken over.'] : []),
    ...(m.dependencies?.libraries?.length ? ['The source page uses ' + m.dependencies.libraries.join(', ') + '. The rebuild does without; the result may differ.'] : []),
  ],
};
if (m.status === 'isolated' || m.status === 'inspected') m.status = 'rebuilt';

// ── Capture ─────────────────────────────────────────────────────────────────
if (SHOT) {
  const { chromium } = await import('playwright');
  const b = await chromium.launch();
  try {
    const p = await b.newPage({ viewport: { width: 1000, height: 700 } });
    await p.goto(pathToFileURL(resolvePath(DIR, 'rebuilt/index.html')).href, { waitUntil: 'load', timeout: 20000 });
    await p.waitForTimeout(1200);
    if (stateClass) await p.evaluate(c => document.querySelector('.' + c.root)?.classList.add(c.cls), { root: ROOT, cls: stateClass });
    else if (trigger === 'hover') await p.locator('.' + ROOT).first().hover().catch(() => {});
    await p.waitForTimeout(Math.min(1500, dur + 300));
    await p.locator('#stage').screenshot({ path: join(DIR, 'preview-rebuilt.png'), timeout: 8000 });
    m.previews = { ...m.previews, rebuilt: 'preview-rebuilt.png' };
    emit({ ev: 'shot', cmd: 'rebuild', mark: 'preview-rebuilt', path: join(DIR, 'preview-rebuilt.png') });
  } catch (e) {
    m.rebuild.notes.push('Capturing the rebuild preview failed: ' + String(e).slice(0, 100));
  } finally { await b.close(); }
}

writeFileSync(metaPath, JSON.stringify(m, null, 2), 'utf8');

emit({
  ev: 'done', cmd: 'rebuild', out: DIR, rebuilt: true, root: ROOT, trigger,
  technique: m.rebuild.technique, animated: hasMotion, exit: 0,
});
console.log(`✓ ${DIR}`);
console.log(`  rebuilt/ · react/ · svelte/  —  .${ROOT}, Trigger ${trigger}, ${m.rebuild.technique}`);
for (const n of m.rebuild.notes.slice(1)) console.log('  · ' + n);
