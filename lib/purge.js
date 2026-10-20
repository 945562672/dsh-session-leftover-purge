import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  biliSessionsRoot,
  costMeterFilesRoot,
  dshSessionsRoot,
  ledgerFile,
  stateDir,
  trashDir,
} from './paths.js';
import { backupLedgerFile } from './backup.js';

const MAX_JSON_BYTES = 64 * 1024 * 1024;
const SESSION_ID_SHAPE = /^session-[0-9a-zA-Z._-]+$/;

export function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID_SHAPE.test(value);
}

/** Append one line to `<state>/purge.log` (best effort, never throws). */
export async function log(line) {
  try {
    await fsp.mkdir(stateDir(), { recursive: true });
    const stamp = new Date().toISOString();
    await fsp.appendFile(path.join(stateDir(), 'purge.log'), `${stamp} ${line}\n`, 'utf8');
  } catch {
    /* logging must never break a purge */
  }
}

/** True when DSH still has an on-disk transcript dir for this session. */
function transcriptExists(sessionId) {
  const root = dshSessionsRoot();
  let workspaces;
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    try {
      if (fs.statSync(path.join(root, ws.name, sessionId)).isDirectory()) return true;
    } catch {
      /* not here */
    }
  }
  return false;
}

/** Read the snapshot id of a bili json file, or undefined. */
function readSnapshotId(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return undefined;
  }
  if (!stat.isFile() || stat.size > MAX_JSON_BYTES) return undefined;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text);
    const id = parsed?.id ?? parsed?.payload?.id;
    return typeof id === 'string' ? id : undefined;
  } catch {
    // Truncated/corrupt snapshot: fall back to the leading id field only.
    const match = /"id"\s*:\s*"(session-[0-9a-zA-Z._-]+)"/.exec(text.slice(0, 8192));
    return match ? match[1] : undefined;
  }
}

/** Every `<root>/<protocol>/*.json` snapshot file. */
function listSnapshotFiles(root) {
  const out = [];
  let protocols;
  try {
    protocols = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of protocols) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    let files;
    try {
      files = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      out.push(path.join(dir, file.name));
    }
  }
  return out;
}

async function moveToTrash(file, sessionId, batch) {
  const dir = batch ?? trashDir();
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${sessionId}__${path.basename(file)}`);
  try {
    await fsp.rename(file, target);
  } catch {
    await fsp.copyFile(file, target);
    await fsp.unlink(file);
  }
  return target;
}

/**
 * Copy the SQLite index (plus its WAL sidecars) into the purge batch before any
 * row is deleted. The three files belong together: replaying a WAL against a
 * different main file corrupts it, so they are always copied as a set.
 * Returns the copied basenames, or throws when the copy itself fails.
 */
async function backupIndexDbFiles(dbFile, batch) {
  const copied = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${dbFile}${suffix}`;
    if (!fs.existsSync(source)) continue;
    await fsp.mkdir(batch, { recursive: true });
    const target = path.join(batch, `index.db${suffix}`);
    await fsp.copyFile(source, target);
    copied.push(path.basename(target));
  }
  return copied;
}

/**
 * Delete the bili snapshots belonging to `sessionId`.
 * Returns `{ scanned, matched, moved[], skipped }`.
 */
export async function purgeBiliJson(sessionId, cfg, logger, batch) {
  const root = biliSessionsRoot();
  const result = { root, scanned: 0, matched: [], moved: [], skipped: [] };
  if (!fs.existsSync(root)) {
    result.skipped.push('bili-sessions-root-missing');
    return result;
  }
  for (const file of listSnapshotFiles(root)) {
    result.scanned += 1;
    const id = readSnapshotId(file);
    if (id !== sessionId) continue;
    result.matched.push(file);
    if (cfg.dryRun) continue;
    try {
      const target = await moveToTrash(file, sessionId, batch);
      result.moved.push({ from: file, to: target });
    } catch (error) {
      result.skipped.push(`move-failed:${path.basename(file)}:${String(error)}`);
      logger?.warn?.(`session-leftover-purge: cannot move ${path.basename(file)}: ${String(error)}`);
    }
  }
  return result;
}

/**
 * Opt-in: delete the rows for `sessionId` from bili's unified SQLite index.
 * Runs against another process's database, so this is deliberately defensive:
 * short transaction, busy timeout, orphan content sweep, no VACUUM.
 */
