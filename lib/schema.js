import z from '@deepseek-ai/schemastery';

/**
 * Editable in Settings → Plugins. Every field is `.volatile()`, which is what
 * makes it show up in the plugin form and lets an edit take effect without a
 * restart (the Loader hands `apply` live references and commits edits in place).
 *
 * The last three fields are not values but triggers: DSH renders schema fields,
 * not buttons, so an action is expressed as "bump this number". The plugin
 * remembers the last number it acted on, which makes each bump fire exactly once.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).description('总开关；关掉后不再清理，也不再监听删除').volatile(),
  biliJson: z.boolean().default(true).description('删掉 bili 面板里该会话的那一条').volatile(),
  biliIndexDb: z.boolean().default(true).description('删掉索引里的行；删前自动备份，可回滚').volatile(),
  costMeterLedger: z.boolean().default(false).description('只删账本明细行，当日总额不动').volatile(),
  costMeterFiles: z.boolean().default(false).description('删掉每轮用量的凭证文件；不影响总额').volatile(),
  vacuumIndexDb: z.boolean().default(false).description('开机回收 index.db 空间；失败不影响数据').volatile(),
  trashRetentionDays: z.natural().default(7).description('保留天数；0 = 永久保留').volatile(),
  dryRun: z.boolean().default(false).description('只写日志，不移动也不删除').volatile(),
  reconcileOnBoot: z.boolean().default(true).description('启动时扫描孤儿快照并写报告').volatile(),
  autoPurgeOrphans: z.boolean().default(false).description('对账发现孤儿就直接清理').volatile(),
  bootDelayMs: z.natural().default(8000).description('开机对账前等待的毫秒数').volatile(),
  restoreBackupTrigger: z.natural().default(0).description('填入新数字并保存 = 执行一次').volatile(),
  deleteBackupsTrigger: z.natural().default(0).description('填入新数字并保存 = 执行一次，不可恢复').volatile(),
  backupLedgerTrigger: z.natural().default(0).description('填入新数字并保存 = 执行一次').volatile(),
});

export default Config;
