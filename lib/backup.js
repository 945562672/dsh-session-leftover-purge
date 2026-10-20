import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { biliSessionsRoot, ledgerFile, stateDir, trashDir } from './paths.js';

const DB = 'index.db';
const SIDECARS = ['', '-wal', '-shm'];
const LEDGER = 'ledger.json';

function trashRoot() {
  return path.join(stateDir(), 'trash');
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function logLine(line) {
  try {
    await fsp.mkdir(stateDir(), { recursive: true });
    await fsp.appendFile(path.join(stateDir(), 'purge.log'), `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    /* logging must never break the caller */
  }
}

/** Newest first. Batch directory names are ISO timestamps, so name order is time order. */
export function listBatches() {
  const root = trashRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(root, entry.name);
      let files = [];
      try {
        files = fs.readdirSync(dir);
      } catch {
        /* unreadable batch → report as empty */
      }
      return {
        name: entry.name,
        dir,
        files,
        // ledger.json is a batch member like index.db, not a bili snapshot:
        // it must never be restored into the bili sessions tree.
        jsonCount: files.filter((file) => file.endsWith('.json') && file !== LEDGER).length,
        hasIndexDb: files.includes(DB),
        hasLedger: files.includes(LEDGER),
      };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

/**
 * Where a snapshot goes back to. Batch entries are named
 * `<sessionId>__<original file name>`; the protocol subdirectory is whichever
 * directory under the bili sessions root already holds that file name.
 */
function snapshotDestination(fileName) {
  const bare = fileName.includes('__') ? fileName.slice(fileName.indexOf('__') + 2) : fileName;
  const root = biliSessionsRoot();
  if (fs.existsSync(root)) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name, bare);
      if (fs.existsSync(candidate)) return { target: candidate, bare };
    }
    // No existing copy: fall back to a single protocol directory if there is exactly one.
    const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
    if (dirs.length === 1) return { target: path.join(root, dirs[0].name, bare), bare };
  }
  return { target: path.join(root, 'anthropic', bare), bare };
}

/**
 * `BEGIN IMMEDIATE` is the only honest way to tell whether another writer is
 * active: WAL allows concurrent readers, so an open connection proves nothing.
 */
async function canTakeWriteLock(dbFile) {
  let sqlite;
  try {
    sqlite = await import('node:sqlite');
  } catch {
    return { ok: false, reason: 'node:sqlite-unavailable' };
  }
  const { DatabaseSync } = sqlite;
  let db;
  try {
    db = new DatabaseSync(dbFile);
  } catch (error) {
    return { ok: false, reason: `open-failed:${String(error)}` };
  }
  try {
    db.exec('PRAGMA busy_timeout = 1500');
    db.exec('BEGIN IMMEDIATE');
    db.exec('ROLLBACK');
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `locked:${String(error)}` };
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Put the backed-up database back. When another process holds the write lock we
 * never overwrite: the files are staged as `index.db.restored-<stamp>*` next to
 * the live database and the caller is told to replace them after quitting DSH.
 */
async function restoreDatabase(batch, logger) {
  const target = path.join(biliSessionsRoot(), DB);
  if (!batch.hasIndexDb) return { restored: false, reason: 'no-index-db-in-batch' };
  const lock = await canTakeWriteLock(target);
  if (!lock.ok) {
    const staged = [];
    const tag = stamp();
    for (const suffix of SIDECARS) {
      const source = path.join(batch.dir, `${DB}${suffix}`);
      if (!fs.existsSync(source)) continue;
      const destination = path.join(biliSessionsRoot(), `${DB}${suffix}.restored-${tag}`);
      await fsp.copyFile(source, destination);
      staged.push(destination);
    }
    await logLine(`restore staged (${lock.reason}) files=${staged.length}`);
    logger?.warn?.(
      `session-leftover-purge: index.db is in use (${lock.reason}); restored copy staged at ` +
        `${path.join(biliSessionsRoot(), `${DB}.restored-${tag}`)} — quit DSH, then move them over index.db`,
    );
    return { restored: false, staged, reason: lock.reason };
  }

  const tag = stamp();
  const moved = [];
  try {
    for (const suffix of SIDECARS) {
      const live = `${target}${suffix}`;
      if (!fs.existsSync(live)) continue;
      const aside = `${live}.before-restore-${tag}`;
      await fsp.rename(live, aside);
      moved.push({ from: live, to: aside });
    }
    for (const suffix of SIDECARS) {
      const source = path.join(batch.dir, `${DB}${suffix}`);
      if (!fs.existsSync(source)) continue;
      await fsp.copyFile(source, `${target}${suffix}`);
    }
    await logLine(`restore applied suffix-batch=${batch.name} aside=${moved.length}`);
    return { restored: true, aside: moved };
  } catch (error) {
    // Best effort: put the live files back where they were.
    for (const item of moved) {
      try {
        await fsp.rename(item.to, item.from);
      } catch {
        /* leave the aside copy for manual recovery */
      }
    }
    await logLine(`restore failed: ${String(error)}`);
    return { restored: false, reason: `restore-failed:${String(error)}` };
  }
}

/**
 * Copy the live ledger into a batch directory.
 * Throws when the copy does not land — callers treat that as "do not touch the ledger".
 */
export async function backupLedgerFile(batch) {
  const source = ledgerFile();
  await fsp.mkdir(batch, { recursive: true });
  await fsp.copyFile(source, path.join(batch, LEDGER));
  return LEDGER;
}

/**
 * Trigger action: snapshot the ledger on its own. Read-only towards the ledger —
 * the only thing it produces is a new batch directory.
 */
export async function backupLedgerNow(logger) {
  const source = ledgerFile();
  if (!fs.existsSync(source)) return { ok: false, reason: 'ledger-missing' };
  const batch = trashDir();
  try {
    const bytes = (await fsp.stat(source)).size;
    await backupLedgerFile(batch);
    await logLine(`ledger snapshot batch=${path.basename(batch)} bytes=${bytes}`);
    logger?.info?.(`session-leftover-purge: ledger snapshot (${bytes} bytes) → ${batch}`);
    return { ok: true, batch: path.basename(batch), bytes };
  } catch (error) {
    await logLine(`ledger snapshot failed: ${String(error)}`);
    return { ok: false, reason: String(error) };
  }
}

/**
 * Put the ledger back. When cost-meter holds `${ledger}.lock` we never overwrite
 * a live file: the copy is staged next to it and the caller is told where it is.
 */
async function restoreLedger(batch, logger) {
  if (!batch.hasLedger) return { restored: false, reason: 'no-ledger-in-batch' };
  const target = ledgerFile();
  const source = path.join(batch.dir, LEDGER);
  const lockDir = `${target}.lock`;
  const tag = stamp();

  if (fs.existsSync(lockDir)) {
    const staged = `${target}.restored-${tag}`;
    await fsp.copyFile(source, staged);
    await logLine(`ledger restore staged (cost-meter lock held) file=${staged}`);
    logger?.warn?.(
      `session-leftover-purge: cost-meter holds the ledger lock; restored copy staged at ${staged} — replace ledger.json after quitting DSH`,
    );
    return { restored: false, staged: [staged], reason: 'busy:cost-meter-lock-held' };
  }

  const aside = `${target}.before-restore-${tag}`;
  try {
    if (fs.existsSync(target)) await fsp.rename(target, aside);
    await fsp.copyFile(source, target);
    await logLine(`ledger restored batch=${batch.name} aside=${path.basename(aside)}`);
    return { restored: true, aside };
  } catch (error) {
    // Best effort: put the live ledger back where it was.
    try {
      if (fs.existsSync(aside) && !fs.existsSync(target)) await fsp.rename(aside, target);
    } catch {
      /* leave the aside copy for manual recovery */
    }
    await logLine(`ledger restore failed: ${String(error)}`);
    return { restored: false, reason: `restore-failed:${String(error)}` };
  }
}

/** Restore the newest batch: JSON snapshots always, the database when it is safe. */export async function restoreLatest(logger) {
  const batches = listBatches();
  if (batches.length === 0) return { ok: false, reason: 'no-backup' };
  const batch = batches[0];
  const restoredJson = [];
  const skipped = [];
  for (const file of batch.files) {
    if (!file.endsWith('.json') || file === LEDGER) continue;
    const { target, bare } = snapshotDestination(file);
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.copyFile(path.join(batch.dir, file), target);
      restoredJson.push(bare);
    } catch (error) {
      skipped.push(`${bare}:${String(error)}`);
    }
  }
  const database = await restoreDatabase(batch, logger);
  const ledger = await restoreLedger(batch, logger);
  await logLine(
    `restore batch=${batch.name} json=${restoredJson.length} db=${database.restored ? 'applied' : database.reason ?? 'skipped'} ledger=${ledger.restored ? 'applied' : ledger.reason ?? 'skipped'}`,
  );
  return { ok: true, batch: batch.name, restoredJson, skipped, database, ledger };
}

/** Delete every batch. Irreversible. */
export async function deleteAllBatches(logger) {
  const root = trashRoot();
  if (!fs.existsSync(root)) return { ok: true, removed: 0 };
  let removed = 0;
  const failed = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      await fsp.rm(path.join(root, entry.name), { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      failed.push(`${entry.name}:${String(error)}`);
      logger?.warn?.(`session-leftover-purge: cannot delete backup ${entry.name}: ${String(error)}`);
    }
  }
  await logLine(`delete-backups removed=${removed} failed=${failed.length}`);
  return { ok: failed.length === 0, removed, failed };
}