export async function purgeBiliIndexDb(sessionId, cfg, logger, batch) {
  const dbFile = path.join(biliSessionsRoot(), 'index.db');
  if (!fs.existsSync(dbFile)) return { ok: false, reason: 'index.db-missing' };
  if (cfg.dryRun) return { ok: false, reason: 'dry-run' };
  // Snapshot first, and never delete a row when the snapshot itself failed:
  // a purge that cannot be rolled back is not worth the risk.
  let backup;
  try {
    backup = await backupIndexDbFiles(dbFile, batch ?? trashDir());
  } catch (error) {
    return { ok: false, reason: `backup-failed:${String(error)}` };
  }
  let sqlite;
  try {
    sqlite = await import('node:sqlite');
  } catch (error) {
    return { ok: false, reason: `node:sqlite-unavailable:${String(error)}` };
  }
  const { DatabaseSync } = sqlite;
  let db;
  try {
    db = new DatabaseSync(dbFile);
  } catch (error) {
    return { ok: false, reason: `open-failed:${String(error)}` };
  }
  try {
    db.exec('PRAGMA busy_timeout = 4000');
    db.exec('PRAGMA secure_delete = ON');
    const deleted = {};
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of [
        'messages',
        'refs',
        'blocks',
        'dead_refs',
        'checkpoints',
        'ccr_entries',
        'session_ext',
        'conversations',
        'sessions',
      ]) {
        try {
          const info = db.prepare(`PRAGMA table_info("${table}")`).all();
          if (!info.some((column) => column.name === 'session_id')) continue;
          const run = db.prepare(`DELETE FROM "${table}" WHERE session_id = ?`).run(sessionId);
          if (Number(run.changes) > 0) deleted[table] = Number(run.changes);
        } catch (error) {
          deleted[`${table}:error`] = String(error);
        }
      }
      try {
        // `refcount` is the table's own authority on sharing; the NOT IN list
        // covers every remaining referrer. `ccr_entries` was missing before and
        // would have dropped content that a CCR restore still needs.
        const orphan = db
          .prepare(
            `DELETE FROM content WHERE refcount <= 0 AND hash NOT IN (
               SELECT content_hash FROM messages
               UNION SELECT summary_hash FROM blocks
               UNION SELECT one_hash FROM blocks WHERE one_hash IS NOT NULL
               UNION SELECT content_hash FROM ccr_entries
             )`,
          )
          .run();
        if (Number(orphan.changes) > 0) deleted.content = Number(orphan.changes);
      } catch (error) {
        deleted['content:error'] = String(error);
      }
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      return { ok: false, reason: `tx-failed:${String(error)}`, backup };
    }
    return { ok: true, deleted, backup };
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Opt-in: drop the session row from dsh-cost-meter's ledger.
 * The file is rewritten atomically (tmp + rename) and skipped on any surprise.
 */
/**
 * Opt-in: drop this session's detail row from the cost-meter ledger.
 *
 * Everything here is shaped by one rule — never misstate money.
 *
 *  - Only `days[*].sessions[]` is touched. `calls / cost / costCny / input / …`
 *    are the record of what was actually spent and stay exactly as they are.
 *    cost-meter calls the leftover "anonymous usage" and preserves it on purpose
 *    ("Preserve that remainder and its money instead of inventing attribution",
 *    ledger-totals.js:37). Recomputing the totals from the retained rows would
 *    make today's figure drop below what was really paid — that is the failure
 *    mode this function refuses to introduce.
 *  - The ledger is copied into the batch *before* a single byte changes, so the
 *    edit is reversible through `restoreBackupTrigger`.
 *  - cost-meter serialises its writes with a `${ledger}.lock` directory. We never
 *    create it (a half-implemented second owner is worse than none); we only
 *    stand back while it exists, and re-check it plus mtime/size right before
 *    renaming, so a concurrent write is never clobbered.
 */
