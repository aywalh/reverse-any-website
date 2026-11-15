// NDJSON event stream for the UI. Without --json nothing about the behaviour changes.
//
// The flag is removed from argv here, before any tool reads its arguments —
// otherwise "--json" ends up as a seed file in fetch-assets and behind
// --steps in interact. One place, all callers.
export const JSON_MODE = process.argv.includes('--json');

if (JSON_MODE) {
  process.argv = process.argv.filter(a => a !== '--json');
  console.log = () => {};   // pretty output would break the stream
}

export const emit = o => { if (JSON_MODE) process.stdout.write(JSON.stringify(o) + '\n'); };

// Family for the asset graph. Grouped by what the file does in the browser.
const FAMILY = {
  webp: 'images', png: 'images', jpg: 'images', jpeg: 'images', avif: 'images',
  gif: 'images', svg: 'images', ico: 'images',
  ktx2: 'textures', basis: 'textures', hdr: 'textures', exr: 'textures',
  glb: 'models', gltf: 'models', buf: 'models', bin: 'models', draco: 'models',
  sog: 'splats', ply: 'splats',
  woff2: 'fonts', woff: 'fonts', ttf: 'fonts', otf: 'fonts',
  js: 'code', mjs: 'code', wasm: 'code', riv: 'code',
  css: 'style', html: 'markup', json: 'data', webmanifest: 'data',
  mp4: 'media', webm: 'media', mov: 'media', mp3: 'media',
};
export const family = p => FAMILY[(p.split('.').pop() || '').toLowerCase()] || 'other';
