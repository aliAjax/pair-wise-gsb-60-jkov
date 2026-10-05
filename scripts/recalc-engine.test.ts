import assert from 'node:assert/strict';
import {
  RecalcEngine,
  RATE_THRESHOLD,
  RATE_CRITICAL,
  addBusinessDays,
  type EnginePersistence
} from '../src/lib/services/recalc-engine';
import type { RecalcState, SignalCase, InvestigationTask } from '../src/lib/models/signal';
import { seedSignals } from '../src/lib/services/seed';

let testCount = 0;
function test(name: string, fn: () => Promise<void> | void) {
  testCount += 1;
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((error) => {
      console.error(`  ✗ ${name}`);
      console.error(error);
      process.exitCode = 1;
    });
}

/* ---------- 测试夹具 ---------- */

function makeSignals(): SignalCase[] {
  const signals = structuredClone(seedSignals);
  for (const signal of signals) signal.recalcVersion = 0;
  return signals;
}

function makeGateway(initialSignals: SignalCase[]) {
  let signals = structuredClone(initialSignals);
  return {
    getSignals: () => signals,
    applyRecalc(plan: {
      version: number;
      jobId: string;
      signals: Array<{
        signalId: string;
        reportCount: number;
        exposedUnits: number;
        rate: number | null;
        reschedules: Array<{ signalId: string; taskId: string; title: string; from: string; to: string; reason: string }>;
      }>;
    }) {
      signals = signals.map((signal) => {
        const update = plan.signals.find((item) => item.signalId === signal.id);
        if (!update) return signal;
        if (signal.recalcVersion !== null && signal.recalcVersion >= plan.version) return signal;
        const next = structuredClone(signal);
        next.reportCount = update.reportCount;
        next.exposedUnits = update.exposedUnits;
        next.occurrenceRate = update.rate ?? 0;
        next.recalcVersion = plan.version;
        next.tasks = next.tasks.map((task) => {
          const r = update.reschedules.find((item) => item.taskId === task.id);
          if (!r || task.reschedule) return task;
          return {
            ...task,
            dueAt: r.to,
            reschedule: { from: r.from, to: r.to, reason: r.reason, at: '2026-10-05T00:00:00Z', byJobId: plan.jobId }
          };
        });
        return next;
      });
    },
    signals: () => signals
  };
}

const fixedNow = '2026-10-05T08:00:00.000Z';

/** 可控时钟：delay 在 release 前挂起，用于冻结流水线观察中间态。 */
function gatedClock() {
  let releases: Array<() => void> = [];
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    now: () => fixedNow,
    today: () => fixedNow.slice(0, 10),
    delay: () =>
      new Promise<void>((resolve) => {
        releases.push(resolve);
      }),
    /** 循环放行直到流水线不再产生新阶段（上限 50 轮）。 */
    async releaseAll() {
      for (let round = 0; round < 50; round++) {
        const pending = releases;
        releases = [];
        if (!pending.length) {
          await tick();
          if (!releases.length) return;
          continue;
        }
        pending.forEach((resolve) => resolve());
        await tick();
      }
      throw new Error('releaseAll 超出 50 轮，流水线可能未终止');
    }
  };
}

function memoryPersistence(): EnginePersistence & { read(): RecalcState | null; writeRaw(s: RecalcState | null): void } {
  let data: RecalcState | null = null;
  return {
    load: () => (data ? structuredClone(data) : null),
    save: (state) => {
      data = structuredClone(state);
    },
    read: () => data,
    writeRaw: (s) => {
      data = s ? structuredClone(s) : null;
    }
  };
}

function harness(fault: () => boolean = () => false) {
  const persistence = memoryPersistence();
  const gateway = makeGateway(makeSignals());
  const gate = gatedClock();
  const engine = new RecalcEngine(persistence, gateway, gate, fault);
  engine.seed(makeSignals());
  return { persistence, gateway, gate, engine };
}

console.log('可恢复重算引擎测试');

// 1. 种子物化
await test('种子建立 V0 完整快照，发生率与台账一致', () => {
  const { engine } = harness();
  const state = engine.getState();
  assert.equal(state.effectiveVersion, 0);
  const snap = state.snapshots.find((s) => s.batch === 'IP8-260401')!;
  assert.equal(snap.reportCount, 8.5); // 17 条 / 2 批号
  assert.equal(snap.installedUnits, 1024); // 2048 / 2
  assert.ok(Math.abs(snap.rate! - 0.83) < 0.001, `expected ~0.83 got ${snap.rate}`);
  assert.equal(snap.version, 0);
});

