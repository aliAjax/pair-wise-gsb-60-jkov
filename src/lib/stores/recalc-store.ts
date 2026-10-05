import { browser } from '$app/environment';
import type { SignalCase } from '$lib/models/signal';
import {
  RecalcEngine,
  type EngineGateway,
  type EnginePersistence,
  type RecalcEvent,
  type RecalcState,
  type RecalcStage
} from '$lib/services/recalc-engine';
import { signalStore } from './signal-store';
import { get, writable, type Writable } from 'svelte/store';

const RECALC_STORAGE_KEY = 'medical-safety-recalc-v1';
const FAULT_KEY = 'medical-safety-recalc-fault';

const emptyState: RecalcState = {
  schemaVersion: 1,
  effectiveVersion: 0,
  baselineReportCount: {},
  installBases: [],
  reports: [],
  snapshots: [],
  jobs: [],
  conflicts: [],
  events: []
};

/** localStorage 持久化；每次引擎写入后向 Svelte store 广播。 */
function createPersistence(notify: (state: RecalcState) => void): EnginePersistence & { clear(): void } {
  return {
    load() {
      try {
        const raw = localStorage.getItem(RECALC_STORAGE_KEY);
        return raw ? (JSON.parse(raw) as RecalcState) : null;
      } catch {
        return null;
      }
    },
    save(state) {
      localStorage.setItem(RECALC_STORAGE_KEY, JSON.stringify(state));
      notify(structuredClone(state));
    },
    clear() {
      localStorage.removeItem(RECALC_STORAGE_KEY);
    }
  };
}

const gateway: EngineGateway = {
  getSignals: () => get(signalStore),
  applyRecalc: (plan) => signalStore.applyRecalc(plan)
};

const clock = {
  now: () => new Date().toISOString(),
  today: () => new Date().toISOString().slice(0, 10),
  delay: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
};

/** 下一个执行中的任务在指定阶段制造一次写入失败，用于现场演练断点续算。 */
function createFaultMatcher(): (stage: RecalcStage, job: { id: string }) => boolean {
  return (stage) => {
    if (!browser) return false;
    const armed = sessionStorage.getItem(FAULT_KEY);
    if (armed === stage) {
      sessionStorage.removeItem(FAULT_KEY);
      return true;
    }
    return false;
  };
}

export function armFault(stage: RecalcStage) {
  if (browser) sessionStorage.setItem(FAULT_KEY, stage);
}

export const recalcStateStore: Writable<RecalcState> = writable(emptyState);

let engine: RecalcEngine | null = null;

if (browser) {
  const persistence = createPersistence((state) => recalcStateStore.set(state));
  const instance = new RecalcEngine(persistence, gateway, clock, createFaultMatcher());

  // 首次启动：从信号台账种子建立 V0 事实层与完整快照。
  if (!persistence.load()) {
    instance.seed(get(signalStore));
  }
  // 上次会话若有未提交 / 已提交未应用的任务，直接从断点继续。
  instance.recover();
  recalcStateStore.set(instance.getState());
  engine = instance;
}

function requireEngine(): RecalcEngine {
  if (!engine) throw new Error('重算引擎仅在浏览器环境可用');
  return engine;
}

export const recalc = {
  /** 新登记信号纳入基线并触发受影响批号重算。 */
  registerSignal(signal: SignalCase) {
    if (!browser) return;
    requireEngine().registerSignal(signal);
  },

  submitReport(input: {
    dedupKey: string;
    batches: string[];
    action: 'supplement' | 'withdraw';
    signalId?: string | null;
    actor: string;
    note: string;
  }) {
    return requireEngine().submitReport(input);
  },

  correctInstallBase(input: { batch: string; installedUnits: number; expectedRevision: number; actor: string }) {
    return requireEngine().correctInstallBase(input);
  },

  resolveConflict(conflictId: string, decision: 'overwrite' | 'discard', actor: string) {
    return requireEngine().resolveConflict(conflictId, decision, actor);
  },

  retry(jobId?: string) {
    return requireEngine().retry(jobId);
  },

  recordEvent(actor: string, kind: RecalcEvent['kind'], detail: string) {
    if (!browser) return;
    requireEngine().recordEvent(actor, kind, detail);
  },

  batchView(batch: string) {
    return requireEngine().batchView(batch);
  },

  signalView(signal: SignalCase) {
    return requireEngine().signalView(signal);
  },

  /** 整库重置（与信号台账联动）。 */
  resetAll() {
    if (!browser) return;
    localStorage.removeItem(RECALC_STORAGE_KEY);
    sessionStorage.removeItem(FAULT_KEY);
    signalStore.reset();
    const persistence = createPersistence((state) => recalcStateStore.set(state));
    const fresh = new RecalcEngine(persistence, gateway, clock, createFaultMatcher());
    fresh.seed(get(signalStore));
    fresh.recover();
    engine = fresh;
    recalcStateStore.set(fresh.getState());
  }
};
