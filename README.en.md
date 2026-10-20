# dsh-session-leftover-purge

[简体中文](README.md) | **English**

Deleting a session clears DeepSeek Harness's own transcript, but
[billion-context](https://github.com/ranxianglei/billion-context) keeps a JSON snapshot plus a
shared `index.db`, and `dsh-cost-meter` keeps ledger rows. The deleted conversation therefore
keeps showing up in bili's panel and its text stays in the database. This plugin subscribes to
the public `api-session/removed` event and finishes the cleanup.

## Install

```bash
dsh plugin add github:945562672/dsh-session-leftover-purge
```

**Fully quit and reopen DSH after installing.** The host half is loaded by the DSH Loader at
process start, so a package installed while DSH is running is not mounted into the current
process. Reloading the page only refreshes the settings form, it does not make the cleanup run.

## Requirements

**Required:** DeepSeek Harness itself (`>= 0.2.0-rc.1 < 0.3.0-0`). The plugin runs no background
service, and the only third-party package it imports is `@deepseek-ai/schemastery`, which is
installed automatically.

**Co-operates with** (missing ones are skipped, never an error):

| Component | Behaviour when absent |
|---|---|
| `@michengai/dsh-archive-manager` | No "delete session" entry point, so no purge is triggered; only the boot reconcile runs |
| `billion-context` (bili) | Snapshot and index steps are skipped, logged as `bili-sessions-root-missing` |
| `dsh-cost-meter` | Ledger and detail-file steps are skipped, logged as `ledger-missing` / `cost-files-root-missing` |

In short: install it and it runs. Whatever is missing simply gets less cleanup — a missing
neighbour never stops the plugin from loading.

## Usage

Nothing to configure. By default it does two things: removes the bili JSON snapshot and the
`index.db` rows for the deleted session.

| Setting | Default | What it does |
|---|---|---|
| Master switch | on | Turning it off stops all cleanup and unsubscribes from deletes |
| bili JSON snapshot | on | Removes the entry from bili's panel |
| bili SQLite index | on | Deletes the index rows; a backup is taken before any row is touched |
| cost-meter ledger rows | off | Deletes the ledger's detail rows only, the daily totals stay untouched |
| cost-meter raw detail files | off | Deletes the per-turn usage receipts |
| Reclaim index.db space | off | VACUUMs deleted pages away on boot; a failure leaves data intact |
| Backup retention | 7 days | Older batches are removed on the next start; `0` keeps them forever |
| Dry run | off | Logs what would happen, moves and deletes nothing |
| Reconcile on boot | on | Scans for orphan snapshots at startup and writes a report |
| Auto purge orphans | off | Cleans orphans found during reconcile instead of only reporting |
| Boot delay | 8000 ms | How long to wait before reconciling |

Settings live under **Settings → Plugins → Plugin manager → dsh-session-leftover-purge**.
Changes take effect immediately, no restart needed.

The three fields **Restore latest backup / Delete all backups / Back up the cost-meter ledger
now** are triggers: **write a new number and save** to run the action once. DSH renders schema
fields, not buttons, so bumping a number is how an action is expressed.

## Backups and restore

Every purge leaves a restorable copy under
`~/.dsh/storages/session-leftover-purge/trash/<timestamp>/`:

- `index.db` / `index.db-wal` / `index.db-shm` — the full database before any row was deleted
- `session-…__*.json` — the bili snapshots that were moved away
- `ledger.json` — the full ledger before it was edited (only when the ledger was touched)
- `cost-files/` — the cost-meter detail files that were removed

Restoring is the **Restore latest backup** trigger above. If bili happens to hold the database
lock at that moment, the files are written as `index.db.restored-<timestamp>*` for you to swap
in manually — the running database is never overwritten by force.

## Logs

Under `~/.dsh/storages/session-leftover-purge/`:

- `purge.log` — one `ready v…` line per start, one line per purge / restore / backup deletion
- `orphans.json` — result of the last reconcile pass
- `triggers.json` — the trigger numbers that have already fired

## Limits

- Only covers deletes made through archive-manager; other paths are caught by the boot reconcile.
- bili's `index.db` belongs to another process, so a `SQLITE_BUSY` is skipped and retried next time.
- Never touches DSH attachments or Electron's localStorage.
- Every failure is logged only; nothing is thrown into DSH's own delete flow.

MIT License.
