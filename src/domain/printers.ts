import type { Group, Printer, Row } from './types';

export const COLUMNS = 38;
export const SHELVES = COLUMNS / 2;

export function printerId(column: number, row: Row): string {
  return `H-${String(column).padStart(2, '0')}${row}`;
}

export function parsePrinterId(id: string): { column: number; row: Row } | null {
  const m = /^H-(\d{2})([ab])$/.exec(id);
  if (!m) return null;
  const column = Number(m[1]);
  if (column < 1 || column > COLUMNS) return null;
  return { column, row: m[2] as Row };
}

/** Shelf k holds columns 2k-1 (left) and 2k (right). */
export function shelfOf(column: number): number {
  return Math.ceil(column / 2);
}

/** Left column of every shelf (odd) is Control, right column (even) is Maintenance. */
export function defaultGroup(column: number): Group {
  return column % 2 === 1 ? 'control' : 'maintenance';
}

export function buildPrinters(overrides: Record<string, Group> = {}): Printer[] {
  const printers: Printer[] = [];
  for (let column = 1; column <= COLUMNS; column++) {
    for (const row of ['a', 'b'] as Row[]) {
      const id = printerId(column, row);
      printers.push({ id, column, row, shelf: shelfOf(column), group: overrides[id] ?? defaultGroup(column) });
    }
  }
  return printers;
}

export const GROUP_LABEL: Record<Group, string> = { control: 'Control', maintenance: 'Maintenance' };
export const GROUP_SHORT: Record<Group, string> = { control: 'C', maintenance: 'M' };
