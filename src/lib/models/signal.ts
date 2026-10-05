import { z } from 'zod';

export const signalStatuses = [
  'new',
  'investigating',
  'observed',
  'action_required',
  'review',
  'closed'
] as const;

export const riskLevels = ['low', 'medium', 'high', 'critical'] as const;
export const evidenceStrengths = ['strong', 'moderate', 'weak', 'contrary'] as const;

export const createSignalSchema = z.object({
  title: z.string().trim().min(6, '信号标题至少 6 个字符'),
  product: z.string().trim().min(2, '请输入产品名称'),
  batch: z.string().trim().min(2, '请输入批号'),
  sourceType: z.enum(['complaint', 'repair', 'adverse_event', 'field_report']),
  severity: z.coerce.number().int().min(1).max(5),
  occurredAt: z.string().min(1, '请选择发生日期'),
  description: z.string().trim().min(10, '经过说明至少 10 个字符')
});

export const transitionSchema = z.object({
  id: z.string().min(1),
  nextStatus: z.enum(signalStatuses),
  reason: z.string().trim().min(4, '请填写流转依据'),
  actor: z.string().trim().min(2, '请填写操作人')
});

export const evidenceSchema = z.object({
  id: z.string().min(1),
  evidenceType: z.enum(['complaint', 'repair', 'adverse_event', 'field_report', 'test', 'literature']),
  title: z.string().trim().min(4, '证据名称至少 4 个字符'),
  source: z.string().trim().min(2, '请填写来源'),
  strength: z.enum(evidenceStrengths),
  batch: z.string().trim().min(1, '请填写关联批号'),
  note: z.string().trim().min(4, '请填写核查说明')
});

export const versionSchema = z.object({
  id: z.string().min(1),
  author: z.string().trim().min(2, '请填写版本作者'),
  summary: z.string().trim().min(8, '结论摘要至少 8 个字符'),
  disposition: z.enum(['continue_observation', 'risk_communication', 'corrective_action']),
  rationale: z.string().trim().min(6, '请填写判断依据')
});

/**
 * 现场报告补录 / 撤回表单。
 * dedupKey 为外部报告号等业务幂等键：同一键重复补录只算一次。
 * batches 为逗号或顿号分隔的多个批号，服务端按批号拆开。
 */
export const fieldReportSchema = z.object({
  dedupKey: z.string().trim().min(3, '请填写可去重的报告号（至少 3 个字符）'),
  batches: z
    .string()
    .trim()
    .min(1, '请填写至少一个批号，多个批号用逗号分隔')
    .transform((value) =>
      Array.from(
        new Set(
          value
            .split(/[,，、;；\s]+/)
            .map((item) => item.trim())
            .filter(Boolean)
        )
      )
    )
    .refine((batches) => batches.length >= 1, '请填写至少一个批号'),
  action: z.enum(['supplement', 'withdraw']),
  signalId: z.string().trim().optional(),
  actor: z.string().trim().min(2, '请填写操作人（至少 2 个字符）'),
  note: z.string().trim().min(4, '请填写补录 / 撤回说明（至少 4 个字符）')
});

/**
 * 批号装机量修正表单。expectedRevision 为打开表单时看到的版本，
 * 用于两位同事同时修正同一批号时的乐观冲突检测。
 */
export const installBaseSchema = z.object({
  batch: z.string().trim().min(1, '请填写批号'),
  installedUnits: z.coerce.number().int('装机量须为整数').min(0, '装机量不能为负'),
  expectedRevision: z.coerce.number().int().min(0),
  actor: z.string().trim().min(2, '请填写操作人（至少 2 个字符）')
});

export type SignalStatus = (typeof signalStatuses)[number];
export type RiskLevel = (typeof riskLevels)[number];
export type EvidenceStrength = (typeof evidenceStrengths)[number];
export type SignalSourceType = z.infer<typeof createSignalSchema>['sourceType'];
export type Disposition = z.infer<typeof versionSchema>['disposition'];
export type FieldReportInput = z.infer<typeof fieldReportSchema>;
export type InstallBaseInput = z.infer<typeof installBaseSchema>;

