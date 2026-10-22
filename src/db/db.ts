import Dexie, { type Table } from 'dexie';
import type {
  AuditEntry,
  BaseRecord,
  BinWeight,
  Cycle,
  Deviation,
  Downtime,
  ErrorCode,
  FileSpec,
  OneTimeStep,
  Photo,
  PlateRun,
  ReactiveMaintenance,
  Settings,
} from '../domain/types';
import { DEFAULT_SETTINGS } from '../domain/types';

export class PmDb extends Dexie {
  files!: Table<FileSpec, string>;
  cycles!: Table<Cycle, string>;
  plateRuns!: Table<PlateRun, string>;
  errorCodes!: Table<ErrorCode, string>;
  reactive!: Table<ReactiveMaintenance, string>;
  downtime!: Table<Downtime, string>;
  bins!: Table<BinWeight, string>;
  deviations!: Table<Deviation, string>;
  oneTime!: Table<OneTimeStep, string>;
  photos!: Table<Photo, string>;
  audit!: Table<AuditEntry, number>;
  settings!: Table<Settings, string>;

  constructor() {
    super('pm-split-test');
    this.version(1).stores({
      files: 'id',
      cycles: 'id, number',
      plateRuns: 'id, cycleId, printerId, [cycleId+printerId]',
      errorCodes: 'id, cycleId, printerId, code',
      reactive: 'id, cycleId, printerId',
      downtime: 'id, printerId',
      bins: 'id, cycleId',
      deviations: 'id, cycleId, printerId',
      oneTime: 'id, printerId',
      photos: 'id',
      audit: '++seq, at, table, recordId',
      settings: 'key',
    });
  }
}

export const db = new PmDb();

/** Tables whose records carry BaseRecord fields and go through the audit trail. */
export const RECORD_TABLES = ['files', 'cycles', 'plateRuns', 'errorCodes', 'reactive', 'downtime', 'bins', 'deviations', 'oneTime'] as const;
export type RecordTable = (typeof RECORD_TABLES)[number];

type RecordOf<T extends RecordTable> = PmDb[T] extends Table<infer R, string> ? R : never;
type NewRecord<T extends RecordTable> = Omit<RecordOf<T>, keyof BaseRecord>;

const nowIso = () => new Date().toISOString();

export async function createRecord<T extends RecordTable>(table: T, data: NewRecord<T>): Promise<string> {
  const id = crypto.randomUUID();
  const at = nowIso();
  const record = { ...data, id, createdAt: at, updatedAt: at } as RecordOf<T>;
  const t = db[table] as unknown as Table<RecordOf<T>, string>;
  await db.transaction('rw', t, db.audit, async () => {
    await t.add(record);
    await db.audit.add({ at, table, recordId: id, action: 'create', after: record });
  });
  return id;
}

export async function updateRecord<T extends RecordTable>(table: T, id: string, patch: Partial<NewRecord<T>>): Promise<void> {
  const t = db[table] as unknown as Table<RecordOf<T>, string>;
  const at = nowIso();
  await db.transaction('rw', t, db.audit, async () => {
    const before = await t.get(id);
    if (!before) throw new Error(`${table} ${id} not found`);
    const after = { ...before, ...patch, updatedAt: at } as RecordOf<T>;
    await t.put(after);
    await db.audit.add({ at, table, recordId: id, action: 'update', before, after });
  });
}

/** Voided records stay in storage and history but are ignored by the app and analysis. */
export async function voidRecord(table: RecordTable, id: string): Promise<void> {
  const t = db[table] as unknown as Table<BaseRecord, string>;
  const at = nowIso();
  await db.transaction('rw', t, db.audit, async () => {
    const before = await t.get(id);
    if (!before) return;
    const after = { ...before, voided: true, updatedAt: at };
    await t.put(after);
    await db.audit.add({ at, table, recordId: id, action: 'void', before, after });
  });
}

export async function getSettings(): Promise<Settings> {
  const s = await db.settings.get('settings');
  return { ...DEFAULT_SETTINGS, ...s };
}

export async function saveSettings(patch: Partial<Omit<Settings, 'key'>>): Promise<void> {
  const at = nowIso();
  await db.transaction('rw', db.settings, db.audit, async () => {
    const before = await getSettings();
    const after = { ...before, ...patch, key: 'settings' as const };
    await db.settings.put(after);
    // Backup timestamps change constantly and aren't test data.
    if (!('lastBackupAt' in patch && Object.keys(patch).length === 1)) {
      await db.audit.add({ at, table: 'settings', recordId: 'settings', action: 'update', before, after });
    }
  });
}

export async function savePhoto(blob: Blob): Promise<string> {
  const id = crypto.randomUUID();
  await db.photos.add({ id, blob, createdAt: nowIso() });
  return id;
}

export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
