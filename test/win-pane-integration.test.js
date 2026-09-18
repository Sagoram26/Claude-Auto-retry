// Drives the real Windows adapter through the real processOneTick, on a terminal buffer
// fed the bytes a rate-limited session actually renders. What the unit tests check piece
// by piece, this checks end to end: banner -> wait -> Enter-submitted retry, with the
// half-typed-prompt deferral in the middle. No pty, no live quota.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @xterm/headless is CommonJS: the named export is not statically analysable.
import xterm from '@xterm/headless';
import { createMonitorState, processOneTick } from '../src/monitor.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { createWinPaneAdapter } from '../src/win-pane.js';

// A terminal fed through the same path as a live session: raw bytes in, resolved cells
// out. Ink positions the cursor rather than emitting spaces, so \r\n + explicit cursor
// moves is what the buffer really receives.
async function renderedTerminal(lines) {
  const term = new xterm.Terminal({ cols: 120, rows: 24, allowProposedApi: true, scrollback: 200 });
  // write() buffers and flushes on a later tick; its callback is the only signal that the
  // cells the adapter reads actually exist yet.
  await new Promise((resolve) => term.write(lines.join('\r\n'), resolve));
  return term;
}

async function harness(lines) {
  const writes = [];
  const pty = { write: (d) => writes.push(d) };
  const adapter = createWinPaneAdapter({ term: await renderedTerminal(lines), pty, submitDelayMs: 0 });
  return { adapter, writes };
}

const BANNER = 'Claude usage limit reached · resets 3pm (UTC)';

describe('win adapter + processOneTick', () => {
  it('detects the banner off a real terminal buffer and waits', async () => {
    const { adapter, writes } = await harness(['', `● ${BANNER}`, '❯ ']);
    const state = createMonitorState();

    assert.equal(await processOneTick(state, adapter, 'win-1', DEFAULT_CONFIG, () => true), 'waiting');
    assert.ok(state.waitUntil > Date.now(), 'a reset time was parsed into a wake-up');
    assert.deepEqual(writes, [], 'nothing is typed while waiting');
  });

  it('submits the retry as text then Enter once the wait elapses', async () => {
    const { adapter, writes } = await harness(['', `● ${BANNER}`, '❯ ']);
    const state = createMonitorState();

    await processOneTick(state, adapter, 'win-1', DEFAULT_CONFIG, () => true);
    state.waitUntil = Date.now() - 1;          // reset time reached

    assert.equal(await processOneTick(state, adapter, 'win-1', DEFAULT_CONFIG, () => true), 'retried');
    assert.deepEqual(writes, [DEFAULT_CONFIG.retryMessage, '\r']);
    assert.equal(state.attempts, 1);
  });

  it('defers instead of typing over a half-written prompt, and spends no attempt', async () => {
    const { adapter, writes } = await harness(['', `● ${BANNER}`, '❯ une phrase en cours']);
    const state = createMonitorState();

    await processOneTick(state, adapter, 'win-1', DEFAULT_CONFIG, () => true);
    state.waitUntil = Date.now() - 1;

    assert.equal(await processOneTick(state, adapter, 'win-1', DEFAULT_CONFIG, () => true), 'skipped-not-claude');
    assert.deepEqual(writes, []);
    assert.equal(state.attempts, 0, 'a deferral must not burn a retry');
    assert.ok(state.waitUntil > Date.now(), 'and it reschedules rather than spinning');
  });

  it('drives the /rate-limit-options menu to "Stop and wait", never to "Upgrade"', async () => {
    const { adapter, writes } = await harness([
      "You've hit your session limit · resets 6:50pm (Europe/London)",
      'What do you want to do?',
      '❯ 1. Upgrade your plan',
      '  2. Stop and wait for limit to reset',
      'Enter to confirm · Esc to cancel',
    ]);
    const state = createMonitorState();

    assert.equal(await processOneTick(state, adapter, 'win-1', DEFAULT_CONFIG, () => true), 'menu-confirmed');
    // One Down to move off "Upgrade your plan", then Enter — as escape sequences.
    assert.deepEqual(writes, ['\x1b[B', '\r']);
  });

  it('stays quiet on ordinary output', async () => {
    const { adapter, writes } = await harness(['● Done. 3 files changed.', '❯ ']);
    const state = createMonitorState();

    assert.equal(await processOneTick(state, adapter, 'win-1', DEFAULT_CONFIG, () => true), 'monitoring');
    assert.deepEqual(writes, []);
  });
});
