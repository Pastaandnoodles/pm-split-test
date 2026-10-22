import { compareUnits, comparePaired, bootstrapMean, wilson, type Interval, type PairedTest, type TwoGroupTest } from './stats';
import { computeGroupCycleYield, crossBinHint, type GroupCycleYield } from './yield';
import type { Dataset, FailureType, Group, PlateRun, Printer } from './types';
import { FAILURE_TYPES } from './types';

export interface AnalysisOptions {
  excludeDeviations: boolean;
  excludeNonPrinterCancels: boolean;
}

export const GROUPS: Group[] = ['control', 'maintenance'];
const PLATES_PER_CYCLE = 38;

export interface GroupOutcome {
  n: number;
  pass: number;
  failFinished: number;
  failStopped: number;
  canceled: number;
  passRate: Interval;
}

export interface PrinterStats {
  printer: Printer;
  n: number;
  pass: number;
  fail: number;
  passRate: number;
  resumed: number;
  fatal: number;
  reactiveCount: number;
  reactiveMinutes: number;
  downtimeHours: number;
}

export interface CycleYieldRow {
  cycleId: string;
  cycleNumber: number;
  control: GroupCycleYield;
  maintenance: GroupCycleYield;
  hint: string | null;
}

export interface EconTerm {
  label: string;
  units: string; // e.g. "parts", "min", "g", "h"
  perCycle: number; // in units, positive = in favor of Maintenance
  dollarsPerCycle: number | null;
}

export interface Economics {
  cyclesUsed: number;
  terms: EconTerm[];
  netPerCycle: Interval | null; // dollars; null when dollar inputs are missing
  missingInputs: string[];
}

export interface Verdict {
  tone: 'better' | 'worse' | 'none' | 'insufficient';
  headline: string;
  detail: string;
  preliminary: boolean;
}

export interface AnalysisResult {
  progress: Record<Group, number>;
  goal: number;
  final: boolean;
  outcomes: Record<Group, GroupOutcome>;
  perPrinter: PrinterStats[];
  passTest: TwoGroupTest | null;
  cycleYields: CycleYieldRow[];
  yieldTest: PairedTest | null;
  trend: { cycleNumber: number; passRate: Record<Group, number | null>; overallYield: Record<Group, number | null> }[];
  failureTypes: Record<FailureType, Record<Group, number>>;
  errors: Record<Group, { resumed: number; fatal: number }>;
  topCodes: { code: string; control: number; maintenance: number }[];
  reactive: Record<Group, { count: number; minutes: number; parts: Record<string, number> }>;
  rows: Record<Group, { top: Interval; bottom: Interval }>;
  scrap: Record<Group, { stoppedCount: number; meanProgressPct: number | null; totalScrapG: number }>;
  labor: { oneTimeMinutes: number; perPrintMinutes: number };
  economics: Economics;
  verdict: Verdict;
}

function isExcluded(run: PlateRun, ds: Dataset, opts: AnalysisOptions): boolean {
  if (opts.excludeNonPrinterCancels && run.outcome === 'fail_stopped' && run.stoppedBy === 'canceled' && run.cancelReason !== 'printer_issue') {
    return true;
  }
  if (opts.excludeDeviations) {
    return ds.deviations.some(
      (d) =>
        !d.voided &&
        d.excludeFromAnalysis &&
        (d.printerId === undefined || d.printerId === run.printerId) &&
        (d.cycleId === undefined || d.cycleId === run.cycleId) &&
        (d.printerId !== undefined || d.cycleId !== undefined),
    );
  }
  return false;
}

function hoursBetween(a: string, b: string): number {
  return Math.max(0, (Date.parse(b) - Date.parse(a)) / 3_600_000);
}

