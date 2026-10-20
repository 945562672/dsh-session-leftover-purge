# dsh-session-leftover-purge

删掉一个会话后，DeepSeek Harness 自己的记录清干净了，但 **billion-context** 的快照和索引、
**cost-meter** 的账本明细还留着。于是 bili 面板里还能看到那条会话，它的正文也还在
`index.db` 里。这个插件订阅 DSH 的 `api-session/removed` 事件，把剩下的部分补完。

**/ Purge what DSH leaves behind.** Deleting a session clears DSH's own transcript, but
billion-context keeps a JSON snapshot plus its `index.db`, and cost-meter keeps its ledger
rows. This plugin listens to `api-session/removed` and finishes the cleanup.

## 安装

```bash
dsh plugin add github:945562672/dsh-session-leftover-purge
```

**装完必须完全退出并重新打开 DSH。** host 半侧由 Loader 在进程启动时装载，运行中新装的包
不会挂进当前进程。刷新页面只更新设置页里的表单，不会让清理逻辑生效。

## 使用

装好后不需要任何操作。默认只做两件事：

| 项目 | 默认 | 说明 |
|---|---|---|
| bili JSON 快照 | 开 | 删掉 bili 面板里该会话的那一条 |
| bili SQLite 索引 | 开 | 删掉 `index.db` 里的行；删前自动备份，可回滚 |
| cost-meter 账本明细 | 关 | 只删明细行，当日总额不动 |
| cost-meter 原始明细文件 | 关 | 删掉每轮用量的凭证文件；不影响总额 |
| 开机回收 index.db 空间 | 关 | 回收已删行占用的空间；失败不影响数据 |
| 备份保留天数 | 7 天 | 过期即删；`0` = 永久保留 |
| 演练模式 | 关 | 只写日志，不移动也不删除 |
| 开机对账 | 开 | 启动时扫描孤儿快照并写报告 |
| 自动清理孤儿 | 关 | 对账发现孤儿就直接清理 |
| 开机延迟 | 8000 ms | 开机对账前等待多久 |

开关在 **设置 → 插件 → 插件管理 → dsh-session-leftover-purge**。改动即时生效，不用重启。

「恢复最近备份 / 删除全部备份 / 立即备份账本」三个字段是触发器：**填入一个新数字并保存**就
执行一次（DSH 的表单没有按钮，只能这样表达动作）。备份保留天数以下的批次会在下次启动时删掉。

## 备份与恢复

每次清理都在 `~/.dsh/storages/session-leftover-purge/trash/<时间戳>/` 留一份可还原的副本：

- `index.db` / `index.db-wal` / `index.db-shm` —— 删行前的完整数据库
- `session-…__*.json` —— 移走的 bili 快照
- `ledger.json` —— 改账本前的完整副本（如果动过账本）
- `cost-files/` —— 删掉的 cost-meter 明细文件

恢复入口就是上面那个「恢复最近备份」触发器。恢复时如果 bili 正持有数据库锁，会把文件写成
`index.db.restored-<时间戳>*` 让你手动换，不会强行覆盖。

## 日志

`~/.dsh/storages/session-leftover-purge/`：

- `purge.log` —— 每次启动一行 `ready v…`，每次清理 / 恢复 / 删备份各一行
- `orphans.json` —— 最近一次对账结果
- `triggers.json` —— 已执行过的触发器数字

## 边界

- 只处理通过 archive-manager 删除会话的场景；其它途径靠开机对账发现。
- bili 的 `index.db` 属于另一个进程，遇到 `SQLITE_BUSY` 会跳过，下次再处理。
- 不碰 DSH 的附件、不碰 Electron 的 localStorage。
- 任何失败都只写日志，不抛给 DSH 的删除流程。

---

## English

**What it does.** DeepSeek Harness clears its own session store, but
[billion-context](https://github.com/ranxianglei/billion-context) keeps a JSON snapshot per
session plus a shared `index.db`, and `dsh-cost-meter` keeps ledger rows. A deleted
conversation therefore keeps showing up in bili's panel and its text stays in the database.
This plugin subscribes to the public `api-session/removed` event and removes those leftovers.

**Install.** `dsh plugin add github:945562672/dsh-session-leftover-purge`
Then **fully quit and reopen DSH** — the host half is loaded at process start.

**Use.** Nothing to configure. By default it removes the bili JSON snapshot and the
`index.db` rows for the deleted session, with an automatic backup you can restore. The
cost-meter options and the `index.db` vacuum are opt-in and off by default.

**Backups.** Every purge keeps a restorable copy under
`~/.dsh/storages/session-leftover-purge/trash/<timestamp>/`. Batches older than
`trashRetentionDays` (default 7, `0` = keep forever) are removed on the next start.

**Logs.** `~/.dsh/storages/session-leftover-purge/purge.log`.

MIT License.
