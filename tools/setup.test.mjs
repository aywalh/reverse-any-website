// Self-test for setup's keyboard selection.
//   node tools/setup.test.mjs
//
// The selection can only be checked by hand in a real terminal. Here stdin and
// stdout are swapped out so wrap-around, confirm, cancel and the number of
// redrawn lines can still be proven.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { select, skillInstalled } from './setup.mjs';

const OPTS = [{ label: 'CLI and interface', hint: 'a' }, { label: 'CLI only', hint: 'b' }];

const realIn = process.stdin, realWrite = process.stdout.write.bind(process.stdout);

// Play through a selection and return what it yields and what it draws.
const run = async keys => {
  const fake = new EventEmitter();
  Object.assign(fake, {
    isTTY: true, setRawMode() {}, resume() {}, pause() {}, setEncoding() {},
    removeListener: EventEmitter.prototype.removeListener.bind(fake),
  });
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
  let buf = '';
  process.stdout.write = s => { buf += s; return true; };

  const p = select(OPTS);
  for (const k of keys) fake.emit('data', k);
  const value = await p;

  process.stdout.write = realWrite;
  Object.defineProperty(process, 'stdin', { value: realIn, configurable: true });
  return { value, buf };
};

const UP = '\x1b[A', DOWN = '\x1b[B', ENTER = '\r', ESC = '\x1b';

// Confirming straight away takes the first option.
assert.equal((await run([ENTER])).value, 0);

// One down, then confirm.
assert.equal((await run([DOWN, ENTER])).value, 1);

// Down and back up lands at the top again.
assert.equal((await run([DOWN, UP, ENTER])).value, 0);

// Up from the first option wraps to the end, not into negatives.
assert.equal((await run([UP, ENTER])).value, OPTS.length - 1);

// Down twice with two options is the first one again.
assert.equal((await run([DOWN, DOWN, ENTER])).value, 0);

// esc and Ctrl-C cancel without selecting anything.
assert.equal((await run([ESC])).value, -1);
assert.equal((await run(['\x03'])).value, -1);

// On redraw the cursor must move up exactly as many lines as were drawn —
// otherwise the list wanders down the screen on every keypress.
const { buf } = await run([DOWN, ENTER]);
const up = Number(buf.match(/\x1b\[(\d+)A/)[1]);
const drawn = buf.split('\x1b[' + up + 'A')[0].split('\n').length - 1;
assert.equal(up, drawn, `cursor moves up ${up} lines, ${drawn} were drawn`);

// Skill detection reads foreign directories that need not exist.
// So it must never throw; it answers the question with yes or no.
assert.equal(typeof skillInstalled(), 'boolean');

console.log('✓ Selection: 8 checks passed');
console.log('✓ Skill detection: answers without throwing');
