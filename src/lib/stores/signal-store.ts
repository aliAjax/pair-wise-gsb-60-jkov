import { browser } from '$app/environment';
import type {
  AuditEntry,
  CaseVersion,
  EvidenceItem,
  InvestigationTask,
  SignalCase,
  SignalStatus,
  RiskLevel
} from '$lib/models/signal';
import type { SignalRecalcPlan } from '$lib/services/recalc-engine';
import { seedSignals } from '$lib/services/seed';
import { get, writable } from 'svelte/store';

const STORAGE_KEY = 'medical-safety-signals-v1';

function cloneSeed(): SignalCase[] {
  return normalizeSignals(structuredClone(seedSignals));
}

/** 旧版本本地数据没有重算版本字段，补齐为 null（尚未纳入物化）。 */
function normalizeSignals(signals: SignalCase[]): SignalCase[] {
  for (const signal of signals) {
    if (signal.recalcVersion === undefined) signal.recalcVersion = null;
    for (const task of signal.tasks) {
      if (task.reschedule === undefined) delete (task as Partial<InvestigationTask>).reschedule;
    }
  }
  return signals;
}

function readPersisted(): SignalCase[] {
  if (!browser) return cloneSeed();

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeSignals(JSON.parse(raw) as SignalCase[]) : cloneSeed();
  } catch {
    return cloneSeed();
  }
}

const internal = writable<SignalCase[]>(readPersisted());

if (browser) {
  internal.subscribe((value) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  });
}

function now() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
}

function riskFromSeverity(severity: number): RiskLevel {
  if (severity >= 5) return 'critical';
  if (severity >= 4) return 'high';
  if (severity >= 3) return 'medium';
  return 'low';
}

function statusLabel(status: SignalStatus) {
  const labels: Record<SignalStatus, string> = {
    new: '待分派',
    investigating: '调查中',
    observed: '持续观察',
    action_required: '待处置',
    review: '复核中',
    closed: '已关闭'
  };
  return labels[status];
}

function appendAudit(signal: SignalCase, actor: string, action: string, detail: string) {
  signal.audit.unshift({
    id: makeId('AUD'),
    actor,
    action,
    detail,
    createdAt: now()
  });
  signal.updatedAt = now();
}

