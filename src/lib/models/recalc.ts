import { z } from 'zod';
import type { RiskLevel } from './signal';

/* ---------------- 现场报告 ---------------- */

export const fieldReportSources = ['field_report', 'complaint', 'repair', 'adverse_event'] as const;
export type FieldReportSource = (typeof fieldReportSources)[number];

export interface FieldReport {
  /** 外部报告号（监管/客服/维修系统的原始编号），同一报告重复补录按它去重。 */
  reportRef: string;
  /** 同一份外部报告覆盖多个批号时按批号拆开，batchKey = `${reportRef}::${batch}`。 */
  batch: string;
  signalId: string;
  source: FieldReportSource;
  occurredAt: string; // YYYY-MM-DD
  receivedAt: string; // ISO
  actor: string;
  withdrawn: boolean;
  /** 由哪次作业写入/撤回，用于审计追溯。 */
  jobId?: string;
}

/* ---------------- 批号装机量 ---------------- */

export interface BatchInstall {
  batch: string;
  units: number;
  revision: number; // 每次修正 +1，作为乐观锁基线
  updatedAt: string; // ISO
  updatedBy: string;
  jobId?: string;
}

/* ---------------- 批号重算结果 ---------------- */

export type BatchRateStatus = 'valid' | 'install_missing';

export interface BatchResult {
  batch: string;
  reportCount: number;
  exposedUnits: number;
  /** 发生率（%），装机量为 0/未登记时为 null。 */
  occurrenceRate: number | null;
  status: BatchRateStatus;
  computedAt: string; // ISO
  version: number; // 产出该结果的 RV 版本
}

/* ---------------- 重算作业 ---------------- */

export type JobKind = 'backfill' | 'withdraw' | 'install_correction';
export type JobStatus =
  | 'queued'
  | 'running'
  | 'conflicted' // 装机量修正遇到并发冲突，保留输入等待用户裁决
  | 'failed' // 提交阶段写入失败，可从断点继续
  | 'duplicate' // 同一报告重复补录，仅登记不重算
  | 'committed';

export interface BackfillInput {
  reportRef: string;
  signalId: string;
  batches: string[];
  source: FieldReportSource;
  occurredAt: string;
  actor: string;
}

export interface WithdrawInput {
  batchKey: string; // reportRef::batch
  actor: string;
  reason: string;
}

export interface InstallCorrectionInput {
  batch: string;
  units: number;
  /** 提交时看到的 revision；与当前 revision 不一致即冲突。 */
  expectedRevision: number;
  actor: string;
}

export interface RecalcJob {
  id: string;
  kind: JobKind;
  status: JobStatus;
  input: BackfillInput | WithdrawInput | InstallCorrectionInput;
  createdAt: string;
  committedAt?: string;
  version?: number;
  /** 已完成的阶段下标，恢复时从 checkpoint+1 继续。 */
  checkpoint: number;
  /** 输入阶段识别出的受影响批号（这些批号立即进入待更新）。 */
  affectedBatches: string[];
  /** 冲突/失败/重复原因说明。 */
  note?: string;
  /** 已被计入过一次的 attempt，用于失败注入只触发一次。 */
  attempts: number;
}

/* ---------------- 冲突记录 ---------------- */

export interface InstallConflict {
  id: string;
  batch: string;
  jobId: string;
  actor: string;
  /** 后到者保留下来的输入。 */
  proposedUnits: number;
  expectedRevision: number;
  /** 先到者已生效的装机量与修订号。 */
  currentUnits: number;
  currentRevision: number;
  createdAt: string;
  resolved: boolean;
}

/* ---------------- 全局审计（重算台账） ---------------- */

export interface RecalcAuditEntry {
  id: string;
  version: number;
  jobId: string;
  kind: JobKind | 'recovery';
  actor: string;
  action: string;
  detail: string;
  createdAt: string;
}

/* ---------------- 原子提交计划 ---------------- */

/**
 * 两阶段提交的待完成计划：prepare 阶段先持久化它（与 reports/installs 同一份状态），
 * 再调用 signalStore.applyRecalc 写信号，成功后清除。
 * 若进程在清除前崩溃，下次启动时按 plan 幂等重放，因此绝不会留下半套数字。
 */
export interface PendingCommit {
  jobId: string;
  version: number;
  committedAt: string;
  staleBatches: string[];
  batchResults: BatchResult[];
  signalPatches: Record<string, import('./signal').SignalRecalcPatch>;
  ledger: RecalcAuditEntry[];
}

export interface RecalcState {
  reports: FieldReport[];
  installs: Record<string, BatchInstall>;
  batchResults: Record<string, BatchResult>;
  jobs: RecalcJob[];
  conflicts: InstallConflict[];
  ledger: RecalcAuditEntry[];
  /** 当前全局唯一有效的重算版本号。 */
  currentVersion: number;
  /** 待更新批号：输入一落库就置位，成功提交后随新结果一起清除。 */
  staleBatches: string[];
  pendingCommit: PendingCommit | null;
}

/* ---------------- 提交结果（返回给 UI） ---------------- */

export type SubmitOutcome =
  | { type: 'committed'; job: RecalcJob; version: number }
  | { type: 'duplicate'; job: RecalcJob; reportRef: string; batches: string[] }
  | {
      type: 'conflict';
      job: RecalcJob;
      conflict: InstallConflict;
    }
  | { type: 'failed'; job: RecalcJob; error: string }
  | { type: 'blocked'; reason: string };

/* ---------------- 表单校验（Form Action + Zod） ---------------- */

export const backfillSchema = z.object({
  reportRef: z.string().trim().min(3, '外部报告号至少 3 个字符'),
  signalId: z.string().trim().min(1, '请选择关联信号'),
  batches: z
    .string()
    .trim()
    .min(1, '请填写批号')
    .transform((value) =>
      Array.from(
        new Set(
          value
            .split(/[,，、\s]+/)
            .map((item) => item.trim())
            .filter(Boolean)
        )
      )
    ),
  source: z.enum(fieldReportSources),
  occurredAt: z.string().min(1, '请选择发生日期'),
  actor: z.string().trim().min(2, '操作人至少 2 个字符')
});

export const withdrawSchema = z.object({
  batchKey: z.string().trim().min(1),
  actor: z.string().trim().min(2, '操作人至少 2 个字符'),
  reason: z.string().trim().min(4, '撤回原因至少 4 个字符')
});

export const installCorrectionSchema = z.object({
  batch: z.string().trim().min(2, '请填写批号'),
  units: z.coerce.number().int('装机量须为整数').min(0, '装机量不能为负'),
  expectedRevision: z.coerce.number().int().min(0),
  actor: z.string().trim().min(2, '操作人至少 2 个字符')
});

export type RateRiskLevel = RiskLevel;
