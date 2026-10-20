# dsh-session-leftover-purge

**简体中文** | [English](README.en.md)

删掉一个会话后，DeepSeek Harness 自己的记录清干净了，但 **billion-context** 的快照和索引、
**cost-meter** 的账本明细还留着。于是 bili 面板里还能看到那条会话，它的正文也还在
`index.db` 里。这个插件订阅 DSH 的 `api-session/removed` 事件，把剩下的部分补完。

## 安装

```bash
# 默认：永远装 main 的最新提交（需要本机有 git）
dsh plugin add github:945562672/dsh-session-leftover-purge

# 需要锁死版本时，把 vX.Y.Z 换成 tags 页里的任意 tag
dsh plugin add github:945562672/dsh-session-leftover-purge#vX.Y.Z

# 不需要 git：永远取最新一版的 tgz
dsh plugin add https://github.com/945562672/dsh-session-leftover-purge/releases/latest/download/dsh-session-leftover-purge.tgz
```

三条命令都**不会随版本变化**，直接抄就行。

前两条由 pnpm 走 git 协议，目标机器必须有 `git`；第三条是普通 HTTPS 下载，只要求能访问
GitHub。每次发版都会同时上传两个附件：带版本号的 `…-X.Y.Z.tgz` 和固定名的
`dsh-session-leftover-purge.tgz`，后者就是 `latest/download/` 指向的那个。

**装完必须完全退出并重新打开 DSH。** host 半侧由 Loader 在进程启动时装载，运行中新装的包
不会挂进当前进程。刷新页面只更新设置页里的表单，不会让清理逻辑生效。

## 依赖

**必需**：DeepSeek Harness 本身（`>= 0.2.0-rc.1 < 0.3.0-0`）。插件不跑常驻服务；它唯一 import
的第三方包 `@deepseek-ai/schemastery` 由宿主提供——在 `peerDependencies` 里声明为 optional，
DSH 自带的 `dsh-settings` 本来就会装它，**不需要额外安装任何东西**。

**功能上配合**（缺了不会报错，只是对应能力自动跳过）：

| 组件 | 缺失时的表现 |
|---|---|
| `@michengai/dsh-archive-manager` | 没有「删除会话」入口，也不会触发清理，只能靠开机对账 |
| `billion-context`（bili） | 快照与索引两项跳过，日志记 `bili-sessions-root-missing` |
| `dsh-cost-meter` | 账本与明细文件两项跳过，日志记 `ledger-missing` / `cost-files-root-missing` |

也就是说：装上就能跑，缺谁就少清谁，不会因为别的插件没装而加载失败。

## 使用

装好后不需要任何操作。默认只做两件事：清掉 bili 的 JSON 快照和 `index.db` 里的行。

| 项目 | 默认 | 说明 |
|---|---|---|
| 总开关 | 开 | 关掉后不再清理，也不再监听删除 |
| bili JSON 快照 | 开 | 删掉 bili 面板里该会话的那一条 |
| bili SQLite 索引 | 开 | 删掉 bili 索引里的行；删前自动备份，可回滚 |
| cost-meter 账本明细 | 关 | 只删 cost-meter 账本里的明细行，总额不动 |
| cost-meter 原始明细文件 | 关 | 删掉 cost-meter 每轮用量的凭证文件 |
| 开机回收 index.db 空间 | 关 | 回收已删行占用的空间；失败不影响数据 |
| 备份保留天数 | 7 天 | 过期即删；`0` = 永久保留 |
| 演练模式 | 关 | 只写日志，不移动也不删除 |
| 开机对账 | 开 | 启动时扫描孤儿快照并写报告 |
| 自动清理孤儿 | 关 | 对账发现孤儿就直接清理 |
| 开机延迟 | 8000 ms | 开机对账前等待多久 |

开关在 **设置 → 插件 → 插件管理 → dsh-session-leftover-purge**。改动即时生效，不用重启。

「恢复最近备份 / 删除全部备份 / 立即备份 cost-meter 账本」三个字段是触发器：**填入一个新数字
并保存**就执行一次（DSH 的表单没有按钮，只能这样表达动作）。

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

MIT License.