export const signalStore = {
  subscribe: internal.subscribe,

  add(signal: SignalCase) {
    internal.update((items) => [signal, ...items]);
  },

  create(input: Omit<SignalCase, 'id' | 'openedAt' | 'updatedAt' | 'audit' | 'reopenedCount'>) {
    const createdAt = now();
    const signal: SignalCase = {
      ...input,
      id: `SIG-${new Date().getFullYear()}-${String(get(internal).length + 20).padStart(3, '0')}`,
      openedAt: createdAt,
      updatedAt: createdAt,
      reopenedCount: 0,
      audit: [
        {
          id: makeId('AUD'),
          actor: input.owner,
          action: '建立信号',
          detail: `按${input.sourceType}来源建立核查任务。`,
          createdAt
        }
      ]
    };
    internal.update((items) => [signal, ...items]);
    return signal;
  },

  transition(id: string, nextStatus: SignalStatus, reason: string, actor: string) {
    internal.update((items) =>
      items.map((signal) => {
        if (signal.id !== id) return signal;
        const updated = structuredClone(signal);
        const previous = updated.status;
        updated.status = nextStatus;
        if (nextStatus === 'action_required' && updated.riskLevel === 'low') {
          updated.riskLevel = 'medium';
        }
        appendAudit(
          updated,
          actor,
          '状态流转',
          `${statusLabel(previous)} -> ${statusLabel(nextStatus)}；依据：${reason}`
        );
        return updated;
      })
    );
  },

  addEvidence(id: string, evidence: EvidenceItem, actor: string) {
    internal.update((items) =>
      items.map((signal) => {
        if (signal.id !== id) return signal;
        const updated = structuredClone(signal);
        updated.evidence.unshift(evidence);
        appendAudit(
          updated,
          actor,
          '新增证据',
          `${evidence.title}，证据强度：${evidence.strength}`
        );
        return updated;
      })
    );
  },

  addVersion(id: string, version: CaseVersion, actor: string) {
    internal.update((items) =>
      items.map((signal) => {
        if (signal.id !== id) return signal;
        const updated = structuredClone(signal);
        updated.versions.unshift(version);
        appendAudit(updated, actor, '形成版本', `版本 V${version.version}：${version.summary}`);
        return updated;
      })
    );
  },

  reopen(id: string, actor: string, reason: string) {
    internal.update((items) =>
      items.map((signal) => {
        if (signal.id !== id) return signal;
        const updated = structuredClone(signal);
        updated.status = 'investigating';
        updated.reopenedCount += 1;
        appendAudit(updated, actor, '重新打开', reason);
        return updated;
      })
    );
  },

  replaceTask(id: string, task: InvestigationTask) {
    internal.update((items) =>
      items.map((signal) => {
        if (signal.id !== id) return signal;
        const updated = structuredClone(signal);
        updated.tasks = updated.tasks.map((item) => (item.id === task.id ? task : item));
        appendAudit(updated, task.owner, '更新任务', `${task.title}：${task.status}`);
        return updated;
      })
    );
  },

  addAudit(id: string, entry: AuditEntry) {
    internal.update((items) =>
      items.map((signal) => {
        if (signal.id !== id) return signal;
        const updated = structuredClone(signal);
        updated.audit.unshift(entry);
        updated.updatedAt = entry.createdAt;
        return updated;
      })
    );
  },

  /**
   * 重算引擎 finalize 后把已提交版本应用到信号表（聚合数字 + 任务期限 + 审计）。
   * 幂等且单调：只接受比信号当前 recalcVersion 更新的版本，断点重放不会重复收紧期限。
   */
  applyRecalc(plan: SignalRecalcPlan) {
    internal.update((items) =>
      items.map((signal) => {
        const update = plan.signals.find((item) => item.signalId === signal.id);
        if (!update) return signal;
        if (signal.recalcVersion !== null && signal.recalcVersion >= plan.version) return signal;

        const updated = structuredClone(signal);
        const previousRate = updated.occurrenceRate || 0;
        updated.reportCount = update.reportCount;
        updated.exposedUnits = update.exposedUnits;
        updated.occurrenceRate = update.rate ?? 0;
        updated.recalcVersion = plan.version;

        for (const reschedule of update.reschedules) {
          updated.tasks = updated.tasks.map((task) =>
            task.id === reschedule.taskId && !task.reschedule
              ? {
                  ...task,
                  dueAt: reschedule.to,
                  reschedule: {
                    from: reschedule.from,
                    to: reschedule.to,
                    reason: reschedule.reason,
                    at: new Date().toISOString(),
                    byJobId: plan.jobId
                  }
                }
              : task
          );
        }

        appendAudit(
          updated,
          '重算引擎',
          '发生率重算',
          `V${plan.version}（任务 ${plan.jobId}）：报告 ${update.reportCount} 条 / 装机 ${update.exposedUnits} 台，发生率 ${previousRate.toFixed(2)}% -> ${(update.rate ?? 0).toFixed(2)}%` +
            (update.reschedules.length ? `；${update.reschedules.length} 项调查任务按新风险收紧期限` : '') +
            '。'
        );
        return updated;
      })
    );
  },

  /** 由重算模块在整库重置时联动调用。 */
  setSignals(signals: SignalCase[]) {
    internal.set(normalizeSignals(structuredClone(signals)));
  },

  reset() {
    internal.set(cloneSeed());
  },

  getSnapshot() {
    return get(internal);
  }
};

export function createSignalFromForm(input: {
  title: string;
  product: string;
  batch: string;
  sourceType: SignalCase['sourceType'];
  severity: number;
  occurredAt: string;
  description: string;
}): SignalCase {
  const nowIso = now();
  return {
    id: `SIG-${new Date().getFullYear()}-${String(Date.now()).slice(-3)}`,
    title: input.title,
    product: input.product,
    batch: input.batch,
    sourceType: input.sourceType,
    status: 'new',
    riskLevel: riskFromSeverity(input.severity),
    severity: input.severity,
    reportCount: 1,
    exposedUnits: 0,
    occurrenceRate: 0,
    occurredAt: input.occurredAt,
    openedAt: nowIso,
    updatedAt: nowIso,
    owner: '待分派',
    description: input.description,
    affectedBatches: [input.batch],
    evidence: [],
    tasks: [
      {
        id: makeId('TASK'),
        title: '核对来源记录与产品批号',
        owner: '待分派',
        dueAt: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
        status: 'open'
      }
    ],
    versions: [],
    audit: [
      {
        id: makeId('AUD'),
        actor: '安全台账',
        action: '建立信号',
        detail: '由人工登记表单创建初始信号。',
        createdAt: nowIso
      }
    ],
    reopenedCount: 0,
    recalcVersion: null
  };
}
