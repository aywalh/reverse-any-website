// Setup. Checks the environment and installs the interface on request.
//
// Usage: node tools/setup.mjs [--ui | --no-ui]
//        parity --install
//
// Without a flag it asks. Without a terminal (CI, pipe) it does not guess but
// demands a flag — creating a shortcut without anyone saying yes would be
// overstepping.
import { existsSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// The version lives in package.json and nowhere else.
const VERSION = createRequire(import.meta.url)('../package.json').version;

// ── Output ──────────────────────────────────────────────────────────────────
// Colour only when a terminal is watching. Piped or with NO_COLOR it stays
// plain text, otherwise escape sequences end up in log files.
const TTY = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => TTY ? `\x1b[${code}m${s}\x1b[0m` : s;
const bold = s => c(1, s), dim = s => c(2, s);
const green = s => c(32, s), red = s => c(31, s), yellow = s => c(33, s);
const w = process.stdout.columns || 80;
const out = s => process.stdout.write(s + '\n');

// The brand mark in the terminal — the same shape as in the dispatcher's help text.
const header = () => {
  out('');
  out(`  ${bold('█▌▐█')}  ${bold('parity')}`);
  out('');
};

// ── Environment ─────────────────────────────────────────────────────────────
// Chrome and Edge in app mode. Also used by ui/server.mjs, so the list
// exists only once.
export const findBrowser = () => {
  const L = process.env.LOCALAPPDATA || '';
  const PF = process.env.ProgramFiles || 'C:\\Program Files';
  const P86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const candidates = [
    [join(P86, 'Microsoft/Edge/Application/msedge.exe'), 'Edge'],
    [join(PF, 'Microsoft/Edge/Application/msedge.exe'), 'Edge'],
    [join(PF, 'Google/Chrome/Application/chrome.exe'), 'Chrome'],
    [join(P86, 'Google/Chrome/Application/chrome.exe'), 'Chrome'],
    [join(L, 'Google/Chrome/Application/chrome.exe'), 'Chrome'],
    ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'Chrome'],
    ['/usr/bin/google-chrome', 'Chrome'],
    ['/usr/bin/chromium', 'Chromium'],
  ];
  const hit = candidates.find(([p]) => existsSync(p));
  return hit ? { path: hit[0], name: hit[1] } : null;
};

// The agent skill. The repo only holds its source under skills/ — it is
// installed once the agent has unpacked it: either as a plugin (then under a
// version number nobody here cares about) or by hand into ~/.claude/skills/.
// If neither is found, setup reminds you; a measurement run does not depend
// on it, so it does not block setup.
export const skillInstalled = () => {
  const home = homedir();
  if (existsSync(join(home, '.claude/skills/parity/SKILL.md'))) return true;
  const cache = join(home, '.claude/plugins/cache/parity/parity');
  try {
    return readdirSync(cache).some(v => existsSync(join(cache, v, 'skills/parity/SKILL.md')));
  } catch { return false; }
};

const checkEnvironment = async () => {
  const rows = [];

  const major = Number(process.versions.node.split('.')[0]);
  rows.push({ ok: major >= 18, label: 'Node', value: 'v' + process.versions.node,
              hint: major >= 18 ? '' : 'parity needs Node 18 or newer' });

  let pw = null;
  try {
    pw = createRequire(import.meta.url)('playwright/package.json').version;
    rows.push({ ok: true, label: 'Playwright', value: pw });
  } catch {
    rows.push({ ok: false, label: 'Playwright', value: 'missing', hint: 'npm install' });
  }

  if (pw) {
    let exe = null;
    try { exe = (await import('playwright')).chromium.executablePath(); } catch {}
    const ok = Boolean(exe && existsSync(exe));
    rows.push({ ok, label: 'Chromium', value: ok ? 'installed' : 'not downloaded',
                hint: ok ? '' : 'npx playwright install chromium' });
  } else {
    rows.push({ ok: false, label: 'Chromium', value: 'unchecked', hint: 'install Playwright first' });
  }

  const b = findBrowser();
  rows.push({ ok: Boolean(b), soft: true, label: 'App window', value: b ? b.name : 'no Chrome/Edge',
              hint: b ? '' : 'the interface then runs in the normal browser' });

  const skill = skillInstalled();
  rows.push({ ok: skill, soft: true, label: 'Agent skill', value: skill ? 'installed' : 'not installed',
              hint: skill ? '' : '/plugin marketplace add aywalh/reverse-any-website' });

  return rows;
};

const printChecks = rows => {
  out(`  ${dim('Environment')}`);
  out('');
  const pad = Math.max(...rows.map(r => r.label.length)) + 2;
  for (const r of rows) {
    const mark = r.ok ? green('✓') : yellow('!');
    out(`  ${mark}  ${r.label.padEnd(pad)}${r.value}`);
    if (r.hint) out(`  ${' '.repeat(pad + 3)}${dim(r.hint)}`);
  }
  out('');
};