export function analyze(ds: Dataset, opts: AnalysisOptions, now = new Date().toISOString()): AnalysisResult {
  const printerById = new Map(ds.printers.map((p) => [p.id, p]));
  const groupOf = (printerId: string): Group | undefined => printerById.get(printerId)?.group;
  const liveRuns = ds.plateRuns.filter((r) => !r.voided && printerById.has(r.printerId));
  const runs = liveRuns.filter((r) => !isExcluded(r, ds, opts));
  const errors = ds.errorCodes.filter((e) => !e.voided);
  const reactive = ds.reactive.filter((r) => !r.voided);
  const downtime = ds.downtime.filter((d) => !d.voided);
  const cycles = ds.cycles.filter((c) => !c.voided).sort((a, b) => a.number - b.number);
  const fileById = new Map(ds.files.filter((f) => !f.voided).map((f) => [f.id, f]));
  const settings = ds.settings;

  // Progress counts every logged plate; exclusions only affect the statistics.
  const progress = { control: 0, maintenance: 0 } as Record<Group, number>;
  for (const r of liveRuns) progress[groupOf(r.printerId)!]++;
  const goal = settings.goalPerGroup;
  const final = progress.control >= goal && progress.maintenance >= goal;

  const outcomes = {} as Record<Group, GroupOutcome>;
  for (const g of GROUPS) {
    const gr = runs.filter((r) => groupOf(r.printerId) === g);
    const pass = gr.filter((r) => r.outcome === 'pass').length;
    outcomes[g] = {
      n: gr.length,
      pass,
      failFinished: gr.filter((r) => r.outcome === 'fail_finished').length,
      failStopped: gr.filter((r) => r.outcome === 'fail_stopped' && r.stoppedBy !== 'canceled').length,
      canceled: gr.filter((r) => r.outcome === 'fail_stopped' && r.stoppedBy === 'canceled').length,
      passRate: wilson(pass, gr.length),
    };
  }

  const perPrinter: PrinterStats[] = ds.printers.map((printer) => {
    const pr = runs.filter((r) => r.printerId === printer.id);
    const pass = pr.filter((r) => r.outcome === 'pass').length;
    const pe = errors.filter((e) => e.printerId === printer.id);
    const rm = reactive.filter((r) => r.printerId === printer.id);
    const dt = downtime
      .filter((d) => d.printerId === printer.id)
      .reduce((s, d) => s + hoursBetween(d.downAt, d.upAt ?? now), 0);
    return {
      printer,
      n: pr.length,
      pass,
      fail: pr.length - pass,
      passRate: pr.length ? pass / pr.length : NaN,
      resumed: pe.filter((e) => e.disposition === 'resumed').length,
      fatal: pe.filter((e) => e.disposition === 'fatal').length,
      reactiveCount: rm.length,
      reactiveMinutes: rm.reduce((s, r) => s + r.minutes, 0),
      downtimeHours: dt,
    };
  });

  // The printer is the statistical unit: compare per-printer pass rates.
  const rates = (g: Group) => perPrinter.filter((p) => p.printer.group === g && p.n > 0).map((p) => p.passRate);
  const cRates = rates('control');
  const mRates = rates('maintenance');
  const passTest = cRates.length >= 2 && mRates.length >= 2 ? compareUnits(cRates, mRates) : null;

  const cycleYields: CycleYieldRow[] = cycles.map((cycle) => {
    const file = fileById.get(cycle.fileId);
    const [control, maintenance] = GROUPS.map((g) =>
      computeGroupCycleYield(cycle, file, g, liveRuns, ds.printers, ds.bins, settings.missingTolerancePct),
    );
    return {
      cycleId: cycle.id,
      cycleNumber: cycle.number,
      control,
      maintenance,
      hint: crossBinHint(control, maintenance, file?.partsPerPlate ?? 0),
    };
  });
  const yieldDiffs = cycleYields
    .filter((c) => c.control.overallYield !== null && c.maintenance.overallYield !== null)
    .map((c) => c.maintenance.overallYield! - c.control.overallYield!);
  const yieldTest = yieldDiffs.length >= 2 ? comparePaired(yieldDiffs) : null;

  const trend = cycles.map((cycle) => {
    const row = cycleYields.find((y) => y.cycleId === cycle.id)!;
    const passRate = {} as Record<Group, number | null>;
    for (const g of GROUPS) {
      const gr = runs.filter((r) => r.cycleId === cycle.id && groupOf(r.printerId) === g);
      passRate[g] = gr.length ? gr.filter((r) => r.outcome === 'pass').length / gr.length : null;
    }
    return {
      cycleNumber: cycle.number,
      passRate,
      overallYield: { control: row.control.overallYield, maintenance: row.maintenance.overallYield },
    };
  });

  const failureTypes = {} as Record<FailureType, Record<Group, number>>;
  for (const t of FAILURE_TYPES) failureTypes[t] = { control: 0, maintenance: 0 };
  for (const r of runs) if (r.outcome !== 'pass' && r.failureType) failureTypes[r.failureType][groupOf(r.printerId)!]++;

  const errorsByGroup = { control: { resumed: 0, fatal: 0 }, maintenance: { resumed: 0, fatal: 0 } };
  const codeCounts = new Map<string, { control: number; maintenance: number }>();
  for (const e of errors) {
    const g = groupOf(e.printerId);
    if (!g) continue;
    errorsByGroup[g][e.disposition]++;
    const c = codeCounts.get(e.code) ?? { control: 0, maintenance: 0 };
    c[g]++;
    codeCounts.set(e.code, c);
  }
  const topCodes = [...codeCounts.entries()]
    .map(([code, c]) => ({ code, ...c }))
    .sort((a, b) => b.control + b.maintenance - (a.control + a.maintenance))
    .slice(0, 10);

  const reactiveByGroup = {} as AnalysisResult['reactive'];
  for (const g of GROUPS) {
    const gr = reactive.filter((r) => groupOf(r.printerId) === g);
    const parts: Record<string, number> = {};
    for (const r of gr) if (r.part) parts[r.part] = (parts[r.part] ?? 0) + 1;
    reactiveByGroup[g] = { count: gr.length, minutes: gr.reduce((s, r) => s + r.minutes, 0), parts };
  }

  const rows = {} as AnalysisResult['rows'];
  for (const g of GROUPS) {
    const rowRate = (row: 'a' | 'b') => {
      const gr = runs.filter((r) => printerById.get(r.printerId)?.group === g && printerById.get(r.printerId)?.row === row);
      return wilson(gr.filter((r) => r.outcome === 'pass').length, gr.length);
    };
    rows[g] = { top: rowRate('a'), bottom: rowRate('b') };
  }

  const scrap = {} as AnalysisResult['scrap'];
  for (const g of GROUPS) {
    const gr = runs.filter((r) => groupOf(r.printerId) === g && r.outcome !== 'pass');
    const stopped = gr.filter((r) => r.outcome === 'fail_stopped' && typeof r.progressPct === 'number');
    scrap[g] = {
      stoppedCount: stopped.length,
      meanProgressPct: stopped.length ? stopped.reduce((s, r) => s + r.progressPct!, 0) / stopped.length : null,
      totalScrapG: gr.reduce((s, r) => s + (r.scrapMassG ?? 0), 0),
    };
  }

  const oneTimeMinutes = ds.oneTime.filter((s) => !s.voided).reduce((s, x) => s + x.minutes, 0);
  const perPrintMinutes = liveRuns
    .filter((r) => groupOf(r.printerId) === 'maintenance')
    .reduce((s, r) => s + r.pmMinutes, 0);

  const economics = computeEconomics(ds, liveRuns, cycleYields, groupOf, oneTimeMinutes, now);

  return {
    progress,
    goal,
    final,
    outcomes,
    perPrinter,
    passTest,
    cycleYields,
    yieldTest,
    trend,
    failureTypes,
    errors: errorsByGroup,
    topCodes,
    reactive: reactiveByGroup,
    rows,
    scrap,
    labor: { oneTimeMinutes, perPrintMinutes },
    economics,
    verdict: buildVerdict(final, yieldTest, passTest),
  };
}

