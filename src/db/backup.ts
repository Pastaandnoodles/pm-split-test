import type { Table } from 'dexie';
import { db, RECORD_TABLES, saveSettings } from './db';
import type { Dataset, Photo } from '../domain/types';
import { buildPrinters } from '../domain/printers';

const BACKUP_FORMAT = 'pm-split-test-backup';
const BACKUP_VERSION = 1;

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(url: string): Promise<Blob> {
  return (await fetch(url)).blob();
}

export async function buildBackup(): Promise<Blob> {
  const tables: Record<string, unknown[]> = {};
  for (const t of RECORD_TABLES) tables[t] = await db[t].toArray();
  tables.settings = await db.settings.toArray();
  tables.audit = await db.audit.toArray();
  const photos = await db.photos.toArray();
  const photoData = await Promise.all(photos.map(async (p) => ({ id: p.id, createdAt: p.createdAt, dataUrl: await blobToDataUrl(p.blob) })));
  const payload = { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), tables, photos: photoData };
  return new Blob([JSON.stringify(payload)], { type: 'application/json' });
}

/** Replaces everything on this device with the backup's contents. */
export async function restoreBackup(file: File): Promise<void> {
  const payload = JSON.parse(await file.text());
  if (payload?.format !== BACKUP_FORMAT) throw new Error('This file is not a PM split test backup.');
  const photos: Photo[] = await Promise.all(
    (payload.photos ?? []).map(async (p: { id: string; createdAt: string; dataUrl: string }) => ({
      id: p.id,
      createdAt: p.createdAt,
      blob: await dataUrlToBlob(p.dataUrl),
    })),
  );
  const all = [...RECORD_TABLES.map((t) => db[t]), db.settings, db.audit, db.photos];
  await db.transaction('rw', all, async () => {
    for (const t of all) await t.clear();
    for (const t of RECORD_TABLES) await (db[t] as unknown as Table<unknown, string>).bulkAdd(payload.tables[t] ?? []);
    await db.settings.bulkAdd(payload.tables.settings ?? []);
    await db.audit.bulkAdd(payload.tables.audit ?? []);
    await db.photos.bulkAdd(photos);
  });
}

function csvCell(v: unknown): string {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Flattens one level of nested objects (e.g. checks.plateCleaned) into columns. */
export function toCsv(rows: Record<string, unknown>[]): string {
  const flat = rows.map((r) => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k2, v2] of Object.entries(v)) o[`${k}.${k2}`] = v2;
      else o[k] = v;
    }
    return o;
  });
  const cols = [...new Set(flat.flatMap((r) => Object.keys(r)))];
  return [cols.join(','), ...flat.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n');
}

export const CSV_TABLES = ['printers', ...RECORD_TABLES, 'audit'] as const;
export type CsvTable = (typeof CSV_TABLES)[number];

export async function tableCsv(table: CsvTable): Promise<string> {
  if (table === 'printers') {
    const s = await db.settings.get('settings');
    return toCsv(buildPrinters(s?.groupOverrides) as never[]);
  }
  const rows = (await db[table].toArray()) as unknown as Record<string, unknown>[];
  return toCsv(rows);
}

/** Saves a file: the iOS share sheet when available (Save to Files), otherwise a download link. */
export async function deliverFile(blob: Blob, filename: string): Promise<void> {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') throw e;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function markBackedUp(): Promise<void> {
  await saveSettings({ lastBackupAt: new Date().toISOString() });
}

export function stamp(): string {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
}

export type { Dataset };
