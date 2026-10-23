export type Group = 'control' | 'maintenance';
export type Row = 'a' | 'b'; // a = top, b = bottom

export interface Printer {
  id: string; // H-NNx
  column: number; // 1..38
  row: Row;
  shelf: number; // 1..19
  group: Group;
}

export interface BaseRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  voided?: boolean;
}

export const ONE_TIME_STEPS = ['fans', 'debris', 'leadScrews', 'nozzle'] as const;
export type OneTimeStepKey = (typeof ONE_TIME_STEPS)[number];
export const ONE_TIME_STEP_LABELS: Record<OneTimeStepKey, string> = {
  fans: 'Fans dusted',
  debris: 'Debris / loose purge cleaned',
  leadScrews: 'Lead screws cleaned and regreased',
  nozzle: 'Nozzle tip cleaned',
};

/** Marks a one-time step done on one printer. Time is logged for the whole group in PmTime. */
export interface OneTimeStep extends BaseRecord {
  printerId: string;
  step: OneTimeStepKey;
  doneAt: string;
}

/**
 * Maintenance labor timed for the whole Maintenance group, not per printer.
 * one_time: minutes spent on one step across all printers (entries for a step are summed).
 * per_print: minutes spent on per-print PM for the whole group in one cycle (entries are summed).
 */
export interface PmTime extends BaseRecord {
  scope: 'one_time' | 'per_print';
  step?: OneTimeStepKey;
  cycleId?: string;
  minutes: number;
  note?: string;
}

export interface FileSpec extends BaseRecord {
  name: string;
  partsPerPlate: number;
  unitWeightG: number;
  sampleCount?: number;
  sampleWeightG?: number;
}

export interface Cycle extends BaseRecord {
  number: number;
  fileId: string;
  startedAt: string;
  endedAt?: string;
  binTareG?: number;
  notes?: string;
}

export type Outcome = 'pass' | 'fail_finished' | 'fail_stopped';
export type StoppedBy = 'printer' | 'canceled';
export const CANCEL_REASONS = ['printer_issue', 'filament', 'operator', 'file', 'other'] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];
export const CANCEL_REASON_LABELS: Record<CancelReason, string> = {
  printer_issue: 'Printer issue',
  filament: 'Filament',
  operator: 'Operator',
  file: 'File',
  other: 'Other',
};

export const FAILURE_TYPES = [
  'first_layer',
  'warping',
  'detachment',
  'spaghetti',
  'clog',
  'nozzle_strike',
  'purge',
  'layer_shift',
  'stringing',
  'other',
] as const;
export type FailureType = (typeof FAILURE_TYPES)[number];
export const FAILURE_TYPE_LABELS: Record<FailureType, string> = {
  first_layer: 'First layer / adhesion',
  warping: 'Warping',
  detachment: 'Mid-print detachment',
  spaghetti: 'Spaghetti',
  clog: 'Clog / under-extrusion',
  nozzle_strike: 'Nozzle strike / scarring',
  purge: 'Purge blob / collision',
  layer_shift: 'Layer shift',
  stringing: 'Stringing / blobs',
  other: 'Other',
};

export interface PrePrintChecks {
  purgeCleared: boolean;
  nozzleWiped: boolean;
  plateCleaned: boolean;
  calibrationRun: boolean;
}

export interface PlateRun extends BaseRecord {
  printerId: string;
  cycleId: string;
  outcome: Outcome;
  stoppedBy?: StoppedBy;
  cancelReason?: CancelReason;
  checks: PrePrintChecks;
  correctPlatePool: boolean;
  // Failure details (fail_finished / fail_stopped)
  failureType?: FailureType;
  photoId?: string;
  failureNote?: string;
  fatalErrorId?: string;
  progressPct?: number; // fail_stopped only
  scrapMassG?: number;
}

export type ErrorDisposition = 'resumed' | 'fatal';
export interface ErrorCode extends BaseRecord {
  printerId: string;
  cycleId: string;
  code: string;
  disposition: ErrorDisposition;
  note?: string;
}

