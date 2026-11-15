#!/usr/bin/env node
// parity — source-first frontend reconstruction with counter-measurement.
// Thin dispatcher: every subcommand forwards its arguments to the matching
// script in tools/, so each script stays runnable on its own.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const COMMANDS = {
  capture:    ['tools/capture.mjs',    '<url> [outDir]',              'Baseline: 3 load phases, console, requests, screenshots'],
  localize:   ['tools/localize.mjs',   '<url> <outDir> [--allow h]',  'Fetch server HTML, strip tracking, install the guard'],
  fetch:      ['tools/fetch-assets.mjs','<origin> <outDir> [seed ...]','Recursive asset discovery through HTML/CSS/JS'],
  serve:      ['tools/serve.mjs',      '[root] [port]',               'Static server with correct MIME types + ranges'],
  verify:     ['tools/verify.mjs',     '<url> <out> [--shots] [--freeze]', 'Metrics, canvas contrast, 404s, scroll marks'],
  interact:   ['tools/interact.mjs',   '<url> <outDir> [--steps m]',  'Interaction matrix, generic + optional site steps'],
  responsive: ['tools/responsive.mjs', '<url> <outDir>',              'Sweep across 15 widths, measures breakpoints'],
  motion:     ['tools/motion.mjs',     '<url> [outDir]',              'Measure the motion layer: curves, durations, libraries'],
  depth:      ['tools/depth.mjs',      '<url> [outDir]',              'Measure reach: how far the wheel drives the page'],
  diff:       ['tools/diff.mjs',       '<sourceDir> <cloneDir>',      'Evaluate the counter-measurement — exit 1 on any difference'],
  pxdiff:     ['tools/pxdiff.mjs',     '<a.png> <b.png>',             'Screenshot pair pixel by pixel — only meaningful with --freeze'],
  install:    ['tools/setup.mjs',      '[--ui|--no-ui]',              'Setup: check the environment, interface optional'],
  ui:         ['ui/server.mjs',        '[port] [--no-window]',        'Interface: runs the sequence and shows it live'],
  extract:    ['tools/extract.mjs',    '<url> --selector <css>',      'Measure and isolate one element instead of the whole page'],
  rebuild:    ['tools/rebuild.mjs',    '<extraction-dir> [--shot]',   'Write an independent version from the measurement'],
  export:     ['tools/export.mjs',     '<extraction-dir> [--all]',    'Video, single file and ZIP of an extraction'],
  showcase:   ['tools/showcase.mjs',   '<extraction-dir> [--serve]',  'A page showing what was found — and what was not'],
};

// Which commands belong to which method. Help only — the
// dispatcher treats them all the same.
const GROUP = {
  'Full clone — reconstruct a whole page and counter-measure it':
    ['capture', 'localize', 'fetch', 'serve', 'verify', 'interact', 'responsive', 'motion', 'depth', 'diff', 'pxdiff'],
  'Selective extraction — single elements, animations and interactions':
    ['extract', 'rebuild', 'export', 'showcase'],
  'Setup and interface':
    ['install', 'ui'],
};

const [arg0, ...rest] = process.argv.slice(2);
// parity --install reads more naturally than parity install; both work.
const cmd = arg0 === '--install' ? 'install' : arg0;

if (!cmd || cmd === '-h' || cmd === '--help' || !COMMANDS[cmd]) {
  const pad = Math.max(...Object.keys(COMMANDS).map(k => k.length));
  console.log(`
  [1m█▌▐█[0m  parity — source-first frontend reconstruction with counter-measurement

  Every cloning tool claims fidelity. parity measures it: the same probes
  run against the original AND the clone, only the difference counts.

${Object.entries(GROUP).map(([title, keys]) => `${title}:
${keys.filter(k => COMMANDS[k]).map(k => {
  const [, usage, desc] = COMMANDS[k];
  return `  ${k.padEnd(pad)}  ${usage.padEnd(29)} ${desc}`;
}).join('\n')}`).join('\n\n')}

Full clone — the typical sequence:
  parity capture   https://target.tld capture/orig
  parity localize  https://target.tld clone
  parity fetch     https://target.tld clone clone/index.html
  parity serve     clone 4173 &

  parity verify    https://target.tld     capture/orig  --shots
  parity verify    http://localhost:4173/ capture/clone --shots
  parity diff      capture/orig capture/clone

  diff is the actual test. A step that fails on both sides is a limit
  of the measurement — not a clone defect, and diff does not count
  it as one.

Selective extraction — one element instead of the whole page:
  parity extract https://target.tld --selector ".hero-title"
  parity extract https://target.tld --selector ".card" --trigger hover
  parity extract https://target.tld --selector "nav" --scope section --repeat 5

  The whole page stays the source of analysis; the result is a single
  element. Nothing has to be cloned or exported for it.
`);
  process.exit(cmd && !COMMANDS[cmd] ? 1 : 0);
}

const child = spawn(process.execPath, [join(ROOT, COMMANDS[cmd][0]), ...rest], { stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 0));
