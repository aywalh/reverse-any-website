// Showcase — a readable page built from an extraction.
//
// Usage: node tools/showcase.mjs <extraction-dir> [--serve [port]]
//
// The interface's results area is for working. This one is for showing: a
// page assembled from metadata.json and whatever is in the directory, showing
// what was found — video, captures, 3D models, sounds, measurements, code.
//
// It also says what is NOT in there. A showcase page presenting a
// reference-only extraction like a finished component would be the one lie
// this whole tool is meant to avoid.
//
// Needs a server (modules and import map): --serve starts one right away.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { emit } from './_emit.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const DIR = argv[0];
if (!DIR) { console.error('usage: node tools/showcase.mjs <extraction-dir> [--serve [port]]'); process.exit(2); }
const metaPath = join(DIR, 'metadata.json');
if (!existsSync(metaPath)) { console.error(`✗ ${metaPath} not found`); process.exit(1); }
const m = JSON.parse(readFileSync(metaPath, 'utf8'));

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const kb = n => n < 1024 * 1024 ? Math.round(n / 1024) + ' KB' : (Math.round(n / 1024 / 102.4) / 10) + ' MB';
const has = f => f && existsSync(join(DIR, f));

// ── What is in the directory ────────────────────────────────────────────────
const assetDir = join(DIR, 'assets');
const assets = existsSync(assetDir)
  ? readdirSync(assetDir).map(f => ({ f, ext: extname(f).slice(1).toLowerCase(), size: statSync(join(assetDir, f)).size }))
  : [];
// Alphabetical, not by size: the order should be predictable, and the viewer
// starts with the first entry. Sorting by size loads some side piece first.
const models = assets.filter(a => a.ext === 'glb' || a.ext === 'gltf').sort((a, b) => a.f.localeCompare(b.f));
const sounds = assets.filter(a => ['mp3', 'ogg', 'wav', 'm4a'].includes(a.ext)).sort((a, b) => a.f.localeCompare(b.f));
const other = assets.filter(a => !models.includes(a) && !sounds.includes(a));

// Which models load without extra decoders — that decides what the viewer
// can actually show.
for (const mo of models) {
  try {
    const b = readFileSync(join(assetDir, mo.f));
    const j = JSON.parse(b.slice(20, 20 + b.readUInt32LE(12)).toString('utf8'));
    mo.ext_used = j.extensionsUsed || [];
    mo.meshes = (j.meshes || []).length;
    mo.draco = mo.ext_used.some(e => /draco/i.test(e));
    mo.basis = mo.ext_used.some(e => /basisu|webp/i.test(e));
  } catch { mo.ext_used = []; mo.meshes = 0; }
}

const ISO = {
  isolatable: ['isolatable', 'ok'],
  partial: ['partially isolatable', 'limit'],
  'reference-only': ['documentable as reference only', 'limit'],
  'not-analysable': ['not analysable', 'bad'],
};
const [isoText, isoCls] = ISO[m.isolatability] || [m.isolatability, ''];

// ── What is in it, what is not ──────────────────────────────────────────────
// The honest balance. It sits at the top, not in the small print.
const gotIt = [], missing = [];
if (has(m.previews?.video)) gotIt.push('recording in motion' + (m.previews.videoShows === 'original' ? ' (of the original page)' : ''));
if (has(m.previews?.original)) gotIt.push('captures of the original');
if (models.length) gotIt.push(models.length + ' 3D model' + (models.length > 1 ? 's' : ''));
if (sounds.length) gotIt.push(sounds.length + ' sound file' + (sounds.length > 1 ? 's' : ''));
gotIt.push('complete measurement as JSON');
if (m.code?.rebuilt) gotIt.push('independent rebuild (HTML/CSS/JS, React, Svelte)');
else gotIt.push('isolated version with original code (analysis result)');

if (!m.code?.rebuilt) {
  missing.push('No independent rebuild — ' + (m.isolatabilityReasons?.[0] || 'the target is not isolatable.'));
}
if (m.techniques?.includes('webgl') || m.techniques?.includes('canvas')) {
  missing.push('No game logic, physics or shaders. What happens on the canvas lives in the source page\'s bundled JavaScript, not in CSS.');
}
if (models.some(x => x.draco || x.basis)) missing.push('The models are Draco-compressed and use KTX2 textures. The viewer below decodes both; outside of it the same decoders are needed.');
if (m.assets?.length) missing.push('The source page\'s fonts and images are not copied along, only linked.');