export interface EvidenceItem {
  id: string;
  type: SignalSourceType | 'test' | 'literature';
  title: string;
  source: string;
  strength: EvidenceStrength;
  batch: string;
  note: string;
  createdAt: string;
}

export interface InvestigationTask {
  id: string;
  title: string;
  owner: string;
  dueAt: string;
  status: 'open' | 'in_progress' | 'done';
  /** 最近一次按重算结果排期的记录，用于审计任务期限为何变化。 */
  reschedule?: {
    from: string;
    to: string;
    reason: string;
    at: string;
    byJobId: string;
  };
}

export interface CaseVersion {
  id: string;
  version: number;
  author: string;
  summary: string;
  disposition: Disposition;
  rationale: string;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  detail: string;
  createdAt: string;
}

export interface SignalCase {
  id: string;
  title: string;
  product: string;
  batch: string;
  sourceType: SignalSourceType;
  status: SignalStatus;
  riskLevel: RiskLevel;
  severity: number;
  reportCount: number;
  exposedUnits: number;
  occurrenceRate: number;
  occurredAt: string;
  openedAt: string;
  updatedAt: string;
  owner: string;
  description: string;
  affectedBatches: string[];
  evidence: EvidenceItem[];
  tasks: InvestigationTask[];
  versions: CaseVersion[];
  audit: AuditEntry[];
  reopenedCount: number;
  /** 最近一次把该信号数字刷新到的有效重算版本；null 表示尚未纳入重算。 */
  recalcVersion: number | null;
}

export interface SignalFilters {
  query?: string;
  status?: SignalStatus | 'all';
  riskLevel?: RiskLevel | 'all';
  sourceType?: SignalSourceType | 'all';
}

/* ---------- 可恢复重算：事实层与任务模型 ---------- */

/** 报告在一个批号上的拆账：补录一条多批号报告时按批号等分。 */
export interface ReportBatchAllocation {
  batch: string;
  reports: number;
}

export interface FieldReport {
  id: string;
  /** 业务幂等键（外部报告号），同一键重复补录只承认第一次。 */
  dedupKey: string;
  action: 'supplement' | 'withdraw';
  batches: string[];
  signalId: string | null;
  actor: string;
  note: string;
  createdAt: string;
  /** 再次补录同一键时递增；撤回不删行，保留审计轨迹。 */
  revision: number;
  withdrawnAt?: string;
}

export interface BatchInstallBase {
  batch: string;
  installedUnits: number;
  /** 装机量修正的乐观锁版本。 */
  revision: number;
  updatedAt: string;
  updatedBy: string;
}

export interface BatchRateSnapshot {
  batch: string;
  reportCount: number;
  installedUnits: number;
  /** 装机量为 0 时发生率不可计算，为 null。 */
  rate: number | null;
  /** 当前数字所属的物化版本；与全局 effectiveVersion 不一致即为待更新。 */
  version: number;
  computedAt: string;
  /** 非空表示旧发生率已失效、正在等待该任务重算提交。 */
  staleSince: string | null;
  staleJobId: string | null;
}

export type RecalcStage =
  | 'mark_stale'
  | 'batch_rates'
  | 'signal_refresh'
  | 'finalize';

export type RecalcJobStatus = 'running' | 'failed' | 'committed';

export interface RecalcJob {
  id: string;
  status: RecalcJobStatus;
  /** 本次报告变化影响的批号。 */
  affectedBatches: string[];
  /** 已完成 checkpoint 的阶段，断点恢复时从下一阶段继续。 */
  completedStages: RecalcStage[];
  /** batch_rates 阶段内逐批号完成的子断点。 */
  doneBatches: string[];
  /** 提交成功后该任务对应的有效版本。 */
  targetVersion: number;
  committedVersion: number | null;
  reason: string;
  actor: string;
  createdAt: string;
  updatedAt: string;
  failure: { at: RecalcStage; message: string; atTime: string } | null;
}

export interface RecalcConflict {
  id: string;
  batch: string;
  actor: string;
  /** 后到者提交时依据的旧 revision（其输入被保留）。 */
  expectedRevision: number;
  /** 先到者已经写入的 revision。 */
  actualRevision: number;
  proposedUnits: number;
  installedUnits: number;
  jobId: string | null;
  message: string;
  createdAt: string;
  resolved: boolean;
}