// 2. 补录 -> stale -> 提交
await test('补录报告：旧快照先失效，提交后整体升 V1', async () => {
  const { persistence, gateway, gate, engine } = harness();
  assert.equal(engine.batchView('M12-251118').stale, false);

  const result = engine.submitReport({
    dedupKey: 'FR-TEST-01',
    batches: ['M12-251118'],
    action: 'supplement',
    actor: '同事甲',
    note: '新增现场报告一条'
  });
  assert.equal(result.accepted, true);
  if (!result.accepted) throw new Error('should accept');

  // 流水线冻结中：stale 已持久化，旧数字仍可读
  const staleView = engine.batchView('M12-251118');
  assert.equal(staleView.stale, true);
  assert.equal(staleView.reportCount, 9);
  assert.notEqual(persistence.read()!.snapshots.find((s) => s.batch === 'M12-251118')!.staleSince, null);
  assert.equal(engine.batchView('D9-260722').stale, false);

  await gate.releaseAll();

  const after = engine.batchView('M12-251118');
  assert.equal(after.stale, false);
  assert.equal(after.reportCount, 10);
  assert.equal(after.rate, 1.14);
  assert.equal(engine.getState().effectiveVersion, 1);

  const sig = gateway.signals().find((s) => s.id === 'SIG-2026-015')!;
  assert.equal(sig.recalcVersion, 1);
  assert.equal(sig.reportCount, 10);
  assert.equal(sig.occurrenceRate, 1.14);
});

// 3. 重复补录幂等
await test('同一报告号重复补录被幂等拦截，不产生第二次重算', async () => {
  const { gate, engine } = harness();
  engine.submitReport({ dedupKey: 'FR-DUP', batches: ['M12-251118'], action: 'supplement', actor: '甲', note: '首次' });
  await gate.releaseAll();
  const jobsAfterFirst = engine.getState().jobs.length;

  const dup = engine.submitReport({ dedupKey: 'fr-dup', batches: ['M12-251118'], action: 'supplement', actor: '乙', note: '重复' });
  assert.equal(dup.accepted, false);
  assert.equal(dup.reason, 'duplicate');
  assert.equal(engine.getState().jobs.length, jobsAfterFirst);
  assert.equal(engine.batchView('M12-251118').reportCount, 10);
  assert.ok(engine.getState().events.find((e) => e.kind === 'report_duplicate'));
});

// 4. 多批号拆账
await test('多批号报告按批号等分，受影响批号各自重算', async () => {
  const { gateway, gate, engine } = harness();
  const r = engine.submitReport({
    dedupKey: 'FR-MULTI',
    batches: ['IP8-260401', 'IP8-260403'],
    action: 'supplement',
    actor: '甲',
    note: '一份报告覆盖两批号'
  });
  assert.equal(r.accepted, true);
  await gate.releaseAll();

  assert.equal(engine.batchView('IP8-260401').reportCount, 9);
  assert.equal(engine.batchView('IP8-260403').reportCount, 9); // 8.5 基线 + 0.5 拆账
  const sig = gateway.signals().find((s) => s.id === 'SIG-2026-018')!;
  assert.equal(sig.reportCount, 18); // 17 + 整条报告 1
});

// 5. 撤回
await test('撤回报告在重算提交后移除计数，报告行保留可审计', async () => {
  const { gate, engine } = harness();
  engine.submitReport({ dedupKey: 'FR-W', batches: ['M12-251118'], action: 'supplement', actor: '甲', note: '将撤回' });
  await gate.releaseAll();
  assert.equal(engine.batchView('M12-251118').reportCount, 10);

  const w = engine.submitReport({ dedupKey: 'FR-W', batches: ['M12-251118'], action: 'withdraw', actor: '甲', note: '误录撤回' });
  assert.equal(w.accepted, true);
  await gate.releaseAll();
  assert.equal(engine.batchView('M12-251118').reportCount, 9);
  assert.ok(engine.getState().reports.find((r) => r.dedupKey === 'FR-W')!.withdrawnAt);
});

