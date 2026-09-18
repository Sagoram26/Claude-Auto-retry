// Windows pane adapter: the ConPTY equivalent of src/tmux.js.
//
// tmux has no native Windows port, and it could not host Claude Code if it had one:
// claude.exe is a Win32 console application, so it needs a ConPTY pseudo-console rather
// than a Cygwin pty. The monitor never talks to tmux directly, though — processOneTick
// receives an adapter object (see startMonitor in monitor.js), so the whole platform
// dependency is those few methods. This module implements them over node-pty, with an
// off-screen xterm terminal standing in for tmux's screen buffer.
//
// Mapping:
//   tmux capture-pane -p   ->  read the xterm buffer we fed every pty byte into
//   tmux send-keys -l      ->  write to the pty
//   ps -o stat= (foreground) -> see isClaudeForeground below; we own the pty, so the
//                               question tmux answers ("is claude still in front?") is
//                               always yes, and the useful question is different.

import { sanitizeKey } from './pane-key.js';
import { SUBMIT_DELAY_MS } from './tmux.js';
import { isRateLimitOptionsPrompt } from './patterns.js';

// Same window monitor.js measures menus in; kept equal so the adapter and the tick agree
// on whether a menu is on screen.
const RATE_LIMIT_TAIL_LINES = 12;

// Key names processOneTick sends while driving the /rate-limit-options menu, as the
// escape sequences a terminal application actually reads.
const KEY_SEQUENCES = {
  Up: '\x1b[A',
  Down: '\x1b[B',
  Right: '\x1b[C',
  Left: '\x1b[D',
  Enter: '\r',
  Escape: '\x1b',
  Space: ' ',
  Tab: '\t',
};

// Claude Code's input line renders as the prompt glyph, then whatever is typed:
//   idle           "❯ "
//   mid-typing     "❯ bonjour test"
// (captured from a live 2.1.275 session hosted in ConPTY). Anything else on the last
// rendered line — a menu row, a banner — is not the input box.
const PROMPT_ONLY = /^\s*[❯>]\s*$/;

// tmux's `capture-pane -p -S -<lines>`: the last N rendered lines as plain text.
// translateToString(true) is the part that matters — Ink positions the cursor instead of
// writing spaces, so anything that reads the escape stream rather than the resolved cells
// loses every space ("Claude usage limit" -> "Claudeusagelimit") and no pattern in
// patterns.js can match.
export function captureFromTerminal(term, lines = 200) {
  const buf = term.buffer.active;
  const end = buf.baseY + buf.cursorY;
  const out = [];
  for (let i = Math.max(0, end - lines + 1); i <= end; i++) {
    const line = buf.getLine(i);
    out.push(line ? line.translateToString(true) : '');
  }
  return out.join('\n');
}

// DESIGN-NOTES §6: send-keys can land on top of a half-typed prompt. Upstream leaves this
// open because tmux can only guess at the input box; hosting the pty ourselves, the
// rendered line is authoritative.
export function isInputBoxEmpty(paneText) {
  const lines = String(paneText ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    return PROMPT_ONLY.test(lines[i]);
  }
  return true;   // nothing rendered yet: no half-typed prompt to clobber
}

export function paneKeyForPid(pid) {
  return `win-${sanitizeKey(String(pid))}`;
}

// The adapter processOneTick drives. `readEvent`/`clearEvent` are supplied by the caller
// (they are plain file reads, already platform-neutral) so this module stays free of the
// events module's homedir lookups.
export function createWinPaneAdapter({ term, pty, readEvent, clearEvent, submitDelayMs = SUBMIT_DELAY_MS }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  return {
    capturePane: async (_pane, lines = 200) => captureFromTerminal(term, lines),

    // Two writes with a pause between them, for the same reason tmux.js splits its
    // send-keys: Ink can read a same-burst Enter as a newline inside the pasted text and
    // insert it into the input box instead of submitting.
    sendKeys: async (_pane, text) => {
      pty.write(String(text));
      await sleep(submitDelayMs);
      pty.write('\r');
    },

    sendKey: async (_pane, key) => {
      pty.write(KEY_SEQUENCES[key] ?? String(key));
    },

    // We host the pty and claude is its only process, so tmux's foreground question has a
    // constant answer and its gate would never fire. The gate is reused for the condition
    // that DOES matter here — the user is mid-sentence in the input box — because
    // processOneTick consults it before incrementing the attempt counter, so a deferral
    // costs no retry. Returning false routes to getPaneCommand below.
    //
    // The /rate-limit-options menu is exempt: it replaces the input box, so there is no
    // half-typed prompt to protect, and its own selection marker is the same ❯ glyph the
    // prompt uses. Without this the gate blocked the menu navigation the tick was about to
    // do, and the session sat on "Upgrade your plan" until the user came back.
    isClaudeForeground: async () => {
      const tail = captureFromTerminal(term, RATE_LIMIT_TAIL_LINES);
      if (isRateLimitOptionsPrompt(tail, RATE_LIMIT_TAIL_LINES)) return true;
      return isInputBoxEmpty(tail);
    },

    // Deliberately free of the substring "claude": DEFAULT_FOREGROUND_COMMANDS matches on
    // substrings, so a name containing it would wave the send through.
    getPaneCommand: async () => 'user-typing',

    readEvent,
    clearEvent,
  };
}
