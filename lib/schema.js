import z from '@deepseek-ai/schemastery';

/**
 * Editable in Settings → Plugins. Every field is `.volatile()`, which is what
 * makes it show up in the plugin form and lets an edit take effect without a
 * restart (the Loader hands `apply` live references and commits edits in place).
 *
 * The last two fields are not values but triggers: DSH renders schema fields,
 * not buttons, so an action is expressed as "bump this number". The plugin
 * remembers the last number it acted on, which makes each bump fire exactly once.
 */
export const Config = z.object({
  enabled: z
    .boolean()
    .default(true)
    .description('总开关：关闭后不再监听会话删除事件，也不做开机对账')
    .volatile(),
  biliJson: z
    .boolean()
    .default(true)
    .description('删除会话时移除 billion-context 的 JSON 快照（bili 面板里列出的那一条）')
    .volatile(),
  biliIndexDb: z
    .boolean()
    .default(true)
    .description('同时从 bili 的 SQLite 索引里删掉该会话（清理前自动完整备份 index.db + WAL，可回滚）')
    .volatile(),
  costMeterLedger: z
    .boolean()
    .default(false)
    .description(
      '同时清理 dsh-cost-meter 账本里该会话的明细行。只删明细、不动当日总额——那笔钱确实花过，' +
        '改总额等于抹账。清理前把 ledger.json 完整备份进批次，可回滚。',
    )
    .volatile(),
  costMeterFiles: z
    .boolean()
    .default(false)
    .description(
      '同时清理 dsh-cost-meter 的原始明细文件（ledger.json.billion-context 下的 groups / streams / calls）。' +
        '不影响账本里的任何总额，但会丢掉「哪一轮花了多少」的凭证。删前先复制进批次，可回滚。',
    )
    .volatile(),
  vacuumIndexDb: z
    .boolean()
    .default(false)
    .description(
      '开机时对 bili 的 index.db 执行一次 VACUUM + WAL 截断，把已删行占用的空间真正回收。' +
        '需要独占锁；拿不到就跳过。VACUUM 失败会回滚，不会损坏数据库。',
    )
    .volatile(),
  trashRetentionDays: z
    .natural()
    .default(7)
    .description('trash 批次保留天数。超过即在下次启动时删除。设为 0 表示永久保留。')
    .volatile(),
  dryRun: z
    .boolean()
    .default(false)
    .description('演练模式：只在 purge.log 里记录将要做什么，不移动也不删除任何文件')
    .volatile(),
  reconcileOnBoot: z
    .boolean()
    .default(true)
    .description('启动时扫描一次「有快照但没有对应会话」的孤儿，并写 orphans.json 报告')
    .volatile(),
  autoPurgeOrphans: z
    .boolean()
    .default(false)
    .description('开机对账发现孤儿时直接清理（默认只报告，不动手）')
    .volatile(),
  bootDelayMs: z
    .natural()
    .default(8000)
    .description('开机对账的延迟毫秒数，给宿主留出恢复会话的时间')
    .volatile(),
  restoreBackupTrigger: z
    .natural()
    .default(0)
    .description('恢复最近一次备份：把数字改成任意新值（1、2、3…）并保存，即执行一次')
    .volatile(),
  deleteBackupsTrigger: z
    .natural()
    .default(0)
    .description('删除全部备份：把数字改成任意新值并保存即执行一次，不可恢复')
    .volatile(),
  backupLedgerTrigger: z
    .natural()
    .default(0)
    .description('备份一次 cost-meter 账本：把数字改成任意新值并保存即执行一次（只复制，不修改账本）')
    .volatile(),
});

export default Config;