// 6. 并发冲突
await test('两人同改装机量：后到者看到冲突且其输入被保留，不触发重算', async () => {
  const { gate, engine } = harness();
  const first = engine.correctInstallBase({ batch: 'M12-251118', installedUnits: 900, expectedRevision: 0, actor: '甲' });
  assert.equal(first.accepted, true);
  await gate.releaseAll();

  const second = engine.correctInstallBase({ batch: 'M12-251118', installedUnits: 850, expectedRevision: 0, actor: '乙' });
  assert.equal(second.accepted, false);
  if (second.accepted) throw new Error('should conflict');
  assert.equal(second.conflict.proposedUnits, 850);
  assert.equal(second.conflict.actualRevision, 1);
  assert.equal(engine.batchView('M12-251118').installedUnits, 900);

  const resolve = engine.resolveConflict(second.conflict.id, 'overwrite', '乙');
  assert.equal(resolve.accepted, true);
  await gate.releaseAll();
  assert.equal(engine.batchView('M12-251118').installedUnits, 850);
  assert.equal(engine.getState().conflicts[0].resolved, true);
});

// 7. 断点续算
await test('写入失败后任务停在断点，续跑成功提交且不留半套数字', async () => {
  const persistence = memoryPersistence();
  const gateway = makeGateway(makeSignals());
  let fault = true;
  const gate = gatedClock();
  const engine = new RecalcEngine(persistence, gateway, gate, () => {
    if (fault) {
      fault = false;
      return true;
    }
    return false;
  });
  engine.seed(makeSignals());
  engine.submitReport({ dedupKey: 'FR-FAIL', batches: ['M12-251118'], action: 'supplement', actor: '甲', note: '故障演练' });
  await gate.releaseAll();

  const failedJob = engine.getState().jobs.find((j) => j.status === 'failed')!;
  assert.ok(failedJob);
  assert.equal(failedJob.failure?.at, 'mark_stale');
  assert.equal(engine.getState().effectiveVersion, 0);

  // 模拟进程重启，从持久化恢复
  const gate2 = gatedClock();
  const engine2 = new RecalcEngine(persistence, gateway, gate2, () => false);
  engine2.recover();
  await gate2.releaseAll();

  const restartedJob = engine2.getState().jobs.find((j) => j.id === failedJob.id)!;
  assert.equal(restartedJob.status, 'committed');
  assert.equal(restartedJob.completedStages.length, 4);
  assert.equal(engine2.getState().effectiveVersion, 1);
  assert.equal(engine2.batchView('M12-251118').reportCount, 10);
});

// 8. 中断期间无半套数字
await test('中断期间未受影响批号保持完整 V0，信号表无半套数字', async () => {
  const persistence = memoryPersistence();
  const gateway = makeGateway(makeSignals());
  let fault = true;
  const gate = gatedClock();
  const engine = new RecalcEngine(persistence, gateway, gate, () => {
    if (fault) {
      fault = false;
      return true;
    }
    return false;
  });
  engine.seed(makeSignals());
  engine.submitReport({ dedupKey: 'FR-HALF', batches: ['M12-251118'], action: 'supplement', actor: '甲', note: 'x' });
  await gate.releaseAll();

  assert.deepEqual(engine.batchView('D9-260722'), {
    batch: 'D9-260722',
    reportCount: 3,
    installedUnits: 120,
    rate: 2.5,
    revision: 0,
    stale: false,
    jobId: null,
    exists: true
  });
  const sig = gateway.signals().find((s) => s.id === 'SIG-2026-015')!;
  assert.equal(sig.recalcVersion, 0);
  assert.equal(sig.reportCount, 9);
});

// 9. 任务期限收紧
await test('重算超阈值后调查任务期限按 SLA 收紧（只提前）', async () => {
  const persistence = memoryPersistence();
  const signals = makeSignals();
  signals.find((s) => s.id === 'SIG-2026-015')!.tasks.forEach((t) => (t.dueAt = '2026-12-31'));
  const gateway = makeGateway(signals);
  const gate = gatedClock();
  const engine = new RecalcEngine(persistence, gateway, gate);
  engine.seed(makeSignals());
  // 9 条 / 400 台 = 2.25% ≥ 2% 临界
  engine.correctInstallBase({ batch: 'M12-251118', installedUnits: 400, expectedRevision: 0, actor: '甲' });
  await gate.releaseAll();

  const updated = gateway.signals().find((s) => s.id === 'SIG-2026-015')!;
  const task = updated.tasks[0] as InvestigationTask;
  assert.ok(task.reschedule);
  assert.equal(task.reschedule!.from, '2026-12-31');
  assert.equal(task.dueAt, addBusinessDays('2026-10-05', 2));
  assert.equal(updated.occurrenceRate, 2.25);
  void RATE_THRESHOLD;
  void RATE_CRITICAL;
});

