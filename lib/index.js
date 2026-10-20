import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { backupLedgerNow, deleteAllBatches, restoreLatest, sweepTrash } from './backup.js';
import { loadConfig, configPath, defaultConfig } from './config.js';
import { Config } from './schema.js';
import { stateDir } from './paths.js';
import { findOrphanSnapshots, log, purgeSession, vacuumIndexDb } from './purge.js';

export const name = 'dsh-session-leftover-purge';

/** Package version, read once so the ready line names what is actually running. */
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
})();

/**
 * No service is injected on purpose: this plugin only listens on the public
 * `api-session/removed` event, so it can never interfere with session
 * creation, deletion, or the workspace registry.
 */
export const inject = [];

const BOOT_RECONCILE_DELAY_MS = 8000;

/** Retry budget for the "transcript still on disk" race: 1 initial try + 2 retries. */
const TRANSCRIPT_RETRY_TIMES = 3;
const TRANSCRIPT_RETRY_MS = 1500;

/** Last trigger value this plugin already acted on. */
const TRIGGER_STATE_FILE = 'triggers.json';

function triggerStatePath() {
  return path.join(stateDir(), TRIGGER_STATE_FILE);
}

function readTriggerState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(triggerStatePath(), 'utf8'));
    return {
      restore: Number(parsed?.restore) || 0,
      delete: Number(parsed?.delete) || 0,
    };
  } catch {
    return { restore: 0, delete: 0 };
  }
}