export const REACTIVE_ACTIONS = [
  'clear_clog',
  'replace_nozzle',
  'replace_fan',
  'ptfe',
  'clean_plate',
  'ams_fix',
  'motion_fix',
  'other',
] as const;
export type ReactiveAction = (typeof REACTIVE_ACTIONS)[number];
export const REACTIVE_ACTION_LABELS: Record<ReactiveAction, string> = {
  clear_clog: 'Clear clog',
  replace_nozzle: 'Replace nozzle / hotend',
  replace_fan: 'Replace fan',
  ptfe: 'Re-seat / replace PTFE',
  clean_plate: 'Clean plate',
  ams_fix: 'AMS fix',
  motion_fix: 'Belt / motion fix',
  other: 'Other',
};

export interface ReactiveMaintenance extends BaseRecord {
  printerId: string;
  cycleId?: string;
  action: ReactiveAction;
  part?: string;
  minutes: number;
  note?: string;
}

export interface Downtime extends BaseRecord {
  printerId: string;
  downAt: string;
  upAt?: string;
  reason?: string;
}

/** good = sold; seconds = donated, not sold; scrap = unredeemable, recycled. */
export type BinKind = 'good' | 'seconds' | 'scrap';
export const BIN_KINDS: BinKind[] = ['good', 'seconds', 'scrap'];
export const BIN_KIND_LABELS: Record<BinKind, string> = { good: 'Good', seconds: 'Seconds', scrap: 'Scrap' };
export interface BinWeight extends BaseRecord {
  cycleId: string;
  group: Group;
  kind: BinKind;
  grossG: number;
}

export const DEVIATION_TYPES = [
  'missed_step',
  'wrong_plate_pool',
  'firmware',
  'printer_swap',
  'assignment_change',
  'data_correction',
  'other',
] as const;
export type DeviationType = (typeof DEVIATION_TYPES)[number];
export const DEVIATION_TYPE_LABELS: Record<DeviationType, string> = {
  missed_step: 'Missed PM step',
  wrong_plate_pool: 'Wrong plate pool',
  firmware: 'Firmware update',
  printer_swap: 'Printer swapped',
  assignment_change: 'Group assignment changed',
  data_correction: 'Data correction',
  other: 'Other',
};

export interface Deviation extends BaseRecord {
  type: DeviationType;
  printerId?: string;
  cycleId?: string;
  description: string;
  excludeFromAnalysis: boolean;
}

export interface Photo {
  id: string;
  blob: Blob;
  createdAt: string;
}

export interface AuditEntry {
  seq?: number;
  at: string;
  table: string;
  recordId: string;
  action: 'create' | 'update' | 'void';
  before?: unknown;
  after?: unknown;
}

export interface Settings {
  key: 'settings';
  testLocked: boolean;
  groupOverrides: Record<string, Group>;
  goalPerGroup: number;
  calibrationMachineMinutes: number;
  missingTolerancePct: number;
  passFailRuleText: string;
  laborRatePerHr?: number;
  valuePerGoodPart?: number;
  filamentCostPerKg?: number;
  machineHourValue?: number;
  partCosts: Record<string, number>;
  lastBackupAt?: string;
}

export const DEFAULT_PASS_FAIL_RULE = [
  'PASS: the print reached the end AND at least one wigglitz on the plate is good. Send it to QC.',
  'FAIL, FINISHED: the print reached the end but every wigglitz is failed and not salvageable.',
  'FAIL, STOPPED: the print did not reach the end (printer failure or canceled).',
].join('\n');

export const DEFAULT_SETTINGS: Settings = {
  key: 'settings',
  testLocked: false,
  groupOverrides: {},
  goalPerGroup: 532,
  calibrationMachineMinutes: 0,
  missingTolerancePct: 2,
  passFailRuleText: DEFAULT_PASS_FAIL_RULE,
  partCosts: {},
};

/** Everything the analysis needs, already loaded from storage. Photos are excluded. */
export interface Dataset {
  printers: Printer[];
  files: FileSpec[];
  cycles: Cycle[];
  plateRuns: PlateRun[];
  errorCodes: ErrorCode[];
  reactive: ReactiveMaintenance[];
  downtime: Downtime[];
  bins: BinWeight[];
  deviations: Deviation[];
  oneTime: OneTimeStep[];
  pmTime: PmTime[];
  settings: Settings;
}