const card = (label, value, cls = '') => value == null || value === '' ? '' :
  `<div class="kv"><b>${esc(label)}</b><span class="${cls}">${value}</span></div>`;

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(m.title)} — parity showcase</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root {
  --bg:#0A0A0A; --fg:#FAFAFA; --muted:#8A8A8A; --line:#1E1E1E; --panel:#0F0F0F;
  --ok:#4ADE80; --bad:#F87171; --limit:#FACC15; --seam:4px;
  --mono: ui-monospace,"Cascadia Mono",Consolas,"SF Mono",Menlo,monospace;
}
@media (prefers-color-scheme: light){:root{--bg:#FAFAFA;--fg:#0A0A0A;--muted:#737373;--line:#E5E5E5;--panel:#FFF}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.6 var(--mono);
     font-variant-ligatures:none;-webkit-font-smoothing:antialiased}
.wrap{max-width:1100px;margin:0 auto;padding:0 24px 80px}

header{display:flex;align-items:center;gap:14px;padding:22px 0;border-bottom:1px solid var(--line);margin-bottom:32px}
header svg rect{fill:var(--fg)}
header .name{font:600 26px/1 var(--mono);letter-spacing:-.02em}
header .sub{margin-left:auto;color:var(--muted);font-size:11px}

h1{font-size:26px;margin:0 0 6px;letter-spacing:-.02em}
.src{color:var(--muted);font-size:12px;margin-bottom:18px;word-break:break-all}
.src a{color:var(--muted)}

.badges{display:flex;gap:var(--seam);flex-wrap:wrap;margin-bottom:34px}
.badge{border:1px solid var(--line);padding:5px 10px;border-radius:2px;font-size:11px;color:var(--muted)}
.badge.ok{color:var(--ok);border-color:var(--ok)}
.badge.limit{color:var(--limit);border-color:var(--limit)}
.badge.bad{color:var(--bad);border-color:var(--bad)}

section{margin-bottom:40px}
h2{font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);
   margin:0 0 14px;padding-bottom:8px;border-bottom:1px solid var(--line)}

.balance{display:grid;gap:20px;grid-template-columns:1fr}
@media(min-width:820px){.balance{grid-template-columns:1fr 1fr}}
.balance ul{margin:0;padding-left:18px}
.balance li{margin-bottom:6px}
.balance h3{font-size:12px;margin:0 0 10px;letter-spacing:.04em}
.balance .yes h3{color:var(--ok)} .balance .no h3{color:var(--limit)}
.balance .no li{color:var(--muted)}

video,.shot img{width:100%;display:block;border:1px solid var(--line);border-radius:2px;background:#000}
.shots{display:grid;gap:12px;grid-template-columns:1fr}
@media(min-width:820px){.shots{grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}}
.shot figcaption{color:var(--muted);font-size:11px;margin-top:6px}
figure{margin:0}

#viewer{height:460px;border:1px solid var(--line);border-radius:2px;background:var(--panel);
        position:relative;overflow:hidden}
#viewer canvas{display:block;width:100%;height:100%}
#vmsg{position:absolute;inset:0;display:grid;place-items:center;text-align:center;
      color:var(--muted);font-size:12px;padding:24px;pointer-events:none}
.models{display:flex;gap:var(--seam);flex-wrap:wrap;margin-bottom:12px}
.models button{background:transparent;color:var(--muted);border:1px solid var(--line);
  font:inherit;font-size:11px;padding:5px 10px;border-radius:2px;cursor:pointer}
.models button:hover{color:var(--fg);border-color:var(--muted)}
.models button[aria-pressed=true]{background:var(--fg);color:var(--bg);border-color:var(--fg);font-weight:600}
.models button .n{opacity:.6;margin-left:6px}

