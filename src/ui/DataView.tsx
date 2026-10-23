import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Dataset } from '../domain/types';
import { db } from '../db/db';
import { CSV_TABLES, buildBackup, deliverFile, markBackedUp, restoreBackup, stamp, tableCsv, type CsvTable } from '../db/backup';
import { eraseAll, loadDemo } from '../db/demo';
import { ConfirmButton, fmtTime } from './common';

const CSV_LABELS: Record<CsvTable, string> = {
  printers: 'Printers',
  files: 'Files',
  cycles: 'Cycles',
  plateRuns: 'Plates',
  errorCodes: 'Error codes',
  reactive: 'Repairs',
  downtime: 'Downtime',
  bins: 'Bin weights',
  deviations: 'Deviations',
  oneTime: 'One-time PM',
  pmTime: 'PM time',
  audit: 'Audit log',
};

export function DataView({ ds }: { ds: Dataset }) {
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [persisted, setPersisted] = useState<boolean>();
  const [usage, setUsage] = useState<string>();
  const [confirmText, setConfirmText] = useState('');
  const audit = useLiveQuery(() => db.audit.orderBy('seq').reverse().limit(100).toArray(), []);

  useEffect(() => {
    void navigator.storage?.persisted?.().then(setPersisted);
    void navigator.storage?.estimate?.().then((e) => e.usage !== undefined && setUsage(`${(e.usage / 1_048_576).toFixed(1)} MB used`));
  }, []);

  async function run(label: string, f: () => Promise<void>) {
    setBusy(true);
    setMsg(undefined);
    try {
      await f();
      setMsg(`✓ ${label}`);
    } catch (e) {
      if ((e as DOMException).name !== 'AbortError') setMsg(`✕ ${label} failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="section">
      {msg && <div className="banner info">{msg}</div>}
      <div className="card stack">
        <h2>Backup</h2>
        <p className="secondary" style={{ margin: 0 }}>
          The data lives only on this iPad. Save a full backup (including photos) to Files or AirDrop it at least once a day and after every cycle.
        </p>
        <span className="small secondary">
          Last backup: {ds.settings.lastBackupAt ? fmtTime(ds.settings.lastBackupAt) : 'never'}
          {' · '}Storage {persisted ? 'protected from automatic clearing' : persisted === false ? 'NOT protected (add the app to the Home Screen)' : 'unknown'}
          {usage ? ` · ${usage}` : ''}
        </span>
        <div className="btn-row">
          <button
            className="btn primary"
            disabled={busy}
            onClick={() =>
              run('Backup saved', async () => {
                await deliverFile(await buildBackup(), `pm-test-backup-${stamp()}.json`);
                await markBackedUp();
              })
            }
          >
            Save full backup
          </button>
          <label className="btn">
            Restore from backup…
            <input
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f && window.confirm('Restoring replaces ALL data on this iPad with the backup. Continue?')) void run('Backup restored', () => restoreBackup(f));
              }}
            />
          </label>
        </div>
      </div>

      <div className="card stack">
        <h2>Export CSV</h2>
        <p className="secondary small" style={{ margin: 0 }}>
          One file per table, for Excel. Voided records are included with voided = true.
        </p>
        <div className="btn-row">
          {CSV_TABLES.map((t) => (
            <button key={t} className="btn" disabled={busy} onClick={() => run(`${CSV_LABELS[t]} exported`, async () => deliverFile(new Blob([await tableCsv(t)], { type: 'text/csv' }), `pm-test-${t}-${stamp()}.csv`))}>
              {CSV_LABELS[t]}
            </button>
          ))}
        </div>
        <p className="secondary small" style={{ margin: 0 }}>
          For a PDF report, use "Save PDF report" on the Analysis tab.
        </p>
      </div>

      <div className="card stack">
        <h2>Recent changes</h2>
        <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Table</th>
                <th>Record</th>
              </tr>
            </thead>
            <tbody>
              {(audit ?? []).map((a) => (
                <tr key={a.seq}>
                  <td className="num">{fmtTime(a.at)}</td>
                  <td>{a.action}</td>
                  <td>{a.table}</td>
                  <td className="small muted num">{a.recordId.slice(0, 8)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card stack">
        <h2>Practice data</h2>
        <p className="secondary small" style={{ margin: 0 }}>
          Load 4 made-up cycles to try the app, then erase before the real test starts. Both actions replace everything on this iPad.
        </p>
        <label className="field">
          <span>Type ERASE to enable</span>
          <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoCapitalize="characters" />
        </label>
        <div className="btn-row">
          <ConfirmButton className="btn" disabled={confirmText !== 'ERASE'} onConfirm={() => run('Practice data loaded', loadDemo)}>
            Load practice data
          </ConfirmButton>
          <ConfirmButton className="btn danger" disabled={confirmText !== 'ERASE'} onConfirm={() => run('All data erased', eraseAll)}>
            Erase all data
          </ConfirmButton>
        </div>
      </div>
    </div>
  );
}
