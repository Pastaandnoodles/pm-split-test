import { useMemo, useState } from 'react';
import { analyze, GROUPS, type AnalysisOptions, type AnalysisResult, type PrinterStats } from '../domain/analysis';
import { wilson } from '../domain/stats';
import type { GroupCycleYield } from '../domain/yield';
import { FAILURE_TYPES, FAILURE_TYPE_LABELS, ONE_TIME_STEP_LABELS, type Dataset, type Group } from '../domain/types';
import { GROUP_LABEL, GROUP_SHORT } from '../domain/printers';
import { Check, GroupTag, fmtMoney, fmtNum, fmtPct } from './common';
import { GroupBarChart, PassRateBars, YieldStackBars } from './charts';

function loadOpts(): AnalysisOptions {
  try {
    const raw = localStorage.getItem('analysisOpts');
    if (raw) return { excludeDeviations: true, excludeNonPrinterCancels: true, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return { excludeDeviations: true, excludeNonPrinterCancels: true };
}

export function AnalysisView({ ds }: { ds: Dataset }) {
  const [opts, setOptsState] = useState(loadOpts);
  const setOpts = (o: AnalysisOptions) => {
    setOptsState(o);
    try {
      localStorage.setItem('analysisOpts', JSON.stringify(o));
    } catch {
      /* storage unavailable */
    }
  };
  const r = useMemo(() => analyze(ds, opts), [ds, opts]);

  return (
    <div className="section">
      <div className="row no-print">
        <Check label="Exclude plates flagged by deviations" checked={opts.excludeDeviations} onChange={(v) => setOpts({ ...opts, excludeDeviations: v })} />
        <Check label="Exclude non-printer cancels" checked={opts.excludeNonPrinterCancels} onChange={(v) => setOpts({ ...opts, excludeNonPrinterCancels: v })} />
        <span className="spacer" />
        <button className="btn" onClick={() => window.print()}>
          Save PDF report
        </button>
      </div>
      <h2 className="print-only">Block H PM Split Test Report · {new Date().toLocaleDateString()}</h2>
      <VerdictCard r={r} />
      <OutcomeTiles r={r} />
      <TrendCard r={r} />
      <YieldTable r={r} />
      <div className="charts">
        <FailureTypesCard r={r} />
        <ErrorsCard r={r} />
      </div>
      <RepairsCard r={r} />
      <RowsCard r={r} />
      <EconomicsCard r={r} />
      <HeatmapCard r={r} />
      <PrinterTable r={r} />
      <LimitsCard />
    </div>
  );
}

function VerdictCard({ r }: { r: AnalysisResult }) {
  const v = r.verdict;
  return (
    <div className={`card stack verdict ${v.tone}`}>
      <div className="row">
        {v.preliminary ? <span className="pill warn">⚠ Preliminary: not final until both groups reach {r.goal} plates</span> : <span className="pill">Final</span>}
      </div>
      <h2>
        {v.tone === 'better' ? '▲ ' : v.tone === 'worse' ? '▼ ' : ''}
        {v.headline}
      </h2>
      <p style={{ margin: 0 }}>{v.detail}</p>
      <p className="small muted" style={{ margin: 0 }}>
        "Clearly" means the difference is unlikely to be luck (p &lt; 0.05). Each printer counts as one unit, so 1,064 plates from 76 printers aren't treated as 1,064 independent tests.
        {r.yieldTest && ` Yield test p = ${r.yieldTest.pValue.toFixed(3)} over ${r.yieldTest.n} cycles.`}
        {r.passTest && ` Pass-rate test p = ${r.passTest.pValue.toFixed(3)} over ${r.passTest.nA + r.passTest.nB} printers.`}
      </p>
    </div>
  );
}

function OutcomeTiles({ r }: { r: AnalysisResult }) {
  return (
    <div className="tiles">
      {GROUPS.map((g) => {
        const o = r.outcomes[g];
        return (
          <div key={g} className="card stat">
            <div className="label">
              <GroupTag group={g} /> plate pass rate
            </div>
            <div className="value">{fmtPct(o.passRate.estimate)}</div>
            <div className="sub num">
              Likely range {fmtPct(o.passRate.low)}–{fmtPct(o.passRate.high)} · {o.pass}/{o.n} plates
            </div>
            <div className="sub num">
              Fail finished {o.failFinished} · stopped {o.failStopped} · canceled {o.canceled}
            </div>
          </div>
        );
      })}
      {GROUPS.map((g) => (
        <div key={`s${g}`} className="card stat">
          <div className="label">
            <GroupTag group={g} /> scrap
          </div>
          <div className="value">{fmtNum(r.scrap[g].totalScrapG)} g</div>
          <div className="sub">
            {r.scrap[g].stoppedCount} stopped plates · avg progress {r.scrap[g].meanProgressPct === null ? '–' : `${r.scrap[g].meanProgressPct.toFixed(0)}%`}
          </div>
          <div className="sub">≈ {fmtNum(r.scrap[g].lostPrintHours, 1)} h of printer time spent on failed plates</div>
        </div>
      ))}
    </div>
  );
}

function TrendCard({ r }: { r: AnalysisResult }) {
  if (r.trend.length === 0) return null;
  return (
    <>
      <div className="card stack">
        <h3>Plate pass rate</h3>
        <span className="small muted">Share of plates that passed. If the Maintenance bars shrink in later cycles, the one-time PM is wearing off.</span>
        <PassRateBars
          average={{ control: r.outcomes.control.passRate.estimate, maintenance: r.outcomes.maintenance.passRate.estimate }}
          cycles={r.trend.map((t) => ({ label: `C${t.cycleNumber}`, values: t.passRate }))}
        />
      </div>
      <div className="card stack">
        <h3>Yield results</h3>
        <span className="small muted">
          Where the parts from passed plates ended up: good (solid), seconds, scrap and missing (fainter). Failed plates are in the pass rate above.
        </span>
        <YieldStackBars average={r.composition.average} cycles={r.composition.perCycle.map((c) => ({ label: `C${c.cycleNumber}`, shares: c.shares }))} />
      </div>
    </>
  );
}

type YieldMetric = { label: string; get: (y: GroupCycleYield) => number | null; fmt: (x: number | null) => string; higherIsBetter: boolean };
const YIELD_METRICS: YieldMetric[] = [
  { label: 'Good parts', get: (y) => y.goodParts, fmt: (x) => fmtNum(x), higherIsBetter: true },
  { label: 'Seconds', get: (y) => y.secondsParts, fmt: (x) => fmtNum(x), higherIsBetter: false },
  { label: 'Scrap', get: (y) => y.scrapParts, fmt: (x) => fmtNum(x), higherIsBetter: false },
  { label: 'QC yield', get: (y) => y.qcYield, fmt: (x) => fmtPct(x), higherIsBetter: true },
  { label: 'Overall yield', get: (y) => y.overallYield, fmt: (x) => fmtPct(x), higherIsBetter: true },
];

/** Cycles run across; for each measure the Control and Maintenance rows sit together so each cycle compares directly. */
function YieldTable({ r }: { r: AnalysisResult }) {
  if (!r.cycleYields.length) return null;
  const cycles = r.cycleYields;
  const better = (m: YieldMetric, c: (typeof cycles)[number], g: Group) => {
    const mine = m.get(c[g]);
    const other = m.get(c[g === 'control' ? 'maintenance' : 'control']);
    if (mine === null || other === null || mine === other) return false;
    return m.higherIsBetter ? mine > other : mine < other;
  };
  return (
    <div className="card stack">
      <h3>Yield per cycle</h3>
      <span className="small muted">Bold = the better of the two groups for that cycle (more good parts and yield, fewer seconds and scrap).</span>
      <div className="table-wrap">
        <table className="yield-grid">
          <thead>
            <tr>
              <th>Measure</th>
              <th>Group</th>
              {cycles.map((c) => (
                <th key={c.cycleId} className="r">
                  C{c.cycleNumber}
                </th>
              ))}
            </tr>
          </thead>
          {YIELD_METRICS.map((m) => (
            <tbody key={m.label}>
              {GROUPS.map((g, i) => (
                <tr key={g} className={`yrow g-${g}`}>
                  {i === 0 && (
                    <th rowSpan={2} scope="rowgroup" className="ylabel">
                      {m.label}
                    </th>
                  )}
                  <td>
                    <span className={`gtag g-${g}`}>{GROUP_SHORT[g]}</span>
                  </td>
                  {cycles.map((c) => (
                    <td key={c.cycleId} className="r" style={better(m, c, g) ? { fontWeight: 700 } : undefined}>
                      {m.fmt(m.get(c[g]))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ))}
          <tbody>
            <tr>
              <th colSpan={2} className="ylabel">
                Overall yield difference (M − C)
              </th>
              {cycles.map((c) => {
                const d = c.control.overallYield !== null && c.maintenance.overallYield !== null ? c.maintenance.overallYield - c.control.overallYield : null;
                return (
                  <td key={c.cycleId} className="r">
                    {d === null ? '–' : `${d >= 0 ? '▲ +' : '▼ '}${(d * 100).toFixed(1)} pts`}
                  </td>
                );
              })}
            </tr>
            <tr>
              <th colSpan={2} className="ylabel">
                Flags
              </th>
              {cycles.map((c) => {
                const flags = [...c.control.flags, ...c.maintenance.flags, ...(c.hint ? [c.hint] : [])];
                return (
                  <td key={c.cycleId} className="r small" title={flags.join('\n')}>
                    {flags.length ? <span className="st-fail">⚠ {flags.length}</span> : ''}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
      {r.yieldTest && (
        <span className="secondary small">
          Average difference {(r.yieldTest.meanDiff * 100).toFixed(1)} pts (likely range {(r.yieldTest.ci.low * 100).toFixed(1)} to {(r.yieldTest.ci.high * 100).toFixed(1)}), paired by cycle.
        </span>
      )}
    </div>
  );
}

function FailureTypesCard({ r }: { r: AnalysisResult }) {
  const types = FAILURE_TYPES.filter((t) => r.failureTypes[t].control + r.failureTypes[t].maintenance > 0);
  return (
    <div className="card stack">
      <h3>Failure types</h3>
      {types.length === 0 ? (
        <p className="muted">No failures logged.</p>
      ) : (
        <>
          <GroupBarChart
            horizontal
            height={Math.max(160, types.length * 44 + 60)}
            labels={types.map((t) => FAILURE_TYPE_LABELS[t])}
            series={{ control: types.map((t) => r.failureTypes[t].control), maintenance: types.map((t) => r.failureTypes[t].maintenance) }}
            label="Failure counts by type for each group"
          />
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th className="r">C</th>
                <th className="r">M</th>
              </tr>
            </thead>
            <tbody>
              {types.map((t) => (
                <tr key={t}>
                  <td>{FAILURE_TYPE_LABELS[t]}</td>
                  <td className="r">{r.failureTypes[t].control}</td>
                  <td className="r">{r.failureTypes[t].maintenance}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function ErrorsCard({ r }: { r: AnalysisResult }) {
  return (
    <div className="card stack">
      <h3>Error codes</h3>
      <GroupBarChart
        labels={['Resumed', 'Fatal']}
        series={{ control: [r.errors.control.resumed, r.errors.control.fatal], maintenance: [r.errors.maintenance.resumed, r.errors.maintenance.fatal] }}
        label="Resumed and fatal error codes for each group"
        height={220}
      />
      {r.topCodes.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Top codes</th>
              <th className="r">C</th>
              <th className="r">M</th>
            </tr>
          </thead>
          <tbody>
            {r.topCodes.map((c) => (
              <tr key={c.code}>
                <td className="num">{c.code}</td>
                <td className="r">{c.control}</td>
                <td className="r">{c.maintenance}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RepairsCard({ r }: { r: AnalysisResult }) {
  const parts = [...new Set(GROUPS.flatMap((g) => Object.keys(r.reactive[g].parts)))];
  return (
    <div className="card stack">
      <h3>Maintenance labor and repairs</h3>
      <div className="tiles">
        {GROUPS.map((g) => (
          <div key={g} className="stat">
            <div className="label">
              <GroupTag group={g} />
            </div>
            <div className="value">{r.reactive[g].count} repairs</div>
            <div className="sub">≈ {fmtNum(r.reactive[g].minutes)} minutes (from typical repair times)</div>
          </div>
        ))}
        <div className="stat">
          <div className="label">PM labor (Maintenance)</div>
          <div className="value">{fmtNum((r.labor.oneTimeMinutes + r.labor.perPrintMinutes) / 60, 1)} h</div>
          <div className="sub">
            One-time {fmtNum(r.labor.oneTimeMinutes)} min · per print {fmtNum(r.labor.perPrintMinutes)} min
            {r.labor.perPrintAvgPerPlate !== null && ` (≈ ${fmtNum(r.labor.perPrintAvgPerPlate, 1)} min per plate)`}
          </div>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>One-time step</th>
            <th className="r">Group total</th>
            <th className="r">Printers done</th>
            <th className="r">Average per printer</th>
          </tr>
        </thead>
        <tbody>
          {r.labor.steps.map((s) => (
            <tr key={s.step}>
              <td>{ONE_TIME_STEP_LABELS[s.step]}</td>
              <td className="r">{fmtNum(s.minutes)} min</td>
              <td className="r">{s.printersDone}</td>
              <td className="r">{s.avgPerPrinter === null ? '–' : `${fmtNum(s.avgPerPrinter, 1)} min`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {parts.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Part replaced</th>
              <th className="r">C</th>
              <th className="r">M</th>
            </tr>
          </thead>
          <tbody>
            {parts.map((p) => (
              <tr key={p}>
                <td>{p}</td>
                <td className="r">{r.reactive.control.parts[p] ?? 0}</td>
                <td className="r">{r.reactive.maintenance.parts[p] ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RowsCard({ r }: { r: AnalysisResult }) {
  return (
    <div className="card stack">
      <h3>Top vs bottom row</h3>
      <span className="small muted">If both groups do worse on one row, row position matters, but it affects both groups equally by design.</span>
      <table>
        <thead>
          <tr>
            <th>Group</th>
            <th className="r">Top (a) pass rate</th>
            <th className="r">Bottom (b) pass rate</th>
          </tr>
        </thead>
        <tbody>
          {GROUPS.map((g) => (
            <tr key={g}>
              <td>
                <GroupTag group={g} />
              </td>
              <td className="r">{fmtPct(r.rows[g].top.estimate)}</td>
              <td className="r">{fmtPct(r.rows[g].bottom.estimate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EconomicsCard({ r }: { r: AnalysisResult }) {
  const e = r.economics;
  const hasDollars = e.netPerCycle !== null;
  return (
    <div className="card stack">
      <h3>Does maintenance pay for itself?</h3>
      {e.cyclesUsed === 0 ? (
        <p className="muted">Needs at least one cycle with both groups' good bins weighed.</p>
      ) : (
        <>
          {hasDollars && (
            <div className="stat">
              <div className="label">Net value per cycle (38 plates per group)</div>
              <div className="value">
                {e.netPerCycle!.estimate >= 0 ? '▲ ' : '▼ '}
                {fmtMoney(e.netPerCycle!.estimate)}
              </div>
              <div className="sub">
                Likely range {fmtMoney(e.netPerCycle!.low)} to {fmtMoney(e.netPerCycle!.high)} over {e.cyclesUsed} cycles.{' '}
                {Number.isFinite(e.netPerCycle!.low) && e.netPerCycle!.low > 0 ? 'Pays off.' : Number.isFinite(e.netPerCycle!.high) && e.netPerCycle!.high < 0 ? 'Costs more than it returns.' : 'Not clear yet.'}
              </div>
            </div>
          )}
          <table>
            <thead>
              <tr>
                <th>Per cycle (positive = in favor of Maintenance)</th>
                <th className="r">Amount</th>
                <th className="r">Dollars</th>
              </tr>
            </thead>
            <tbody>
              {e.terms.map((t) => (
                <tr key={t.label}>
                  <td>{t.label}</td>
                  <td className="r">
                    {t.units === '$' ? fmtMoney(t.perCycle) : `${fmtNum(t.perCycle, t.units === 'h' ? 2 : 0)} ${t.units}`}
                  </td>
                  <td className="r">{fmtMoney(t.dollarsPerCycle)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {e.missingInputs.length > 0 && <span className="small secondary">Missing dollar values (Setup tab): {e.missingInputs.join(', ')}.</span>}
        </>
      )}
    </div>
  );
}

function isOutlier(p: PrinterStats, groupRate: number): boolean {
  if (p.n < 3) return false;
  return wilson(p.pass, p.n).high < groupRate;
}

function HeatmapCard({ r }: { r: AnalysisResult }) {
  const byPos = new Map(r.perPrinter.map((p) => [`${p.printer.column}${p.printer.row}`, p]));
  return (
    <div className="card stack">
      <h3>Failure rate by position</h3>
      <span className="small muted">Darker red = more failed plates. Dot = Maintenance printer. Laid out like the real row: top printers above, bottom below.</span>
      {(['a', 'b'] as const).map((row) => (
        <div key={row} className="heat">
          {Array.from({ length: 38 }, (_, i) => {
            const p = byPos.get(`${i + 1}${row}`)!;
            const fail = p.n ? 1 - p.passRate : null;
            return (
              <div
                key={i}
                className={`cell${p.printer.group === 'maintenance' ? ' m' : ''}`}
                title={`${p.printer.id} (${GROUP_LABEL[p.printer.group]}): ${p.n ? `${p.fail}/${p.n} failed` : 'no plates'}`}
                style={{ background: fail === null ? 'var(--surface-2)' : `color-mix(in srgb, var(--critical) ${Math.round(10 + fail * 90)}%, var(--surface))` }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

function PrinterTable({ r }: { r: AnalysisResult }) {
  const groupRate = Object.fromEntries(GROUPS.map((g) => [g, r.outcomes[g].passRate.estimate])) as Record<Group, number>;
  const [showAll, setShowAll] = useState(false);
  const all = [...r.perPrinter].filter((p) => p.n > 0).sort((a, b) => a.passRate - b.passRate || b.n - a.n);
  if (!all.length) return null;
  const rows = showAll ? all : all.slice(0, 15);
  return (
    <div className="card stack">
      <h3>Per printer (worst first)</h3>
      <span className="small muted">⚠ = clearly worse than its group's average.</span>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Printer</th>
              <th>Group</th>
              <th className="r">Plates</th>
              <th className="r">Pass rate</th>
              <th className="r">Resumed</th>
              <th className="r">Fatal</th>
              <th className="r">Repairs</th>
              <th className="r">Repair min</th>
              <th className="r">Down h</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.printer.id}>
                <td>
                  <strong>{p.printer.id}</strong> {isOutlier(p, groupRate[p.printer.group]) && <span className="st-fail">⚠</span>}
                </td>
                <td>
                  <span className={`gtag g-${p.printer.group}`}>{GROUP_SHORT[p.printer.group]}</span>
                </td>
                <td className="r">{p.n}</td>
                <td className="r">{fmtPct(p.passRate, 0)}</td>
                <td className="r">{p.resumed}</td>
                <td className="r">{p.fatal}</td>
                <td className="r">{p.reactiveCount}</td>
                <td className="r">{p.reactiveMinutes}</td>
                <td className="r">{fmtNum(p.downtimeHours, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {all.length > 15 && (
        <button className="btn small no-print" style={{ alignSelf: 'flex-start' }} onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show worst 15' : `Show all ${all.length}`}
        </button>
      )}
    </div>
  );
}

function LimitsCard() {
  return (
    <div className="card stack small secondary">
      <h3>Scope and limitations</h3>
      <span>This test asks whether the PM routine pays off as a bundle. Which individual steps drive the payoff is left to future tests.</span>
      <span>There's no baseline period, because all printers have equal run time and wear.</span>
      <span>The person logging results knows each printer's group, so the test isn't blinded.</span>
      <span>QC yield is measured per group per cycle, never per printer.</span>
    </div>
  );
}
