// Windows launch mode: host claude.exe in a ConPTY and run the monitor in-process.
//
// The tmux mode puts claude in a pane, forks a detached monitor, and lets the two find
// each other through a pane id. There is no pane here: the wrapper IS the multiplexer.
// It owns the pseudo-console, mirrors every byte into an off-screen xterm buffer for the
// monitor to read, and proxies the real terminal in both directions so the session looks
// and feels like plain `claude`.
//
// node-pty and @xterm/headless are optionalDependencies and are imported lazily, so a
// POSIX install that will never take this path does not need them present or built.

import { StringDecoder } from 'node:string_decoder';
import { createWinPaneAdapter, paneKeyForPid } from './win-pane.js';
import { startMonitor } from './monitor.js';
import { readStopFailureEvent, clearStopFailureEvent } from './events.js';
import { loadConfig } from './config.js';

const MISSING_DEPS = [
  '[claude-auto-retry] Windows mode needs node-pty and @xterm/headless.',
  '  npm install -g node-pty @xterm/headless',
  '  (or reinstall claude-auto-retry, which pulls them in as optional dependencies)',
  '  Set CLAUDE_AUTO_RETRY_NO_CONPTY=1 to run claude unwrapped instead.',
].join('\n');

async function loadPtyDeps() {
  try {
    const [pty, xterm] = await Promise.all([
      import('node-pty'),
      import('@xterm/headless'),
    ]);
    return { spawn: pty.default?.spawn ?? pty.spawn, Terminal: xterm.Terminal ?? xterm.default?.Terminal };
  } catch {
    return null;
  }
}

export function terminalSize(stdout = process.stdout) {
  return { cols: stdout.columns || 120, rows: stdout.rows || 40 };
}

// node-pty takes a string, so the raw stdin bytes have to be decoded first — and decoding
// each chunk on its own is wrong. A keystroke arrives as one chunk, but a paste does not:
// a multi-byte character split across the boundary decodes to two replacement characters,
// so pasted accented text reaches Claude corrupted. StringDecoder holds the incomplete
// sequence until the rest of it arrives.
export function createStdinPump(pty) {
  const decoder = new StringDecoder('utf8');
  return (chunk) => {
    const text = decoder.write(chunk);
    if (!text) return;                    // an incomplete sequence, held for the next chunk
    try { pty.write(text); } catch { /* pty gone; its exit handler runs next */ }
  };
}

export async function launchConpty(claudeBin, args, env = process.env) {
  const deps = await loadPtyDeps();
  if (!deps) {
    process.stderr.write(`${MISSING_DEPS}\n`);
    return 127;
  }
  const { spawn, Terminal } = deps;
  // A malformed ~/.claude-auto-retry.json must not stop claude from starting: the wrapper
  // is on the critical path of a command the user expects to always work.
  const config = await loadConfig().catch(() => ({}));
  const { cols, rows } = terminalSize();

  const paneKey = paneKeyForPid(process.pid);

  // Pane-keyed files (StopFailure markers, status snapshots) are prefixed with the tmux
  // server id, which off tmux falls back to the literal "default". Both sides have to
  // agree on it: the hook reads it from the environment it inherits through claude, and
  // the monitor reads it from THIS process. Stamping only the child's copy left the hook
  // writing conpty_win-N.json while the monitor looked for default_win-N.json, so no
  // event ever arrived.
  process.env.CLAUDE_AUTO_RETRY_SOCKET ??= 'conpty';

  const childEnv = {
    ...env,
    CLAUDE_AUTO_RETRY_ACTIVE: '1',
    CLAUDE_AUTO_RETRY_PANE: paneKey,
    CLAUDE_AUTO_RETRY_SOCKET: process.env.CLAUDE_AUTO_RETRY_SOCKET,
  };

  // scrollback must comfortably exceed the deepest capture the monitor asks for (120
  // lines) or the banner scrolls out of reach between ticks.
  const term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });

  let pty;
  try {
    pty = spawn(claudeBin, args, { name: 'xterm-256color', cols, rows, cwd: process.cwd(), env: childEnv });
  } catch (err) {
    process.stderr.write(`[claude-auto-retry] Failed to start claude: ${err.message}\n`);
    return 1;
  }

  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  const restore = () => {
    try { if (stdin.isTTY && !wasRaw) stdin.setRawMode(false); } catch { /* stream already gone */ }
    try { stdin.pause(); } catch { /* ditto */ }
  };
  process.on('exit', restore);

  if (stdin.isTTY) {
    try { stdin.setRawMode(true); } catch { /* not a real console; proxy raw anyway */ }
  }
  stdin.resume();

  stdin.on('data', createStdinPump(pty));
  stdin.on('error', () => { /* console closed under us — the pty exit path does the rest */ });

  pty.onData((d) => {
    term.write(d);                                   // the monitor's screen
    try { process.stdout.write(d); } catch { /* EPIPE: the reader went away */ }
  });
  process.stdout.on('error', () => { /* same */ });

  process.stdout.on('resize', () => {
    const size = terminalSize();
    try { pty.resize(size.cols, size.rows); } catch { /* pty already exited */ }
    try { term.resize(size.cols, size.rows); } catch { /* ditto */ }
  });

  const exited = new Promise((resolve) => {
    pty.onExit(({ exitCode }) => {
      restore();
      resolve(exitCode ?? 0);
    });
  });

  const eventMaxAgeMs = (config.overload?.eventMaxAgeSeconds || 120) * 1000;
  const adapter = createWinPaneAdapter({
    term,
    pty,
    readEvent: () => readStopFailureEvent(paneKey, eventMaxAgeMs),
    clearEvent: () => clearStopFailureEvent(paneKey),
  });

  // Runs alongside the proxy in this same process; nothing to detach, nothing to reap.
  //
  // isAlive is pinned true on purpose. Its job upstream is to let a DETACHED monitor reap
  // itself once the claude it watched is gone, and it does that by calling process.exit(0)
  // — which in-process would race the pty's own exit and report 0 for a claude that
  // exited non-zero. There is no detached process to reap here, and the wrapper exits
  // when the pty does, so the check has nothing left to decide.
  startMonitor(paneKey, process.pid, { adapter, isAlive: () => true }).catch((err) => {
    process.stderr.write(`[claude-auto-retry] Monitor stopped: ${err.message}\n`);
  });

  return exited;
}
