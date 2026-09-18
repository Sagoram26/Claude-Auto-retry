import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStdinPump, terminalSize } from '../src/win-launch.js';

function fakePty() {
  const writes = [];
  return { writes, write: (d) => writes.push(d), text: () => writes.join('') };
}

describe('createStdinPump', () => {
  it('passes ordinary keystrokes straight through', () => {
    const pty = fakePty();
    const pump = createStdinPump(pty);
    pump(Buffer.from('hello'));
    assert.equal(pty.text(), 'hello');
  });

  it('reassembles a multi-byte character split across two chunks', () => {
    // The paste bug: "é" is 0xC3 0xA9. Decoding each chunk alone yields "��",
    // and Claude receives mojibake instead of the pasted text.
    const pty = fakePty();
    const pump = createStdinPump(pty);
    const bytes = Buffer.from('é', 'utf8');

    pump(bytes.subarray(0, 1));
    pump(bytes.subarray(1));

    assert.equal(pty.text(), 'é');
  });

  it('writes nothing for a chunk that is only half a character', () => {
    const pty = fakePty();
    const pump = createStdinPump(pty);
    pump(Buffer.from('é', 'utf8').subarray(0, 1));
    assert.deepEqual(pty.writes, [], 'a partial sequence must be held, not emitted');
  });

  it('survives a split inside a 4-byte sequence', () => {
    const pty = fakePty();
    const pump = createStdinPump(pty);
    const bytes = Buffer.from('🙂', 'utf8');      // 4 bytes
    pump(bytes.subarray(0, 2));
    pump(bytes.subarray(2, 3));
    pump(bytes.subarray(3));
    assert.equal(pty.text(), '🙂');
  });

  it('keeps control bytes intact — Ctrl-C must reach Claude as 0x03', () => {
    const pty = fakePty();
    const pump = createStdinPump(pty);
    pump(Buffer.from([0x03]));
    assert.equal(pty.text(), '\x03');
  });

  it('does not throw when the pty is already gone', () => {
    const dead = { write: () => { throw new Error('pty destroyed'); } };
    const pump = createStdinPump(dead);
    assert.doesNotThrow(() => pump(Buffer.from('x')));
  });
});

describe('terminalSize', () => {
  it('reads the real terminal dimensions', () => {
    assert.deepEqual(terminalSize({ columns: 200, rows: 60 }), { cols: 200, rows: 60 });
  });

  it('falls back when the stream reports none (not a TTY)', () => {
    assert.deepEqual(terminalSize({}), { cols: 120, rows: 40 });
  });
});
