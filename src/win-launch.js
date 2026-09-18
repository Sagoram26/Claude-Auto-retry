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

export async function launchConpty(claudeBin, args, env = process.env) {
  const deps = await loadPtyDeps();
  if (!deps) {
    process.stderr.write(`${MISSING_DEPS}\n`);
    return 127;
  }
  const { spawn, Terminal } = deps;
  const config = await loadConfig();
  const { cols, rows } = terminalSize();

  const paneKey = paneKeyForPid(process.pid);
  // The StopFailure hook runs as a child of claude, so it inherits these and writes its
  // marker under the same key the monitor reads. CLAUDE_AUTO_RETRY_SOCKET stands in for
  // the $TMUX-derived server id that keys those files on POSIX.
  const childEnv = {
    ...env,
    CLAUDE_AUTO_RETRY_ACTIVE: '1',
    CLAUDE_AUTO_RETRY_PANE: paneKey,
    CLAUDE_AUTO_RETRY_SOCKET: 'conpty',
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
  stdin.on('data', (d) => pty.write(d.toString('utf8')));

  pty.onData((d) => {
    term.write(d);              // the monitor's screen
    process.stdout.write(d);    // the user's screen
  });

  process.stdout.on('resize', () => {
    const size = terminalSize();
    try { pty.resize(size.cols, size.rows); } catch { /* pty already exited */ }
    try { term.resize(size.cols, size.rows); } catch { /* ditto */ }
  });

  let alive = true;
  const exited = new Promise((resolve) => {
    pty.onExit(({ exitCode }) => {
      alive = false;
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
  startMonitor(paneKey, process.pid, { adapter, isAlive: () => alive }).catch((err) => {
    process.stderr.write(`[claude-auto-retry] Monitor stopped: ${err.message}\n`);
  });

  return exited;
}
