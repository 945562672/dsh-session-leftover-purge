import os from 'node:os';
import path from 'node:path';

/** DSH home: `$DSH_HOME` wins (the launcher sets it), else `~/.dsh`. */
export function dshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim() !== '') return env.trim();
  return path.join(os.homedir(), '.dsh');
}

/** This plugin's own state dir (config, trash, log). */
export function stateDir() {
  return path.join(dshHome(), 'storages', 'session-leftover-purge');
}

/**
 * billion-context session snapshot root.
 * Upstream default is the XDG data dir; on Windows that resolves to
 * `%USERPROFILE%\.local\share\billion-context\sessions`. `BILI_SESSIONS_DIR`
 * overrides it, and that is what the running proxy actually uses.
 */
export function biliSessionsRoot() {
  const env = process.env.BILI_SESSIONS_DIR;
  if (typeof env === 'string' && env.trim() !== '') return env.trim();
  return path.join(os.homedir(), '.local', 'share', 'billion-context', 'sessions');
}

export function dshSessionsRoot() {
  return path.join(dshHome(), 'sessions');
}

/**
 * dsh-cost-meter's ledger — the only record on this machine of what was actually
 * spent. Unlike bili's index.db it has no upstream to rebuild from, so anything
 * done to it is treated as an edit of the books, not as clearing a leftover.
 * `cost-meter` writes under `${ledgerFile()}.lock` (a directory): respect it.
 */
export function ledgerFile() {
  return path.join(dshHome(), 'storages', 'cost-meter', 'ledger.json');
}

export function trashDir() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(stateDir(), 'trash', stamp);
}