export async function purgeCostMeterLedger(sessionId, cfg, logger, batch) {
  const file = ledgerFile();
  if (!fs.existsSync(file)) return { ok: false, reason: 'ledger-missing' };
  if (cfg.dryRun) return { ok: false, reason: 'dry-run' };

  const lockDir = `${file}.lock`;
  if (fs.existsSync(lockDir)) return { ok: false, reason: 'busy:cost-meter-lock-held' };

  let parsed;
  let before;
  try {
    before = await fsp.stat(file);
    parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (error) {
    return { ok: false, reason: `read-failed:${String(error)}` };
  }

  let removed = 0;
  const days = parsed?.days;
  if (days && typeof days === 'object') {
    for (const bucket of Object.values(days)) {
      const sessions = bucket?.sessions;
      if (!Array.isArray(sessions)) continue;
      for (let i = sessions.length - 1; i >= 0; i -= 1) {
        if (sessions[i]?.id === sessionId) {
          sessions.splice(i, 1);
          removed += 1;
        }
      }
    }
  }
  if (removed === 0) return { ok: true, removed: 0, aggregates: 'kept' };

  // Nothing is written until the current ledger is safely inside the batch.
  let backupName;
  try {
    backupName = await backupLedgerFile(batch);
  } catch (error) {
    // Same rule as index.db: a backup that did not land means no edit at all.
    return { ok: false, reason: `backup-failed:${String(error)}`, removed: 0 };
  }

  const after = await fsp.stat(file);
  if (fs.existsSync(lockDir)) return { ok: false, reason: 'busy:lock-appeared', backup: backupName };
  if (after.mtimeMs !== before.mtimeMs || after.size !== before.size) {
    return { ok: false, reason: 'changed-during-read', backup: backupName };
  }

  const tmp = `${file}.${process.pid}.purge-tmp`;
  try {
    await fsp.writeFile(tmp, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    // Last look before the swap. This is the final moment a concurrent cost-meter
    // write can still be noticed; the window itself cannot be closed, because
    // rename(2) has no compare-and-swap form and inventing a second lock owner is
    // riskier than this check. The mandatory batch backup is what makes the rare
    // lost race recoverable.
    const final = await fsp.stat(file);
    if (fs.existsSync(lockDir) || final.mtimeMs !== before.mtimeMs || final.size !== before.size) {
      try {
        await fsp.unlink(tmp);
      } catch {
        /* nothing to clean up */
      }
      return { ok: false, reason: 'changed-before-rename', backup: backupName };
    }
    await fsp.rename(tmp, file);
  } catch (error) {
    try {
      await fsp.unlink(tmp);
    } catch {
      /* the temp file may already be gone */
    }
    return { ok: false, reason: `write-failed:${String(error)}`, backup: backupName };
  }

  logger?.info?.(
    `session-leftover-purge: ledger rows removed=${removed}, daily totals kept as-is, backup=${backupName}`,
  );
  return { ok: true, removed, backup: backupName, aggregates: 'kept' };
}

/** Depth-first file list. Missing or unreadable directories yield nothing. */
async function listFilesRecursive(root) {
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await listFilesRecursive(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Opt-in: remove this session's raw receipts under
 * `storages/cost-meter/ledger.json.billion-context/{groups,streams,calls}/`.
 *
 * These files sit behind the ledger's per-turn detail view. Deleting them leaves
 * every aggregate in `ledger.json` untouched — but it does destroy the record of
 * which turn spent what, which is evidence rather than metadata. Off by default
 * for exactly that reason.
 *
 * Order matters: copy into the batch first, and never unlink a file the copy
 * step did not confirm. A half-copied batch must not turn into a half-deleted
 * ledger.
 */
export async function purgeCostMeterFiles(sessionId, cfg, logger, batch) {
  const root = costMeterFilesRoot();
  if (!fs.existsSync(root)) return { ok: false, reason: 'cost-files-root-missing' };
  if (cfg.dryRun) return { ok: false, reason: 'dry-run' };

  const matched = [];
  for (const dir of ['groups', 'streams', 'calls']) {
    for (const file of await listFilesRecursive(path.join(root, dir))) {
      let text;
      try {
        text = await fsp.readFile(file, 'utf8');
      } catch {
        continue;
      }
      if (text.includes(sessionId)) matched.push(file);
    }
  }
  if (matched.length === 0) return { ok: true, matched: 0, removed: 0, backup: 0 };

  const backupRoot = path.join(batch ?? trashDir(), 'cost-files');
  const copied = new Set();
  const failed = [];
  for (const file of matched) {
    const rel = path.relative(root, file);
    try {
      const target = path.join(backupRoot, rel);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.copyFile(file, target);
      copied.add(rel);
    } catch (error) {
      failed.push(`backup:${rel}:${String(error)}`);
    }
  }

  let removed = 0;
  for (const file of matched) {
    const rel = path.relative(root, file);
    if (!copied.has(rel)) continue;
    try {
      await fsp.unlink(file);
      removed += 1;
    } catch (error) {
      failed.push(`remove:${rel}:${String(error)}`);
    }
  }

  if (failed.length > 0) {
    logger?.warn?.(`session-leftover-purge: cost-meter files partly failed: ${failed.join('; ')}`);
  }
  return {
    ok: true,
    matched: matched.length,
    removed,
    backup: copied.size,
    ...(failed.length > 0 ? { failed } : {}),
  };
}

/**
 * Opt-in: physically reclaim the space that deleted rows leave behind.
 *
 * `DELETE` only marks pages free; the old bytes stay inside `index.db` and the
 * WAL until something rewrites the file, which is why a plain grep for a removed
 * session id still hits the database. `VACUUM` performs that rewrite and
 * `wal_checkpoint(TRUNCATE)` empties the journalled copy.
 *
 * This takes an EXCLUSIVE lock on another process's database, so it is only ever
 * called once per boot and gives up quietly when the lock is busy. A failed
 * VACUUM is harmless — SQLite rolls it back and the database is left as it was.
 */
export async function vacuumIndexDb(logger) {
  const dbFile = path.join(biliSessionsRoot(), 'index.db');
  if (!fs.existsSync(dbFile)) return { ok: false, reason: 'index.db-missing' };
  let sqlite;
  try {
    sqlite = await import('node:sqlite');
  } catch (error) {
    return { ok: false, reason: `node:sqlite-unavailable:${String(error)}` };
  }
  const { DatabaseSync } = sqlite;
  let db;
  try {
    db = new DatabaseSync(dbFile);
  } catch (error) {
    return { ok: false, reason: `open-failed:${String(error)}` };
  }
  try {
    db.exec('PRAGMA busy_timeout = 4000');
    db.exec('VACUUM');
    let checkpoint = 'ok';
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (error) {
      checkpoint = String(error);
    }
    return { ok: true, checkpoint };
  } catch (error) {
    logger?.warn?.(`session-leftover-purge: VACUUM skipped (${String(error)})`);
    return { ok: false, reason: `vacuum-failed:${String(error)}` };
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Clean every configured copy of a deleted session.
 * Never throws: a purge failure must not affect DSH's own delete flow.
 */
export async function purgeSession(sessionId, cfg, logger) {
  if (!isSessionId(sessionId)) {
    logger?.warn?.(`session-leftover-purge: refusing suspicious id ${JSON.stringify(sessionId)}`);
    return { skipped: 'bad-id' };
  }
  if (transcriptExists(sessionId)) {
    await log(`skip ${sessionId}: transcript still on disk`);
    logger?.warn?.(
      `session-leftover-purge: ${sessionId} still has a transcript dir, skipped (nothing deleted)`,
    );
    return { skipped: 'transcript-present' };
  }

  const report = { sessionId };
  // One purge = one batch directory, so a restore can roll the JSON snapshots
  // and the database snapshot back together.
  const batch = trashDir();
  if (cfg.biliJson) {
    try {
      report.biliJson = await purgeBiliJson(sessionId, cfg, logger, batch);
    } catch (error) {
      report.biliJson = { error: String(error) };
      logger?.warn?.(`session-leftover-purge: bili json purge failed: ${String(error)}`);
    }
  }
  if (cfg.biliIndexDb) {
    try {
      report.biliIndexDb = await purgeBiliIndexDb(sessionId, cfg, logger, batch);
    } catch (error) {
      report.biliIndexDb = { error: String(error) };
    }
  }
  if (cfg.costMeterLedger) {
    try {
      report.costMeterLedger = await purgeCostMeterLedger(sessionId, cfg, logger, batch);
    } catch (error) {
      report.costMeterLedger = { error: String(error) };
    }
  }
  if (cfg.costMeterFiles) {
    try {
      report.costMeterFiles = await purgeCostMeterFiles(sessionId, cfg, logger, batch);
    } catch (error) {
      report.costMeterFiles = { error: String(error) };
    }
  }

  const moved = report.biliJson?.moved?.length ?? 0;
  await log(`purge ${sessionId} moved=${moved} ${JSON.stringify(report)}`);
  logger?.info?.(
    `session-leftover-purge: ${sessionId} → bili snapshots moved to trash: ${moved}` +
      (report.biliIndexDb ? `, index.db: ${report.biliIndexDb.ok ? 'cleaned' : report.biliIndexDb.reason}` : ''),
  );
  return report;
}

/**
 * Read-only pass: bili snapshots whose session no longer exists in DSH.
 * Returns the orphan id list; nothing is deleted here.
 */
export function findOrphanSnapshots() {
  const root = biliSessionsRoot();
  if (!fs.existsSync(root)) return { root, scanned: 0, orphans: [] };
  const files = listSnapshotFiles(root);
  const orphans = [];
  for (const file of files) {
    const id = readSnapshotId(file);
    if (id === undefined) continue;
    if (!transcriptExists(id)) orphans.push({ id, file });
  }
  return { root, scanned: files.length, orphans };
}