function computeEconomics(
  ds: Dataset,
  runs: PlateRun[],
  cycleYields: CycleYieldRow[],
  groupOf: (id: string) => Group | undefined,
  oneTimeMinutes: number,
  now: string,
): Economics {
  const s = ds.settings;
  const missingInputs: string[] = [];
  if (s.valuePerGoodPart === undefined) missingInputs.push('Value per good wigglitz');
  if (s.laborRatePerHr === undefined) missingInputs.push('Labor rate');
  if (s.filamentCostPerKg === undefined) missingInputs.push('Filament cost');
  if (s.machineHourValue === undefined) missingInputs.push('Machine-hour value');

  const usable = cycleYields.filter((c) => c.control.goodParts !== null && c.maintenance.goodParts !== null);
  const plannedCycles = Math.max(Math.ceil(s.goalPerGroup / PLATES_PER_CYCLE), usable.length, 1);

  const downtimeHours = (g: Group) =>
    ds.downtime
      .filter((d) => !d.voided && groupOf(d.printerId) === g)
      .reduce((sum, d) => sum + hoursBetween(d.downAt, d.upAt ?? now), 0);
  const cyclesSoFar = Math.max(ds.cycles.filter((c) => !c.voided).length, 1);
  const downtimeSavedPerCycle = (downtimeHours('control') - downtimeHours('maintenance')) / cyclesSoFar;

  const partCost = (part?: string) => (part ? s.partCosts[part] ?? 0 : 0);

  type CycleTerms = { good: number; scrapG: number; reactiveMin: number; partsCost: number; pmMin: number; calibMin: number };
  const perCycle: CycleTerms[] = usable.map((c) => {
    const scale = (y: GroupCycleYield) => (y.platesStarted > 0 ? PLATES_PER_CYCLE / y.platesStarted : 0);
    const sC = scale(c.control);
    const sM = scale(c.maintenance);
    const inCycle = (g: Group) => runs.filter((r) => r.cycleId === c.cycleId && groupOf(r.printerId) === g);
    const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
    const reactiveIn = (g: Group) => ds.reactive.filter((r) => !r.voided && r.cycleId === c.cycleId && groupOf(r.printerId) === g);
    const mRuns = inCycle('maintenance');
    return {
      good: c.maintenance.goodParts! * sM - c.control.goodParts! * sC,
      scrapG: sum(inCycle('control'), (r) => r.scrapMassG ?? 0) * sC - sum(mRuns, (r) => r.scrapMassG ?? 0) * sM,
      reactiveMin: sum(reactiveIn('control'), (r) => r.minutes) * sC - sum(reactiveIn('maintenance'), (r) => r.minutes) * sM,
      partsCost: sum(reactiveIn('control'), (r) => partCost(r.part)) * sC - sum(reactiveIn('maintenance'), (r) => partCost(r.part)) * sM,
      pmMin: sum(mRuns, (r) => r.pmMinutes) * sM + oneTimeMinutes / plannedCycles,
      calibMin: mRuns.filter((r) => r.checks.calibrationRun).length * sM * s.calibrationMachineMinutes,
    };
  });

  const avg = (f: (t: CycleTerms) => number) => (perCycle.length ? perCycle.reduce((a, t) => a + f(t), 0) / perCycle.length : 0);
  const labor = s.laborRatePerHr;
  const machine = s.machineHourValue;
  const dollars = (v: number | undefined, f: (rate: number) => number) => (v === undefined ? null : f(v));

  const terms: EconTerm[] = [
    { label: 'Extra good parts', units: 'parts', perCycle: avg((t) => t.good), dollarsPerCycle: dollars(s.valuePerGoodPart, (v) => avg((t) => t.good) * v) },
    { label: 'Scrap filament saved', units: 'g', perCycle: avg((t) => t.scrapG), dollarsPerCycle: dollars(s.filamentCostPerKg, (v) => (avg((t) => t.scrapG) / 1000) * v) },
    { label: 'Repair labor saved', units: 'min', perCycle: avg((t) => t.reactiveMin), dollarsPerCycle: dollars(labor, (v) => (avg((t) => t.reactiveMin) / 60) * v) },
    { label: 'Replacement parts saved', units: '$', perCycle: avg((t) => t.partsCost), dollarsPerCycle: avg((t) => t.partsCost) },
    { label: 'Downtime saved', units: 'h', perCycle: downtimeSavedPerCycle, dollarsPerCycle: dollars(machine, (v) => downtimeSavedPerCycle * v) },
    { label: 'PM labor (one-time spread over test + per print)', units: 'min', perCycle: -avg((t) => t.pmMin), dollarsPerCycle: dollars(labor, (v) => (-avg((t) => t.pmMin) / 60) * v) },
    { label: 'Calibration machine time', units: 'min', perCycle: -avg((t) => t.calibMin), dollarsPerCycle: dollars(machine, (v) => (-avg((t) => t.calibMin) / 60) * v) },
  ];

  let netPerCycle: Interval | null = null;
  if (perCycle.length > 0 && s.valuePerGoodPart !== undefined && labor !== undefined) {
    const net = perCycle.map(
      (t) =>
        t.good * s.valuePerGoodPart! +
        (t.scrapG / 1000) * (s.filamentCostPerKg ?? 0) +
        (t.reactiveMin / 60) * labor +
        t.partsCost +
        downtimeSavedPerCycle * (machine ?? 0) -
        (t.pmMin / 60) * labor -
        (t.calibMin / 60) * (machine ?? 0),
    );
    netPerCycle = bootstrapMean(net);
  }

  return { cyclesUsed: perCycle.length, terms, netPerCycle, missingInputs };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}`;
}

export function buildVerdict(final: boolean, yieldTest: PairedTest | null, passTest: TwoGroupTest | null): Verdict {
  const preliminary = !final;
  const suffix = preliminary ? ' yet' : '';
  if (yieldTest && yieldTest.n >= 2 && Number.isFinite(yieldTest.pValue)) {
    const { meanDiff, ci, pValue } = yieldTest;
    const range = Number.isFinite(ci.low) ? ` (likely range ${pct(ci.low)} to ${pct(ci.high)})` : '';
    const detail = `Maintenance produced ${meanDiff >= 0 ? pct(meanDiff) + ' more' : pct(-meanDiff) + ' fewer'} good parts per 100 printed${range}, across ${yieldTest.n} cycles.`;
    if (pValue < 0.05) {
      return meanDiff > 0
        ? { tone: 'better', headline: 'Maintenance is clearly better', detail, preliminary }
        : { tone: 'worse', headline: 'Control is clearly better', detail, preliminary };
    }
    return { tone: 'none', headline: `No clear difference${suffix}`, detail, preliminary };
  }
  if (passTest && Number.isFinite(passTest.pValue)) {
    const { diff, ci, pValue } = passTest;
    const range = Number.isFinite(ci.low) ? ` (likely range ${pct(ci.low)} to ${pct(ci.high)} points)` : '';
    const detail = `Plate pass rate is ${diff >= 0 ? pct(diff) + ' points higher' : pct(-diff) + ' points lower'} on Maintenance printers${range}. Yield needs at least 2 weighed cycles.`;
    if (pValue < 0.05) {
      return diff > 0
        ? { tone: 'better', headline: 'Maintenance is clearly better', detail, preliminary }
        : { tone: 'worse', headline: 'Control is clearly better', detail, preliminary };
    }
    return { tone: 'none', headline: `No clear difference${suffix}`, detail, preliminary };
  }
  return {
    tone: 'insufficient',
    headline: 'Not enough data yet',
    detail: 'Log plates on at least 2 printers per group, or weigh bins for at least 2 cycles.',
    preliminary,
  };
}
