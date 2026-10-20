import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './paths.js';

const CONFIG_FILE = 'config.json';

/**
 * Defaults are deliberately conservative:
 * - biliJson      : delete the bili snapshot file (the thing the bili panel lists)
 * - biliIndexDb   : OFF. Rewriting another process's SQLite index is opt-in.
 * - costMeterLedger: OFF. Somebody else's accounting file; opt-in.
 * - attachments   : never. Content-addressed blobs are shared between sessions.
 * - dryRun        : false
 * - trashRetentionDays: 7
 */
const DEFAULTS = Object.freeze({
  biliJson: true,
  biliIndexDb: true,
  costMeterLedger: false,
  costMeterFiles: false,
  vacuumIndexDb: false,
  attachments: false,
  dryRun: false,
  trashRetentionDays: 7,
  reconcileOnBoot: true,
  autoPurgeOrphans: false,
  bootDelayMs: 8000,
  restoreBackupTrigger: 0,
  deleteBackupsTrigger: 0,
});

export function loadConfig(logger) {
  const file = path.join(stateDir(), CONFIG_FILE);
  let onDisk = {};
  try {
    onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      logger?.warn?.(`session-leftover-purge: config unreadable (${String(error)}), using defaults`);
    }
  }
  return { ...DEFAULTS, ...(onDisk && typeof onDisk === 'object' ? onDisk : {}) };
}

export function configPath() {
  return path.join(stateDir(), CONFIG_FILE);
}

export function defaultConfig() {
  return { ...DEFAULTS };
}
