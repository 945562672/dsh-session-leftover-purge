# dsh-session-leftover-purge

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](#license)

**DSH 插件**：archive-manager 删掉会话后，把 billion-context（bili）留下的快照与索引一并清干净。

**DeepSeek Harness plugin** that finishes the job when a session is deleted — it removes the
leftovers [billion-context](https://github.com/ranxianglei/billion-context) keeps in its own store.

---

## 安装

### 从 GitHub 安装

```bash
dsh plugin add github:945562672/dsh-session-leftover-purge
```

### 从本地目录安装（开发）

```bash
cd ~/.dsh/profiles/<profile>
pnpm add file:./local-plugins/dsh-session-leftover-purge
```

### ⚠️ 安装后必须完全退出并重新打开 DSH

这不是保险起见的说法，是机制决定的：

| 半侧 | 何时生效 |
|---|---|
| **host 半侧**（清理逻辑、事件订阅） | **必须重启 DSH** —— 插件由 DSH 的 Loader 在进程启动时装载，运行中新装的包不会挂进当前进程 |
| **client 半侧**（插件管理页里的配置卡） | 刷新页面即可（走浏览器 HMR），但 host 没加载时它不会注册 |

**怎么确认真的生效了**

重启后打开 `~/.dsh/storages/session-leftover-purge/purge.log`，第一行应该是：

```
ready v1.0.0 subscribed=api-session/removed biliJson=true biliIndexDb=true costMeterLedger=false dryRun=false
```

看到 `ready v…` 就说明这个版本的 host 半侧已经挂上事件了。**没有这一行 = 还没生效**，先别指望它清理任何东西。

**再验证一次端到端**：新建一个会话、随便发一句话、右键删除它，然后看 `purge.log`，
应该出现 `purge session-… moved=N`。`trash/<时间戳>/` 里会有被移走的文件。

**装好之后不再需要重启**：11 个配置项都是 `.volatile()` 字段，在插件管理页改完保存即刻生效。

---

## 为什么需要它

archive-manager 的删除动作会清掉 DSH 自己的会话痕迹（transcript 目录、投影缓存、工作区记账），
但清不掉 **billion-context（bili）自己的两份数据**：

1. 会话快照 JSON —— `%USERPROFILE%\.local\share\billion-context\sessions\<protocol>\*.json`
   （bili 面板 / `bili export` 列出的就是它）
2. 统一 SQLite 索引 —— 同目录的 `index.db`，正文与消息行都在这里

于是一个已删除的会话会继续出现在 bili 的设置面板里，正文也还留在库里。

本插件补上这两步。它**不改 archive-manager 的任何代码**，只订阅 DSH 的公共事件
`api-session/removed`（`@michengai/dsh-archive-manager/lib/workspace.js:987` 在
`deleteSessionCore()` 末尾发出，内核 `dsh-tool-cordis/lib/types/api-catalog.js:4068` 有正式签名）。

## 行为

删除事件到达时，按顺序：

1. 校验 id 形状（只接受 `session-…`）
2. 若 `~/.dsh/sessions/*/session-…/` 仍然存在 → 跳过并告警（绝不误删活会话）；
   这个跳过会在 1.5 秒后重试，最多 3 次尝试（删除事件有时比目录消失来得早）
3. 扫描 bili 快照目录，解析 JSON 的 `payload.id`，**精确匹配**才处理
4. 匹配到的快照 **移动到** `trash/<时间戳>/`，不硬删
5. 需要清库时，**先把 `index.db` + `-wal` + `-shm` 复制进同一批次**，复制成功才动库；
   复制失败就整段跳过（不可回滚的清理不做）
6. 库内按 `session_id` 删 messages / refs / blocks / conversations / sessions 等表，
   再清一次「`refcount <= 0` 且没有任何表引用」的 content 孤儿
7. 任何一步失败只写日志，不影响 DSH 的删除流程

启动后（默认延迟 8 秒）跑一次**只读对账**：列出「bili 里有、DSH 里没有」的孤儿会话，写入
`orphans.json` 并打一条警告日志。默认只报告不删除。

## 配置

**在 DSH 里直接改：插件管理 → `dsh-session-leftover-purge`。**

全部是 `.volatile()` 字段，改完**不必重启**，下一次删除就按新值执行。

| 表单项 | 字段 | 默认 | 说明 |
|---|---|---|---|
| 总开关 | `enabled` | 开 | 关掉后不订阅删除事件、不做开机对账（备份恢复仍可用） |
| 清理 bili JSON 快照 | `biliJson` | 开 | bili 面板里列出的那一条 |
| 清理 bili SQLite 索引 | `biliIndexDb` | 开 | 清理前自动备份三件套，可回滚；备份失败则不动库 |
| 清理 cost-meter 账本明细 | `costMeterLedger` | 关 | 只删该会话的明细行，**当日总额一个字节都不动**；清理前把 ledger.json 备份进批次。原因见下节 |
| 演练模式 | `dryRun` | 关 | 只写日志，不移动不删除 |
| 开机对账 | `reconcileOnBoot` | 开 | 只读扫描孤儿 |
| 自动清理孤儿 | `autoPurgeOrphans` | 关 | 对账发现孤儿时直接清 |
| 开机延迟（毫秒） | `bootDelayMs` | 8000 | 毫秒 |
| 恢复最近备份 | `restoreBackupTrigger` | 0 | **把数字改成任意新值（1、2、3…）保存，即执行一次** |
| 删除全部备份 | `deleteBackupsTrigger` | 0 | 同上，清空 `trash/`，不可恢复 |
| 立即备份账本 | `backupLedgerTrigger` | 0 | 同上，把 `ledger.json` 复制进一个新批次。只复制，不改账本 |

三个触发器是「动作」而不是开关：DSH 的通用表单只渲染 schema 字段、没有按钮，所以用
「数字递增一次 = 执行一次」表达动作。插件把上次执行到的数字记在 `triggers.json`，同一个数字不会重复触发。

> 配置页是插件自带的 client 半侧（`plugins.bundle.config` slot），不属于 DSH 的通用 schema 表单，
> 因此提供了「保存 / 恢复默认」两个按钮。**「恢复默认」只回填开关与延迟，不动三个触发器** ——
> 把触发器清零等于真的执行一次恢复或删除。

### 账本清理的边界（为什么默认关）

`ledger.json` 是这台机器上**唯一**记录「钱花在哪」的文件。bili 的 `index.db` 是 DSH 会话的派生副本，
删了还能重建；账本没有上游，删掉就真没了。所以这里只做一件事：

- **删明细，不删钱**：只移除 `days[*].sessions[]` 里该会话的那一行，
  `calls / cost / costCny / input / output / …` 这些当日累加字段原样保留。那笔钱确实花过，改总额等于抹账。
- cost-meter 自己也把这种剩余叫 *anonymous usage*，并在 `ledger-totals.js:37` 明确要求
  「保留这笔余额和它的钱，不要编造归属」。删明细后的状态正是它认可的合法形态。
- 所以清理之后：**今日费用金额不变**，只是「按会话」列表里少一条。想让金额跟着变小，那是抹账，本插件不做。
- 清理前把 `ledger.json` 整体复制进批次，`restoreBackupTrigger` 可原样还原。
- 写入前后各比对一次 `mtime` + `size`，并在 `rename` 之前再确认 `${ledger}.lock` 没有出现。
  `rename` 没有 CAS 形式，极小窗口内的并发写无法根除 —— 批次备份就是为这种万一准备的。
- 插件**不创建** `${ledger}.lock`。半吊子地冒充第二个锁持有者比不加锁更危险；cost-meter 持锁期间它只会退让。

### 无界面 / 回退方式

`~/.dsh/storages/session-leftover-purge/config.json`（不存在则全用默认值），同名键以设置页为准。

附件（`attachments`）**没有开关**：按内容寻址、多会话共享，删了会连带别的会话丢图，本插件永远不碰。

## 备份与恢复

一次清理 = 一个批次目录：

```
~/.dsh/storages/session-leftover-purge/trash/2026-10-21T02-15-33-123Z/
  session-0e374648…__api.deepseek.com_aca88450….json     ← bili 快照
  index.db                                                ← 清理前的库
  index.db-wal
  index.db-shm
  ledger.json                                             ← 改动前的账本（只有开了账本清理才有）
```

批次里出现哪些成员，取决于当次开了哪些开关；`backupLedgerTrigger` 产生的批次里只有 `ledger.json`。

**恢复最近一次备份**（`restoreBackupTrigger`）：

1. JSON 快照一律还原回原目录
2. 数据库先试 `BEGIN IMMEDIATE` 拿写锁：
   - **拿到** → 现有库改名为 `index.db.before-restore-<时间戳>`，再用批次里的三件套覆盖
   - **拿不到**（bili 正开着）→ 不覆盖，只把三个文件写成 `index.db.restored-<时间戳>*`
     放在 bili 目录旁，日志里给出确切路径；退出 DSH 后手动替换即可

拿不到锁就绝不覆盖，是这套恢复最重要的约定：往别人正写的 SQLite 库上盖文件会直接写坏。

**账本（`ledger.json`）走同一套规则**，只是"锁"换成 cost-meter 自己的 `${ledger}.lock` 目录：

- 锁不在 → 现有账本改名 `ledger.json.before-restore-<时间戳>` 留底，再用批次里的覆盖
- 锁在 → 不覆盖，写一份 `ledger.json.restored-<时间戳>` 在旁边，日志给出路径

**删除全部备份**（`deleteBackupsTrigger`）：`rm -rf trash/` 下所有批次，不可撤销。

## 日志

`~/.dsh/storages/session-leftover-purge/`

| 文件 | 内容 |
|---|---|
| `purge.log` | 每次启动一行 `ready v…`；每次清理 / 恢复 / 删备份各一行，含移动数量与来源 |
| `orphans.json` | 最近一次对账结果 |
| `triggers.json` | 已执行过的触发器数字 |
| `trash/<批次>/` | 可回滚的备份批次 |

## 已知限制

- 只在「通过 archive-manager 删除」时即时触发。其它删除途径靠启动对账发现。
- `index.db` 属于另一个进程（bili 代理），并发写走 WAL + `busy_timeout`；遇到 `SQLITE_BUSY` 会跳过，
  下次对账再处理。
- `ledger.json` 属于 cost-meter 进程。删除期间若它正在写账，本次清理会以
  `busy:cost-meter-lock-held` / `changed-during-read` / `changed-before-rename` 跳过，下次再处理。
  三个 reason 都出现在 `purge.log` 里，不会静默失败。
- 不清理 Electron 的 Local Storage / HTTP 缓存（文件常被占用，且 Chromium 自己会 compaction）。
- 不做 `VACUUM`：删行后文件体积不会立刻缩小，页会被复用。
- `blocks.covered_hash` 在现有库里本来就有悬挂引用（bili 自己的问题），
  按 `session_id` 精确删行不会让它更糟，但也修不好它。
- 卸载本插件不影响任何删除行为，只是不再自动清理。

## 安全边界

- **只移动，不硬删**：所有被清掉的文件都进 `trash/<时间戳>/`，可还原。
- **不可回滚的清理不做**：清库前备份失败就整段跳过。
- **活会话绝不误伤**：transcript 目录还在就判为活会话，跳过。
- **不碰附件**：附件按内容寻址、跨会话共享。
- **不改别人的账**：账本只删明细行，当日金额原样保留。
- **失败只影响自己**：任何异常都写日志，不抛给 DSH 的删除流程。

## English

**What it does.** DeepSeek Harness keeps its own session store, but
[billion-context](https://github.com/ranxianglei/billion-context) keeps a second one — a JSON
snapshot per session plus a shared `index.db`. Deleting a session through archive-manager removes
the former and leaves the latter, so the deleted conversation keeps showing up in bili's panel and
its text stays in the database. This plugin subscribes to the public `api-session/removed` event and
finishes the cleanup.

**Install.** `dsh plugin add github:945562672/dsh-session-leftover-purge`

**⚠️ Restart DSH after installing.** The host half is loaded by the DSH Loader at process start; a
package added while DSH is running is not mounted into the running process. Confirm it took effect by
looking for the `ready v…` line in `~/.dsh/storages/session-leftover-purge/purge.log`. After that
first restart, every setting in the plugin page applies immediately — no further restarts.

**Safety.** Files are moved into `trash/<timestamp>/`, never hard-deleted. The SQLite index is fully
backed up before it is touched; if the backup fails, the database is left alone. Live sessions are
never touched, attachments are never touched, and the cost ledger only loses per-session detail rows —
the daily total stays as it was, because that money was actually spent.

## License

MIT — see [LICENSE](LICENSE).