// 10. 版本单调：非重叠批号的连续变更各自产生一个版本
await test('连续两次变更（不同批号）：版本单调 V1/V2，快照与信号版本一致', async () => {
  const { gateway, gate, engine } = harness();
  engine.submitReport({ dedupKey: 'FR-A', batches: ['M12-251118'], action: 'supplement', actor: '甲', note: 'a' });
  await gate.releaseAll();
  assert.equal(engine.getState().effectiveVersion, 1);
  engine.submitReport({ dedupKey: 'FR-B', batches: ['D9-260722'], action: 'supplement', actor: '甲', note: 'b' });
  await gate.releaseAll();
  assert.equal(engine.getState().effectiveVersion, 2);
  assert.equal(engine.batchView('M12-251118').reportCount, 10);
  assert.equal(engine.batchView('D9-260722').reportCount, 4);
  assert.equal(engine.batchView('M12-251118').stale, false);
  assert.equal(engine.batchView('D9-260722').stale, false);
  assert.equal(gateway.signals().find((s) => s.id === 'SIG-2026-015')!.recalcVersion, 1);
  assert.equal(gateway.signals().find((s) => s.id === 'SIG-2026-019')!.recalcVersion, 2);
});

// 10b. 同一批号的快速连续变更并入同一个未提交任务，一次重算覆盖
await test('同一批号连续两次补录合并为一次重算，提交后计数正确且无 stale 残留', async () => {
  const { gate, engine } = harness();
  // 第一条提交后不等待（任务仍在流水线中），立刻补第二条同批号报告
  const first = engine.submitReport({ dedupKey: 'FR-Q1', batches: ['M12-251118'], action: 'supplement', actor: '甲', note: '1' });
  const second = engine.submitReport({ dedupKey: 'FR-Q2', batches: ['M12-251118'], action: 'supplement', actor: '乙', note: '2' });
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  if (first.accepted && second.accepted) assert.equal(first.jobId, second.jobId);
  await gate.releaseAll();

  assert.equal(engine.getState().effectiveVersion, 1);
  const view = engine.batchView('M12-251118');
  assert.equal(view.stale, false);
  assert.equal(view.reportCount, 11); // 9 + 2
  const committed = engine.getState().jobs.filter((j) => j.status === 'committed');
  assert.equal(committed.length, 1);
});

// 11. 提交后应用崩溃的补应用
await test('提交已落盘但信号应用未确认：恢复补应用且不重复', async () => {
  const persistence = memoryPersistence();
  const gateway = makeGateway(makeSignals());
  const gate = gatedClock();
  const engine = new RecalcEngine(persistence, gateway, gate);
  engine.seed(makeSignals());
  engine.submitReport({ dedupKey: 'FR-CRASH', batches: ['M12-251118'], action: 'supplement', actor: '甲', note: 'x' });
  await gate.releaseAll();

  const state = persistence.read()!;
  const job = state.jobs[0];
  assert.equal(job.status, 'committed');
  (job as { appliedAt: string | null }).appliedAt = null;
  const gateway2 = makeGateway(makeSignals());
  persistence.writeRaw(state);

  const gate2 = gatedClock();
  const engine2 = new RecalcEngine(persistence, gateway2, gate2, () => false);
  engine2.recover();
  await gate2.releaseAll();
  const sig = gateway2.signals().find((s) => s.id === 'SIG-2026-015')!;
  assert.equal(sig.recalcVersion, 1);
  assert.equal(sig.reportCount, 10);

  engine2.recover();
  await gate2.releaseAll();
  assert.equal(gateway2.signals().find((s) => s.id === 'SIG-2026-015')!.reportCount, 10);
});

console.log(`\n${testCount} 项测试完成`);