async function writeTriggerState(state) {
  await fsp.mkdir(stateDir(), { recursive: true });
  await fsp.writeFile(triggerStatePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/**
 * Turn "the operator bumped a number" into a one-shot action. The remembered
 * value makes it idempotent: bumping 1 → 2 fires once, re-saving 2 fires nothing.
 */
async function runTriggers(cfg, logger) {
  const state = readTriggerState();
  let changed = false;
  const restoreAt = Number(cfg.restoreBackupTrigger);
  const deleteAt = Number(cfg.deleteBackupsTrigger);
  const ledgerAt = Number(cfg.backupLedgerTrigger);

  if (Number.isFinite(restoreAt) && restoreAt > state.restore) {
    state.restore = restoreAt;
    changed = true;
    try {
      const result = await restoreLatest(logger);
      logger?.info?.(`session-leftover-purge: restore backup → ${JSON.stringify(result)}`);
    } catch (error) {
      logger?.warn?.(`session-leftover-purge: restore backup failed: ${String(error)}`);
    }
  }
  if (Number.isFinite(deleteAt) && deleteAt > state.delete) {
    state.delete = deleteAt;
    changed = true;
    try {
      const result = await deleteAllBatches(logger);
      logger?.info?.(`session-leftover-purge: delete backups → ${JSON.stringify(result)}`);
    } catch (error) {
      logger?.warn?.(`session-leftover-purge: delete backups failed: ${String(error)}`);
    }
  }
  if (Number.isFinite(ledgerAt) && ledgerAt > (state.ledger ?? 0)) {
    state.ledger = ledgerAt;
    changed = true;
    try {
      const result = await backupLedgerNow(logger);
      logger?.info?.(`session-leftover-purge: ledger snapshot → ${JSON.stringify(result)}`);
    } catch (error) {
      logger?.warn?.(`session-leftover-purge: ledger snapshot failed: ${String(error)}`);
    }
  }
  if (changed) {
    try {
      await writeTriggerState(state);
    } catch (error) {
      logger?.warn?.(`session-leftover-purge: cannot persist trigger state: ${String(error)}`);
    }
  }
}

/**
 * `.volatile()` fields arrive as live references (objects with `get()`), so the
 * effective config is re-read on every use — an edit in the plugin form applies
 * to the next deleted session without a restart. The on-disk
 * `<state>/config.json` stays supported as a fallback for headless setups; the
 * form value wins when both are present.
 */
function readLiveConfig(config, disk) {
  const merged = { ...disk };
  if (config !== null && typeof config === 'object') {
    for (const [key, value] of Object.entries(config)) {
      if (value === undefined) continue;
      merged[key] = value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
    }
  }
  return merged;
}

export function apply(ctx, config) {
  const logger = ctx.logger;
  const disk = loadConfig(logger);
  const cfgNow = readLiveConfig(config, disk);
  const live = () => readLiveConfig(config, disk);
  const inFlight = new Set();
  let disposed = false;

  // Backup triggers stay usable even when the purge itself is switched off —
  // restoring a snapshot is a recovery action, not a cleanup action.
  let triggerBusy = false;
  const checkTriggers = () => {
    if (triggerBusy) return;
    triggerBusy = true;
    runTriggers(live(), logger)
      .catch((error) => logger?.warn?.(`session-leftover-purge: trigger handling failed: ${String(error)}`))
      .finally(() => {
        triggerBusy = false;
      });
  };
  checkTriggers();
  try {
    ctx.inject(['settings'], (sctx) => {
      sctx.on('settings/document-updated', (ns) => {
        const id = String(ns);
        if (id === name || id === 'session-leftover-purge') checkTriggers();
      });
    });
  } catch (error) {
    logger?.warn?.(`session-leftover-purge: cannot watch settings changes: ${String(error)}`);
  }

  if (cfgNow.enabled === false) {
    logger?.info?.('session-leftover-purge: disabled in plugin settings (no listener registered)');
    return () => {};
  }

  /**
   * A delete can emit `api-session/removed` while the transcript directory is
   * still being unlinked — the first event then hits `transcript-present` and
   * bails. Archive-manager usually fires a second event a few hundred ms later
   * (its own emit plus the kernel's `session disposed`), but that is timing
   * luck, not a guarantee. So a skip for that one reason is retried a couple of
   * times before giving up; every other outcome is final.
   */
  const attemptPurge = async (sessionId, attempt) => {
    let skipReason;
    try {
      const result = await purgeSession(sessionId, live(), logger);
      skipReason = result?.skipped;
    } catch (error) {
      logger?.warn?.(`session-leftover-purge: purge failed for ${sessionId}: ${String(error)}`);
    }
    if (skipReason === 'transcript-present' && attempt < TRANSCRIPT_RETRY_TIMES) {
      await new Promise((resolve) => setTimeout(resolve, TRANSCRIPT_RETRY_MS));
      if (!disposed) return attemptPurge(sessionId, attempt + 1);
    }
    inFlight.delete(sessionId);
  };

  const runPurge = (sessionId) => {
    if (disposed || inFlight.has(sessionId)) return;
    inFlight.add(sessionId);
    void attemptPurge(sessionId, 0);
  };

  let offRemoved = () => {};
  try {
    offRemoved = ctx.on('api-session/removed', runPurge) ?? (() => {});
  } catch (error) {
    logger?.warn?.(`session-leftover-purge: cannot subscribe to api-session/removed: ${String(error)}`);
  }

  // One line per start so an operator can confirm from the log alone that this
  // version is live: a plugin loaded from a stale Loader row would never print it.
  {
    const active = live();
    void log(
      `ready v${VERSION} subscribed=api-session/removed biliJson=${active.biliJson} ` +
        `biliIndexDb=${active.biliIndexDb} costMeterLedger=${active.costMeterLedger} ` +
        `costMeterFiles=${active.costMeterFiles} vacuumIndexDb=${active.vacuumIndexDb} ` +
        `trashRetentionDays=${active.trashRetentionDays} dryRun=${active.dryRun}`,
    );
  }

  const bootDelay = Number.isFinite(cfgNow.bootDelayMs) ? cfgNow.bootDelayMs : BOOT_RECONCILE_DELAY_MS;
  // Ordered by cost: expiring old batches is a directory listing, reconciling
  // reads every snapshot, VACUUM rewrites an 18 MB database under an exclusive
  // lock. The cheapest work runs first so a busy database cannot delay the rest.
  const bootTimer = setTimeout(() => {
    const cfg = live();
    (async () => {
      try {
        const swept = await sweepTrash(cfg, logger);
        if (swept.removed > 0) {
          logger?.info?.(
            `session-leftover-purge: expired ${swept.removed} backup batch(es) older than ${swept.days}d`,
          );
        }
      } catch (error) {
        logger?.warn?.(`session-leftover-purge: trash sweep failed: ${String(error)}`);
      }
      if (cfg.reconcileOnBoot) {
        try {
          await reconcile(cfg, logger);
        } catch (error) {
          logger?.warn?.(`session-leftover-purge: boot reconcile failed: ${String(error)}`);
        }
      }
      if (cfg.vacuumIndexDb) {
        try {
          const vacuum = await vacuumIndexDb(logger);
          await log(`vacuum index.db ${vacuum.ok ? 'ok' : vacuum.reason}`);
        } catch (error) {
          logger?.warn?.(`session-leftover-purge: vacuum failed: ${String(error)}`);
        }
      }
    })();
  }, bootDelay);
  bootTimer?.unref?.();

  logger?.info?.(
    `session-leftover-purge: ready (biliJson=${cfgNow.biliJson} indexDb=${cfgNow.biliIndexDb} ` +
      `ledger=${cfgNow.costMeterLedger} reconcileOnBoot=${cfgNow.reconcileOnBoot} dryRun=${cfgNow.dryRun})`,
  );

  return () => {
    disposed = true;
    if (bootTimer !== undefined) clearTimeout(bootTimer);
    offRemoved();
  };
}

/**
 * Read-only boot pass: report bili snapshots whose DSH session is gone.
 * Writes `<state>/orphans.json` and logs a single summary line. Deletes
 * anything only when `autoPurgeOrphans` is explicitly enabled.
 */
async function reconcile(cfg, logger) {
  const { root, scanned, orphans } = findOrphanSnapshots();
  const report = {
    checkedAt: new Date().toISOString(),
    root,
    scanned,
    orphanCount: orphans.length,
    orphans: orphans.map((item) => item.id),
  };
  try {
    await fsp.mkdir(stateDir(), { recursive: true });
    await fsp.writeFile(path.join(stateDir(), 'orphans.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } catch (error) {
    logger?.warn?.(`session-leftover-purge: cannot write orphans report: ${String(error)}`);
  }

  if (orphans.length === 0) {
    await log(`reconcile scanned=${scanned} orphans=0`);
    return report;
  }

  await log(`reconcile scanned=${scanned} orphans=${orphans.length} ids=${orphans.map((o) => o.id).join(',')}`);
  logger?.warn?.(
    `session-leftover-purge: ${orphans.length} bili snapshot(s) without a DSH session: ` +
      `${orphans.map((o) => o.id).join(', ')} — see ${path.join(stateDir(), 'orphans.json')}`,
  );

  if (cfg.autoPurgeOrphans) {
    for (const orphan of orphans) runOrphanPurge(orphan.id, cfg, logger);
  }
  return report;
}

async function runOrphanPurge(sessionId, cfg, logger) {
  try {
    await purgeSession(sessionId, cfg, logger);
  } catch (error) {
    logger?.warn?.(`session-leftover-purge: orphan purge failed for ${sessionId}: ${String(error)}`);
  }
}

export { Config, configPath, defaultConfig };
