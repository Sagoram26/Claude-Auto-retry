import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { captureFromTerminal, isInputBoxEmpty, paneKeyForPid, createWinPaneAdapter } from '../src/win-pane.js';
import { isRateLimited, findRateLimitMessage } from '../src/patterns.js';
import { resolveWindowsMode } from '../src/launcher.js';

// Minimal stand-in for the xterm buffer surface captureFromTerminal reads. Keeps the test
// free of a real terminal (and of node-pty) while pinning the exact API used.
function fakeTerm(lines, { baseY = 0, cursorY = null } = {}) {
  return {
    buffer: {
      active: {
        baseY,
        cursorY: cursorY == null ? lines.length - 1 - baseY : cursorY,
        getLine: (i) => (i < lines.length ? { translateToString: () => lines[i] } : undefined),
      },
    },
  };
}

describe('captureFromTerminal', () => {
  it('returns the rendered lines up to the cursor, newest last', () => {
    const term = fakeTerm(['one', 'two', 'three']);
    assert.equal(captureFromTerminal(term, 200), 'one\ntwo\nthree');
  });

  it('honours the line limit like capture-pane -S -<lines>', () => {
    const term = fakeTerm(['a', 'b', 'c', 'd']);
    assert.equal(captureFromTerminal(term, 2), 'c\nd');
  });

  it('renders a missing line as empty rather than throwing', () => {
    const term = fakeTerm(['a'], { cursorY: 3 });
    assert.equal(captureFromTerminal(term, 10), 'a\n\n\n');
  });

  it('feeds patterns.js a capture its regexes can still match', () => {
    // The failure this pins: reading the escape stream instead of the resolved cells drops
    // every space, and "Claudeusagelimitreached" matches nothing.
    const term = fakeTerm([
      '',
      '● Claude usage limit reached · resets 3pm',
      '❯ ',
    ]);
    const pane = captureFromTerminal(term, 200);
    assert.equal(isRateLimited(pane), true);
    assert.match(findRateLimitMessage(pane), /resets 3pm/);
  });
});

describe('isInputBoxEmpty', () => {
  it('is true for an idle prompt', () => {
    assert.equal(isInputBoxEmpty('────────\n❯ '), true);
  });

  it('is false while the user is typing', () => {
    assert.equal(isInputBoxEmpty('────────\n❯ bonjour test'), false);
  });

  it('ignores trailing blank lines under the prompt', () => {
    assert.equal(isInputBoxEmpty('❯ \n\n   \n'), true);
  });

  it('is false when the last rendered line is a menu row, not the input box', () => {
    assert.equal(isInputBoxEmpty('❯ No, exit'), false);
  });

  it('is true on an empty capture (nothing to clobber)', () => {
    assert.equal(isInputBoxEmpty(''), true);
  });
});

describe('paneKeyForPid', () => {
  it('produces a filename-safe key', () => {
    assert.equal(paneKeyForPid(4321), 'win-4321');
  });
});

describe('createWinPaneAdapter', () => {
  const writes = [];
  const pty = { write: (d) => writes.push(d) };

  it('submits text and Enter as two writes', async () => {
    writes.length = 0;
    const a = createWinPaneAdapter({ term: fakeTerm(['❯ ']), pty, submitDelayMs: 0 });
    await a.sendKeys('%0', 'Continue');
    assert.deepEqual(writes, ['Continue', '\r']);
  });

  it('maps menu key names to escape sequences', async () => {
    writes.length = 0;
    const a = createWinPaneAdapter({ term: fakeTerm(['❯ ']), pty, submitDelayMs: 0 });
    await a.sendKey('%0', 'Down');
    await a.sendKey('%0', 'Enter');
    assert.deepEqual(writes, ['\x1b[B', '\r']);
  });

  it('reports "foreground" only when the input box is empty', async () => {
    const idle = createWinPaneAdapter({ term: fakeTerm(['❯ ']), pty, submitDelayMs: 0 });
    const typing = createWinPaneAdapter({ term: fakeTerm(['❯ half a sentence']), pty, submitDelayMs: 0 });
    assert.equal(await idle.isClaudeForeground(), true);
    assert.equal(await typing.isClaudeForeground(), false);
  });

  it('names a pane command that cannot pass the foregroundCommands substring test', async () => {
    const a = createWinPaneAdapter({ term: fakeTerm(['❯ ']), pty, submitDelayMs: 0 });
    const fg = await a.getPaneCommand('%0');
    assert.equal(fg.toLowerCase().includes('claude'), false);
  });
});

describe('resolveWindowsMode', () => {
  it('leaves every mode alone off Windows', () => {
    assert.equal(resolveWindowsMode('tmux-session', {}, 'linux'), 'tmux-session');
    assert.equal(resolveWindowsMode('interactive', {}, 'darwin'), 'interactive');
  });

  it('turns both pane modes into conpty on Windows', () => {
    assert.equal(resolveWindowsMode('tmux-session', {}, 'win32', true), 'conpty');
    assert.equal(resolveWindowsMode('interactive', {}, 'win32', true), 'conpty');
  });

  it('leaves print mode alone: it spawns no pane', () => {
    assert.equal(resolveWindowsMode('print', {}, 'win32', true), 'print');
  });

  it('CLAUDE_AUTO_RETRY_NO_CONPTY=1 runs claude unwrapped', () => {
    assert.equal(resolveWindowsMode('tmux-session', { CLAUDE_AUTO_RETRY_NO_CONPTY: '1' }, 'win32', true), 'unwrapped');
  });
});

describe('resolveWindowsMode and redirected output', () => {
  it('declines ConPTY when stdout is not a terminal', () => {
    // A pseudo-console emits control sequences whatever the sink is, so wrapping a
    // redirected run would put escape noise in the file the user redirected into.
    assert.equal(resolveWindowsMode('tmux-session', {}, 'win32', false), 'unwrapped');
  });

  it('still uses ConPTY on a real terminal', () => {
    assert.equal(resolveWindowsMode('tmux-session', {}, 'win32', true), 'conpty');
  });

  it('leaves non-Windows alone whatever stdout is', () => {
    assert.equal(resolveWindowsMode('tmux-session', {}, 'linux', false), 'tmux-session');
  });
});
