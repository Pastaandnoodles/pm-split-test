import type { BinWeight, Cycle, FileSpec, Group, PlateRun, Printer } from './types';

export interface GroupCycleYield {
  cycleId: string;
  cycleNumber: number;
  group: Group;
  platesStarted: number;
  passedPlates: number;
  expectedParts: number;
  goodParts: number | null;
  rejectedParts: number | null;
  missingParts: number | null; // negative = extra parts
  qcYield: number | null;
  overallYield: number | null;
  flags: string[];
}

export function partsFromWeight(grossG: number, tareG: number, unitWeightG: number): number {
  return Math.round((grossG - tareG) / unitWeightG);
}

/** Latest non-voided bin weighing for the cycle, group and kind. */
export function findBin(bins: BinWeight[], cycleId: string, group: Group, kind: 'good' | 'reject'): BinWeight | undefined {
  return bins
    .filter((b) => !b.voided && b.cycleId === cycleId && b.group === group && b.kind === kind)
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .at(-1);
}

export function computeGroupCycleYield(
  cycle: Cycle,
  file: FileSpec | undefined,
  group: Group,
  plateRuns: PlateRun[],
  printers: Printer[],
  bins: BinWeight[],
  tolerancePct: number,
): GroupCycleYield {
  const groupIds = new Set(printers.filter((p) => p.group === group).map((p) => p.id));
  const runs = plateRuns.filter((r) => !r.voided && r.cycleId === cycle.id && groupIds.has(r.printerId));
  const platesStarted = runs.length;
  const passedPlates = runs.filter((r) => r.outcome === 'pass').length;
  const ppp = file?.partsPerPlate ?? 0;
  const expectedParts = passedPlates * ppp;
  const flags: string[] = [];

  const good = findBin(bins, cycle.id, group, 'good');
  const reject = findBin(bins, cycle.id, group, 'reject');
  const tare = cycle.binTareG ?? 0;
  const unit = file?.unitWeightG ?? 0;

  let goodParts: number | null = null;
  let rejectedParts: number | null = null;
  if (unit > 0 && good) goodParts = partsFromWeight(good.grossG, tare, unit);
  if (unit > 0 && reject) rejectedParts = partsFromWeight(reject.grossG, tare, unit);
  if (!file) flags.push('No file set for this cycle');
  if (cycle.binTareG === undefined && (good || reject)) flags.push('Bin tare not entered');

  const missingParts = goodParts !== null && rejectedParts !== null ? expectedParts - goodParts - rejectedParts : null;
  const qcYield =
    goodParts !== null && rejectedParts !== null && goodParts + rejectedParts > 0
      ? goodParts / (goodParts + rejectedParts)
      : null;
  const overallYield = goodParts !== null && platesStarted * ppp > 0 ? goodParts / (platesStarted * ppp) : null;

  if (missingParts !== null && expectedParts > 0 && Math.abs(missingParts) > (tolerancePct / 100) * expectedParts) {
    flags.push(
      missingParts > 0
        ? `${missingParts} parts missing (more than ${tolerancePct}% of expected)`
        : `${-missingParts} extra parts (more than ${tolerancePct}% of expected)`,
    );
  }
  if (goodParts !== null && goodParts > expectedParts) flags.push('More good parts than expected');
  if (goodParts !== null && goodParts < 0) flags.push('Negative good weight: check tare');

  return {
    cycleId: cycle.id,
    cycleNumber: cycle.number,
    group,
    platesStarted,
    passedPlates,
    expectedParts,
    goodParts,
    rejectedParts,
    missingParts,
    qcYield,
    overallYield,
    flags,
  };
}

/**
 * One group short and the other over by a similar amount (about one plate's worth or more)
 * suggests a plate went into the wrong group's bin.
 */
export function crossBinHint(control: GroupCycleYield, maintenance: GroupCycleYield, partsPerPlate: number): string | null {
  const c = control.missingParts;
  const m = maintenance.missingParts;
  if (c === null || m === null || partsPerPlate <= 0) return null;
  if (Math.sign(c) === Math.sign(m) || c === 0 || m === 0) return null;
  const small = Math.min(Math.abs(c), Math.abs(m));
  const big = Math.max(Math.abs(c), Math.abs(m));
  if (small >= partsPerPlate * 0.5 && small / big >= 0.6) {
    const short = c > 0 ? 'Control' : 'Maintenance';
    const over = c > 0 ? 'Maintenance' : 'Control';
    return `${short} is short and ${over} is over by about the same amount. A plate may have gone into the wrong group's bin.`;
  }
  return null;
}