table{width:100%;border-collapse:collapse;font-size:12px}
td,th{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{color:var(--muted);font-weight:400;font-size:10px;letter-spacing:.08em;text-transform:uppercase}
tr:last-child td{border-bottom:0}
td.num{text-align:right;color:var(--muted);white-space:nowrap}

.sounds{display:grid;gap:10px;grid-template-columns:1fr}
@media(min-width:820px){.sounds{grid-template-columns:1fr 1fr}}
.snd{border:1px solid var(--line);border-radius:2px;padding:10px 12px}
.snd .nm{font-size:11px;margin-bottom:8px;word-break:break-all}
.snd audio{width:100%;height:32px}

.kv{display:grid;grid-template-columns:190px 1fr;gap:10px;padding:6px 0;
    border-bottom:1px solid var(--line);font-size:12px}
.kv:last-child{border-bottom:0}
.kv b{color:var(--muted);font-weight:400}
.kv .ok{color:var(--ok)} .kv .limit{color:var(--limit)} .kv .bad{color:var(--bad)}

pre{margin:0;padding:12px;background:var(--panel);border:1px solid var(--line);border-radius:2px;
    overflow:auto;max-height:400px;font-size:11px;line-height:1.6}

.dl{display:flex;gap:8px;flex-wrap:wrap}
.dl a{color:var(--fg);border:1px solid var(--line);padding:6px 12px;border-radius:2px;
      text-decoration:none;font-size:11px}
.dl a:hover{border-color:var(--muted)}

.warn{border-left:2px solid var(--limit);padding:10px 14px;color:var(--muted);font-size:11px;
      background:var(--panel);border-radius:2px}
footer{border-top:1px solid var(--line);padding-top:18px;color:var(--muted);font-size:11px}
</style>
</head>
<body>
<div class="wrap">

<header>
  <svg width="26" height="26" viewBox="0 0 64 64" role="img" aria-label="parity">
    <rect x="8" y="8" width="22" height="48"/><rect x="34" y="8" width="22" height="48"/>
  </svg>
  <span class="name">parity</span>
  <span class="sub">Selective Extraction · ${esc(new Date(m.createdAt).toLocaleDateString('en-US'))}</span>
</header>

<h1>${esc(m.title)}</h1>
<div class="src">Measured from <a href="${esc(m.source)}" target="_blank" rel="noreferrer noopener">${esc(m.source)}</a> · <code>${esc(m.selector)}</code></div>

<div class="badges">
  <span class="badge">${esc(m.category)}</span>
  ${(m.triggers || []).map(t => `<span class="badge">Trigger: ${esc(t)}</span>`).join('')}
  <span class="badge ${isoCls}">${esc(isoText)}</span>
  <span class="badge ${m.confidence >= .8 ? 'ok' : m.confidence >= .5 ? 'limit' : 'bad'}">Confidence ${m.confidence}</span>
  ${(m.techniques || []).map(t => `<span class="badge">${esc(t)}</span>`).join('')}
</div>

<section>
  <h2>Balance</h2>
  <div class="balance">
    <div class="yes"><h3>What is here</h3><ul>${gotIt.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>
    <div class="no"><h3>What is not</h3><ul>${missing.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>
  </div>
</section>

${has(m.previews?.video) ? `<section>
  <h2>In motion${m.previews.videoShows === 'original' ? ' — recording of the original page' : ''}</h2>
  <video src="${esc(m.previews.video)}" controls loop muted playsinline></video>
  ${m.previews.videoShows === 'original'
    ? '<p class="warn">Recorded from the running original page. An isolated version would be an empty rectangle here — the content only comes into being at runtime in the canvas.</p>'
    : ''}
</section>` : ''}

${[m.previews?.original, m.previews?.originalAfter, m.previews?.isolated, m.previews?.rebuilt].some(has) ? `<section>
  <h2>Captures</h2>
  <div class="shots">
    ${[[m.previews?.original, 'Original, before the trigger'],
       [m.previews?.originalAfter, 'Original, after the trigger'],
       [m.previews?.isolated, 'Isolated — original code, reduced to the target'],
       [m.previews?.rebuilt, 'Rebuild — written from the measurement']]
      .filter(([f]) => has(f))
      .map(([f, cap]) => `<figure class="shot"><img src="${esc(f)}" alt="${esc(cap)}" loading="lazy"><figcaption>${esc(cap)}</figcaption></figure>`)
      .join('')}
  </div>
</section>` : ''}

${models.length ? `<section>
  <h2>3D models <span style="float:right;text-transform:none;letter-spacing:0">${models.length} files · ${kb(models.reduce((a, b) => a + b.size, 0))}</span></h2>
  <div class="models">
    ${models.map((x, i) => `<button data-src="assets/${esc(x.f)}" data-draco="${x.draco ? 1 : 0}" aria-pressed="${i === 0}">${esc(x.f.replace(/-\w{8}\.glb$/, ''))}<span class="n">${x.meshes}</span></button>`).join('')}
  </div>
  <div id="viewer"><div id="vmsg">Loading viewer…</div></div>
  <p class="warn">Drag to rotate, wheel to zoom. Draco geometry and KTX2 textures are decoded in the browser; models without a texture get a neutral material so the shape stays visible.</p>
  <table>
    <thead><tr><th>File</th><th>Meshes</th><th>Extensions</th><th class="num">Size</th></tr></thead>
    <tbody>${models.map(x => `<tr>
      <td><a href="assets/${esc(x.f)}" download style="color:inherit">${esc(x.f)}</a></td>
      <td>${x.meshes}</td>
      <td style="color:var(--muted);font-size:11px">${esc((x.ext_used || []).join(', ') || '—')}</td>
      <td class="num">${kb(x.size)}</td></tr>`).join('')}</tbody>
  </table>
</section>` : ''}

${sounds.length ? `<section>
  <h2>Sounds <span style="float:right;text-transform:none;letter-spacing:0">${sounds.length} files</span></h2>
  <div class="sounds">
    ${sounds.map(x => `<div class="snd">
      <div class="nm">${esc(x.f.replace(/-\w{8}\.\w+$/, ''))} <span style="color:var(--muted)">${kb(x.size)}</span></div>
      <audio src="assets/${esc(x.f)}" controls preload="none"></audio>
    </div>`).join('')}
  </div>
</section>` : ''}

<section>
  <h2>Measurement</h2>
  ${card('DOM path', `<code style="font-size:11px;color:var(--muted);word-break:break-all">${esc(m.domPath)}</code>`)}
  ${card('Trigger', esc((m.triggers || []).join(', ')))}
  ${card('Technique', esc((m.techniques || []).join(', ') || '—'))}
  ${card('Libraries', esc((m.dependencies?.libraries || []).join(', ') || 'none detected on window'))}
  ${card('Duration', m.timing?.durationMs != null
      ? `${m.timing.durationMs}ms <span style="color:var(--muted)">(${esc(m.timing.durationSource)})</span>`
      : '<span style="color:var(--muted)">no measurable duration</span>')}
  ${card('Easing', esc((m.easing || []).join(' · ') || '—'))}
  ${card('Animated properties', esc((m.properties || []).join(', ') || 'none measured'))}
  ${card('rAF calls', m.dependencies?.rafCalls ?? null)}
  ${card('Global events', `<span style="color:var(--muted);font-size:11px">${esc((m.dependencies?.globalEvents || []).slice(0, 14).join(', ') || '—')}</span>`)}
  ${card('Reduced Motion', m.reducedMotion?.probed
      ? (m.reducedMotion.respected === null ? 'no motion declared'
        : m.reducedMotion.respected ? '✓ the source page responds to it'
        : '✗ the source page ignores the setting')
      : 'not measured',
      m.reducedMotion?.respected === false ? 'bad' : m.reducedMotion?.respected ? 'ok' : '')}
  ${card('Isolatability', esc(isoText), isoCls)}
  ${card('Status', esc(m.status))}
</section>

${(m.warnings || []).length ? `<section>
  <h2>Notes</h2>
  <div class="warn">${m.warnings.map(w => '· ' + esc(w)).join('<br>')}</div>
</section>` : ''}

<section>
  <h2>Download</h2>
  <div class="dl">
    ${[[m.code?.zip, 'Everything as ZIP'], [m.previews?.video, 'Video'], [m.code?.single, 'Single file'],
       ['metadata.json', 'Measurement (JSON)'], ['report.md', 'Report'],
       [m.code?.rebuilt, 'Rebuild'], [m.code?.react, 'React'], [m.code?.svelte, 'Svelte'],
       ['NOT-REBUILT.md', 'Why no rebuild']]
      .filter(([f]) => has(f))
      .map(([f, label]) => `<a href="${esc(f)}" download>${esc(label)}</a>`).join('')}
  </div>
</section>

<footer>
  Generated by <b>parity</b> · Selective Extraction.
  All assets and captures come from <a href="${esc(m.source)}" style="color:var(--muted)">${esc(new URL(m.source).host)}</a>
  and belong to their authors. This page is an analysis, not a publication —
  do not host it publicly.
</footer>

</div>

${models.length ? `<script type="importmap">
{"imports":{
  "three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
  "three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
}}
</script>
<script type="module">
// Viewer for the models. If it fails — no network, CDN unreachable — the
// table and downloads stay. A page that would be useless without it would
// not have deserved the viewer.
const msg = document.getElementById('vmsg');
let THREE, OrbitControls, GLTFLoader, DRACOLoader, KTX2Loader;
try {
  THREE = await import('three');
  ({ OrbitControls } = await import('three/addons/controls/OrbitControls.js'));
  ({ GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js'));
  ({ DRACOLoader } = await import('three/addons/loaders/DRACOLoader.js'));
  ({ KTX2Loader } = await import('three/addons/loaders/KTX2Loader.js'));
} catch (e) {
  msg.textContent = 'The 3D viewer needs an internet connection (three.js from the CDN). The models below can still be downloaded.';
  throw e;
}

const box = document.getElementById('viewer');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(box.clientWidth, box.clientHeight);
box.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, box.clientWidth / box.clientHeight, 0.01, 2000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xffffff, 0x333344, 2.2));
const key = new THREE.DirectionalLight(0xffffff, 2.0); key.position.set(3, 5, 4); scene.add(key);
const rim = new THREE.DirectionalLight(0xffffff, 0.8); rim.position.set(-4, 2, -3); scene.add(rim);

// Both decoders are mandatory, not optional: without DRACOLoader the geometry
// stays unreadable, and without KTX2Loader GLTFLoader aborts on the first Basis
// image — the model then does not appear at all instead of just uncoloured.
const CDN = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/';
const draco = new DRACOLoader().setDecoderPath(CDN + 'draco/');
const ktx2 = new KTX2Loader().setTranscoderPath(CDN + 'basis/').detectSupport(renderer);
const loader = new GLTFLoader().setDRACOLoader(draco).setKTX2Loader(ktx2);

let current = null;
const load = async (src, btn) => {
  msg.style.display = 'grid';
  msg.textContent = 'loading ' + src.split('/').pop() + ' …';
  for (const b of document.querySelectorAll('.models button')) b.setAttribute('aria-pressed', String(b === btn));
  try {
    const gltf = await loader.loadAsync(src);
    if (current) { scene.remove(current); current.traverse(o => { o.geometry?.dispose?.(); }); }
    current = gltf.scene;

    // Without resolved textures many materials are black. A neutral material
    // shows the geometry, which is what this is about.
    current.traverse(o => {
      if (!o.isMesh) return;
      const had = o.material?.map;
      if (!had) o.material = new THREE.MeshStandardMaterial({ color: 0xb9b9c4, roughness: .55, metalness: .05, side: THREE.DoubleSide });
    });

    scene.add(current);
    // Fit to the model, however large it was modelled.
    const bb = new THREE.Box3().setFromObject(current);
    const size = bb.getSize(new THREE.Vector3()).length() || 1;
    const mid = bb.getCenter(new THREE.Vector3());
    controls.target.copy(mid);
    camera.position.copy(mid).add(new THREE.Vector3(size * .55, size * .35, size * .65));
    camera.near = size / 500; camera.far = size * 20; camera.updateProjectionMatrix();
    controls.update();
    msg.style.display = 'none';
  } catch (e) {
    msg.style.display = 'grid';
    msg.textContent = 'could not be loaded: ' + String(e).slice(0, 120);
  }
};

for (const b of document.querySelectorAll('.models button')) b.onclick = () => load(b.dataset.src, b);
const first = document.querySelector('.models button');
if (first) load(first.dataset.src, first);

addEventListener('resize', () => {
  renderer.setSize(box.clientWidth, box.clientHeight);
  camera.aspect = box.clientWidth / box.clientHeight;
  camera.updateProjectionMatrix();
});
(function tick(){ requestAnimationFrame(tick); controls.update(); renderer.render(scene, camera); })();
</script>` : ''}
</body>
</html>`;

writeFileSync(join(DIR, 'showcase.html'), page, 'utf8');
emit({ ev: 'done', cmd: 'showcase', out: join(DIR, 'showcase.html'), models: models.length, sounds: sounds.length, exit: 0 });
console.log(`✓ ${join(DIR, 'showcase.html')}`);
console.log(`  ${models.length} models · ${sounds.length} sounds · ${other.length} other files`);

// ── Show it directly ────────────────────────────────────────────────────────
// Import map and modules need http; on double-click the CORS rule blocks them.
const si = argv.indexOf('--serve');
if (si > -1) {
  const port = Number(argv[si + 1]) || 4180;
  console.log(`\n  http://localhost:${port}/showcase.html`);
  spawn(process.execPath, [join(ROOT, 'tools/serve.mjs'), DIR, String(port)], { stdio: 'inherit' });
} else {
  console.log(`\n  View:  node bin/parity.mjs serve ${DIR} 4180`);
  console.log(`         http://localhost:4180/showcase.html`);
}