// ── Selection ───────────────────────────────────────────────────────────────
// Arrow keys instead of typing y/n. Falls back to the first option when the
// terminal has no raw mode.
export const select = (options) => new Promise(resolve => {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) return resolve(0);
  let i = 0;
  const lines = options.length + 3;
  const pad = Math.max(...options.map(o => o.label.length)) + 4;

  const draw = redraw => {
    if (redraw) process.stdout.write(`\x1b[${lines}A\x1b[0J`);
    out('');
    for (const [n, o] of options.entries()) {
      const label = o.label.padEnd(pad);
      out(n === i ? `  ${bold('❯')} ${bold(label)}${dim(o.hint)}`
                  : `    ${label}${dim(o.hint)}`);
    }
    out('');
    out(dim('  ↑↓ move · ⏎ confirm · esc cancel'));
  };

  const done = value => {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdin.removeListener('data', onKey);
    resolve(value);
  };

  const onKey = k => {
    if (k === '\x1b[A' || k === 'k') { i = (i - 1 + options.length) % options.length; draw(true); }
    else if (k === '\x1b[B' || k === 'j') { i = (i + 1) % options.length; draw(true); }
    else if (k === '\r' || k === '\n') { draw(true); done(i); }
    else if (k === '\x1b' || k === '\x03') { done(-1); }
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onKey);
  draw(false);
});

// ── Shortcut ────────────────────────────────────────────────────────────────
// Target is node.exe directly rather than a .cmd, so no console window sits
// in the foreground. Single-quote in PowerShell (backslashes are literal
// there) and go through a file with BOM instead of -Command, otherwise the
// console code page mangles umlauts in the path.
export const LNK = process.platform === 'win32'
  ? join(process.env.APPDATA || '', 'Microsoft/Windows/Start Menu/Programs/parity.lnk')
  : null;

const createShortcut = () => {
  const q = s => "'" + s.replace(/'/g, "''") + "'";
  const ps = [
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut(' + q(LNK) + ')',
    '$s.TargetPath = ' + q(process.execPath),
    '$s.Arguments = ' + q('"' + join(ROOT, 'bin/parity.mjs') + '" ui'),
    '$s.WorkingDirectory = ' + q(ROOT),
    '$s.IconLocation = ' + q(join(ROOT, 'brand/app.ico')),
    '$s.Description = ' + q('parity'),
    '$s.WindowStyle = 7',
    '$s.Save()',
  ].join('\n');
  const script = join(tmpdir(), 'parity-shortcut.ps1');
  writeFileSync(script, '\uFEFF' + ps, 'utf8');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-File', script], { encoding: 'utf8' });
  rmSync(script, { force: true });
  return r.status === 0 ? null : (r.stderr || 'unknown error').trim();
};

// ── Flow ────────────────────────────────────────────────────────────────────
const main = async () => {
  const args = process.argv.slice(2);
  const wantUi = args.includes('--ui') ? true
               : args.includes('--no-ui') ? false : null;

  header();
  out(`  ${bold('Setup')}${' '.repeat(Math.max(1, w - 24))}${dim('parity ' + VERSION)}`);
  out('');

  const rows = await checkEnvironment();
  printChecks(rows);

  const blocking = rows.filter(r => !r.ok && !r.soft);
  if (blocking.length) {
    out(`  ${yellow('Not everything is ready.')} ${dim('Measurement runs need Playwright and Chromium.')}`);
    out(`  ${dim('Setup continues anyway — you can catch up any time.')}`);
    out('');
  }

  let ui = wantUi;
  if (ui === null) {
    if (!process.stdin.isTTY) {
      out(`  ${red('No terminal.')} Please pass ${bold('--ui')} or ${bold('--no-ui')}.`);
      process.exit(2);
    }
    out(`  ${bold('What should be installed?')}`);
    const pick = await select([
      { label: 'CLI and interface', hint: 'Start menu entry with window · recommended' },
      { label: 'CLI only', hint: 'no Start menu entry' },
    ]);
    if (pick === -1) { out(''); out(`  ${dim('cancelled — nothing changed')}`); out(''); process.exit(130); }
    ui = pick === 0;
  }

  out('');
  if (ui && process.platform !== 'win32') {
    out(`  ${yellow('!')}  Start menu entries are only available on Windows so far.`);
    out(`     ${dim('The interface itself runs everywhere: parity ui')}`);
    ui = false;
  } else if (ui) {
    const err = createShortcut();
    if (err) {
      out(`  ${red('✗')}  Creating the shortcut failed`);
      out(`     ${dim(err.split('\n')[0])}`);
      process.exit(1);
    }
  }

  // ── Result ────────────────────────────────────────────────────────────────
  out(`  ${green('✓')}  ${bold(ui ? 'Installed' : 'Installed — CLI only')}`);
  out('');
  const steps = [];
  if (ui) steps.push(['Start menu', 'parity'],
                     ['Start the interface', 'parity ui']);
  else steps.push(['Interface stays available', 'parity ui']);
  steps.push(['First measurement run', 'parity capture https://target.tld capture/orig']);
  const pad = Math.max(...steps.map(s => s[0].length)) + 3;
  for (const [k, v] of steps) out(`     ${dim(k.padEnd(pad))}${v}`);
  out('');

  // A missing app window is not an open item but information — the missing
  // skill is one, which is why only the former is left out here.
  const missing = rows.find(r => !r.ok && r.hint && r.label !== 'App window');
  if (missing) { out(`  ${yellow('Still open:')} ${bold(missing.hint)}`); out(''); }
  else if (ui) { out(`  ${dim('To pin it: right-click in the Start menu → Pin to taskbar')}`); out(''); }
};

// Only run when invoked directly — ui/server.mjs imports findBrowser and LNK
// from here without setup kicking off.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
