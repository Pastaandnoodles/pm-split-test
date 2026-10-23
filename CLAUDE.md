# CLAUDE.md — Printer PM Split Test Data Collection App

## What this project is

An offline-first iPad web app (PWA) for running and analyzing the **Printer Preventive Maintenance (PM) Split Test — Block H**.
The app has two jobs:

1. **Collect:** fast, tap-first data entry on the print floor by one user (the operator) on one iPad.
2. **Analyze:** a separate tab that compares Maintenance vs Control and gives a plain-English verdict, charts, and an ROI summary.

All test data is captured through this app. The paper error-code sheets on each printer are transcribed into it. The app is the source of truth.

## The experiment (domain model)

### Printers and layout
- 76 Bambu Lab printers (X1C / P1S / P1P / A1 family), IDs `H-01a`…`H-38a` and `H-01b`…`H-38b`.
- They stand in one long row, 2 printers tall and 38 columns long. `a` = **top**, `b` = **bottom**. The number `NN` = column.
- Each shelf holds 4 printers (2 columns × top/bottom), giving **19 shelves**. Shelf `k` holds columns `2k-1` and `2k`.

### Group assignment (fixed for the whole test)
- Every shelf has 2 Control and 2 Maintenance printers. The **left column (odd `NN`) = Control** and the **right column (even `NN`) = Maintenance**, top and bottom. Across the row the groups alternate C, M, C, M… That gives exactly 38/38, with 19 top and 19 bottom per group.
- The assignment can be edited on the Setup screen before the test starts, then it locks. Changing it afterward requires a deviation entry.
- Physical marker: Maintenance printers have tape on the bottom-left corner.

### Cycles and files
- A **cycle** = every printer runs one plate of the same file (38 plates per group).
- The goal is **532 plates per group** (about 14 cycles). Failed and canceled plates **count** toward the total.
- The file can change between cycles. Each **file** record stores: name, **parts per plate**, and **unit weight of one wigglitz (g)**.
- There is **no baseline period** (the test starts immediately). All printers have equal run time and wear, so the groups are treated as equal at the start.
- **Scope:** this test checks whether the PM bundle pays off at all. It doesn't try to attribute the effect to individual steps; later tests will do that.
- Filament is not tracked (assumed identical and controlled).
- **Firmware is frozen** on all 76 printers for the test. If an update is ever forced, every printer gets it at once and it's logged as a deviation.
- **A printer that goes down** stays in its group. It gets no plate runs until it's running again, so its group reaches the plate goal later. The operator logs only a down/up `Downtime` event (two taps) so the lost machine time counts in ROI.
- **Stopping rule:** the test runs until both groups reach 532 plates. No early stop. Before that point, the Analysis verdict is labeled **"Preliminary — not final"**.

### Maintenance steps (Maintenance group only)
| Step | Frequency |
|---|---|
| Fans dusted | One-time, test start |
| Debris / loose purge cleaned | One-time at start, then per print as needed |
| Lead screws cleaned and regreased | One-time, test start |
| Nozzle tip cleaned | One-time at start, then per print as needed |
| Plate cleaned (tape on tab) | Per print |
| Calibration run | Per print |

- The one-time order is fixed: fans → debris → lead screws → nozzle tip. The app enforces the order in a per-printer done checklist (one tap, or "Mark all ready").
- **Time is logged for the whole group, never per printer** (timing each printer takes too long). One-time steps: total minutes per step for the whole group (Setup tab). Per-print steps: total minutes for the whole Maintenance group per cycle (Cycles tab). The app derives the average per printer (step total ÷ printers done) and per plate (per-print total ÷ Maintenance plates).
- Per-print steps are **not ticked off**: they're implied done on every Maintenance plate and never done on Control (`impliedChecks(group)` fills `PlateRun.checks`). A skipped step is logged by hand as a `missed_step` deviation.
- Control: no process changes, reactive maintenance only.

### Plate pools
- Maintenance printers use **only** tape-marked cleaned plates. Control printers use **only** normal farm plates.
- Pools are kept separate through training, so the app doesn't ask about them. `correct_plate_pool` is always recorded as true. A mix-up is logged by hand as a `wrong_plate_pool` deviation.

### Roles
- **The operator** is the only app user. They remove all plates, log failures, transcribe error sheets, weigh bins, and clean and tape-mark plates.
- QC workers separate plates by group, run normal QC, put good parts into the group's bin, and return tape-marked plates to the operator. They don't use the app.

## Data captured

| Entity | Key fields |
|---|---|
| `Printer` | id, column, row (top/bottom), shelf, group, one-time PM steps (done, timestamp) |
| `PmTime` | group-level PM minutes: `one_time` (per step) or `per_print` (per cycle). **One editable total** per step / per cycle: typing a new number replaces it (older multi-entry data is summed, then collapsed on the next save) |
| `File` | name, parts_per_plate, unit_weight_g, print_time_min (full plate, from the slicer) |
| `Cycle` | number, file_id, started_at, ended_at, bin tare weight, notes |
| `PlateRun` (printer × cycle) | outcome `pass` / `fail_finished` / `fail_stopped` (see Pass/fail rule); `stopped_by` `printer` / `canceled` (for `fail_stopped`); pre-print checks (purge cleared, nozzle wiped, plate cleaned, calibration run); correct_plate_pool; cancel reason |
| Failure fields (on `PlateRun` when it isn't a pass) | `failureType` from fixed list, note, `fatalErrorId`, **`progressPct`** (from printer screen, `fail_stopped` only), **`scrapMassG`** |
| Photo (any plate outcome) | optional, its own section on the plate form (`photoId` → `photos` table) |
| `ErrorCode` | printer, cycle, HMS code (e.g. `0300-0100-0001-0007`), `resumed` or `fatal`, print progress % when it happened, note |
| `ReactiveMaintenance` (both groups) | printer, cycle, action, part replaced (optional), print progress % when it happened. **Counts only.** Repair time and part costs are outside this test (existing shop data covers them), so they are not entered or valued |
| `Downtime` | printer, down_at, up_at, reason |
| `BinWeight` | cycle, group, bin kind `good` (sold) / `seconds` (donated, not sold) / `scrap` (unredeemable, recycled), gross weight; tare is on the cycle |
| `Deviation` | type, printer/cycle (optional), description, include/exclude flag for analysis |
| `AuditLog` | every create/edit/void, with before/after values and timestamp |

### Pass/fail rule (fixed for the test)
- **Pass:** the print reached the end **and** at least one wigglitz on the plate is good. Pass plates go to QC, where the failed wigglitz on them are counted toward rejects.
- **Fail, finished:** the print reached the end, but every wigglitz is failed and can't be salvaged.
- **Fail, stopped:** the print didn't reach the end, either because the printer failed or because it was canceled (with a cancel reason). Plates print all objects layer by layer, so an unfinished plate has no complete parts. It always counts as a fail with zero good parts.
- Progress % is recorded only for `fail_stopped`. Finished plates are 100%.
- All three outcomes count toward the 532-plate goal.

**Failure types (fixed list):** first-layer/adhesion, warping, mid-print detachment, spaghetti, clog/under-extrusion, nozzle strike/scarring, purge blob/purge collision, layer shift, stringing/blobs, other.

**Reactive maintenance actions:** clear clog, replace nozzle/hotend, replace fan, re-seat/replace PTFE, clean plate, AMS fix, belt/motion fix, other.

**Error codes:** pick from recently used codes or type a new one. Store the description once per code. Codes come from the paper sheet on each printer. A code that could be resumed is `resumed`. A code that ended the plate is `fatal`, and that plate must be a `fail`.

**Cancellations** need a reason (printer issue / filament / operator / file / other) so non-printer cancels can be filtered out in analysis. They still count toward the plate total.

## Yield math (per cycle, per group)

```
expected_parts = passed_plates × parts_per_plate
good_parts     = (good_bin_gross − bin_tare) / unit_weight_g      (rounded)
seconds_parts  = (seconds_bin_gross − bin_tare) / unit_weight_g  (rounded)  donated, not sold
scrap_parts    = (scrap_bin_gross − bin_tare) / unit_weight_g    (rounded)  recycled
rejected_parts = seconds_parts + scrap_parts
missing_parts  = expected_parts − good_parts − rejected_parts     (negative = extra parts)
qc_yield       = good_parts / (good_parts + rejected_parts)
overall_yield  = good_parts / (all_plates_started × parts_per_plate)   ← headline metric
```
The operator weighs **the good, seconds and scrap bins** for each group every cycle (6 weighings per cycle). Only good parts earn revenue in the win formula. Old data with a single `reject` bin is migrated to `scrap`. The `missing_parts` value accounts for lost or misplaced parts. Flag a cycle when `|missing_parts|` exceeds the tolerance (configurable, default 2% of expected). If one group is short and the other is over by about the same amount, a plate probably went into the wrong group's bin. Reject fragments make the reject count approximate, which is why the tolerance exists.

**Unit weight** is set per file by weighing a sample: the operator weighs N good parts (default 20), and the app divides. That averages out part-to-part variation. The scale reads to 0.1 g, and wigglitz weigh 2–5 g, so scale error is negligible.

### Failed and canceled plates
Failed and canceled plates are scrapped. They count as zero good parts. For each one, the operator records:
- **Progress %** from the printer screen at the time of failure. This is the main measure of how far the plate got, and it shows the machine time lost (`progress % × print time`).
- **Scrap mass (g)**. This is the material wasted, valued at the filament cost.
- `mass_ratio = scrap_mass / (parts_per_plate × unit_weight_g)` is shown only as a secondary figure. Spaghetti keeps extruding after a failure and purge or supports add mass, so the mass ratio can overstate completion and must not replace progress %.

## Win definition (fixed before the test)

A win means the PM routine **makes more money than it costs**. Only the formula is fixed now. The dollar inputs are entered on the Setup screen and can be filled in later.

```
gain = (good_parts_M − good_parts_C) × value_per_good_part         (normalized per 38 plates)
     + (scrap_g_C − scrap_g_M) × filament_cost_per_g
     + (wasted_print_min_C − wasted_print_min_M) × machine_hour_value  (fail_finished = full print time; fail_stopped = progress % × print time)
     + (downtime_hours_C − downtime_hours_M) × machine_hour_value
cost = (one_time_PM_minutes + per_print_PM_minutes) × labor_rate
     + calibration_machine_minutes × machine_hour_value
net  = gain − cost                       → win if net > 0 (with its confidence range)
```
Control has no PM minutes by definition. Repair labor and replacement-part costs are **not** in the formula: this test isn't measuring them, and existing shop data covers them. Normal handling (pulling plates, starting prints) is the same for both groups and cancels out.

## Setup values (entered in the app)

- Per file: name, parts per plate, unit weight (from the sample weighing), print time (hours + minutes).
- Calibration machine minutes per print.
- Dollars: labor rate ($/hr), value per good wigglitz, filament cost ($/kg), machine-hour value.
- Missing-parts tolerance (default 2%).
- The pass/fail rule is enforced by training and isn't shown in the app (the outcome buttons carry the three outcomes).

## UI

- **Main screen: shelf map grid.** 38 columns × 2 rows that mirror the real layout, with shelf dividers every 2 columns and groups color-coded (also shown with a pattern or letter, so color isn't the only cue). Each tile shows the current cycle's status: pending / pass / fail / cancel, plus badges for error codes and reactive maintenance.
- Tapping a printer opens a sheet with, in order: plate (outcome, failure details, optional photo), error codes, reactive maintenance, deviations, history, and **printer down at the bottom** (it's rare). While a printer is down, its "Mark back up" banner moves to the top.
- Other tabs: **Setup** (printers, groups, files, one-time PM checklist), **Cycles** (start/close a cycle, bin weights; closed cycles as tabs, green ✓ when complete and yellow ⚠ when data is missing, per `missingCycleData`), **Analysis**, **Data** (export/backup/restore, audit log).
- iPad-first: large touch targets (≥ 48px), usable with gloves, landscape and portrait, minimal typing. Show a progress bar toward 532 per group at all times.

## Analysis tab

Audience: managers. Lead with a **plain-English verdict** ("Maintenance is clearly better / no clear difference yet / no difference"), then charts.
- Pass / fail / cancel rate by group with 95% confidence intervals (Wilson).
- **The statistical unit is the printer, not the plate.** Plates from the same printer are correlated. Significance comes from a **permutation test or printer-level bootstrap** on per-printer rates, never a naive two-proportion test on 1,064 plates.
- Yield: Maintenance vs Control **paired by cycle** (same file, same cycle).
- Failure types by group, error codes (resumed vs fatal) by group, top codes.
- Reactive maintenance events, parts, and minutes by group.
- **Trend by cycle**, to show whether the one-time PM effect fades. Charts (each cycle's Control and Maintenance bars nearly touching): an "All cycles average" panel on the left and one bar pair per cycle on the right, on the same 0–100% scale. **Plate pass rate**: grouped bars. **Yield results**: stacked bars of good (solid group color), seconds, scrap and missing (increasingly translucent) as shares of the parts expected from passed plates (`yieldShare`). The **Yield per cycle** table has one row per measure and, for each cycle, a Control and a Maintenance sub-column side by side (tinted in the group color, better value bold).
- Per-printer table and shelf heatmap, with outlier printers flagged. Top vs bottom row comparison.
- **ROI:** the net value from the Win definition formula, with a breakdown of each term. If dollar inputs are missing, show the labor minutes and part counts instead.
- Failure progress % and scrap mass by group, plus **wigglitz lost to scrap** (`scrapToParts`: each cycle's scrap grams ÷ that cycle's file unit weight, rounded, summed).
- A toggle to include or exclude deviation-flagged and non-printer-cancel plates.
- Stated scope and limitations: this test asks whether the PM bundle pays off at all. Which individual steps drive the payoff is left to future tests. There's no baseline period, because all printers have equal run time and wear. The observer isn't blinded. QC yield is measured per group per cycle only, never per printer. Per-printer analysis uses plate outcomes, failures, error codes, and reactive maintenance.

## Tech stack

- **PWA** installed to the iPad Home Screen, fully offline after first load (service worker caches the app shell). It must be served over HTTPS from a static host (e.g. GitHub Pages / Netlify).
- Vite + TypeScript + React. **IndexedDB via Dexie** for storage. Call `navigator.storage.persist()` on first run.
- Charts: a lightweight library (e.g. Chart.js). Photos are stored as compressed JPEG blobs in IndexedDB (downscale to ~1280px).
- No backend and no accounts. One device, one user.

## Export / backup

- **CSV** per table (for Excel).
- **Full JSON backup** (including photos) and **restore** onto a new iPad, via the iOS share sheet / Files.
- **PDF report** of the Analysis tab (print stylesheet + `window.print()` → Save as PDF).
- Show a **"back up now" reminder** when the last backup is more than 24h old or after each cycle closes. The data lives only on this iPad.

## Code layout and commands

```
src/domain/   pure logic, no browser APIs. types, printers (layout and groups), yield, stats, analysis (verdict and economics)
src/db/       Dexie storage with an audit trail (db.ts), live dataset hook, backup/restore/CSV, practice data
src/ui/       React views: Map (shelf grid) + PrinterSheet, Cycles, Analysis (+ charts), Setup, Data
scripts/      make-icons.mjs writes the PWA icons into public/
```

- `npm run dev`: dev server, reachable from the iPad on the same Wi-Fi.
- `npm test`: domain unit tests (vitest). Add tests here when changing any math.
- `npm run build`: type-check plus production build into `dist/`.
- Deployment: `.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every push to `main`.
- Chart colors: Control = blue `#2a78d6` (dark `#3987e5`), Maintenance = orange `#eb6834` (dark `#d95926`). Both pass the CVD and contrast checks. Group identity always comes with a letter or label too, never color alone.
- All writes go through `createRecord` / `updateRecord` / `voidRecord` / `saveSettings` in `src/db/db.ts`, so they're audited. Never write to Dexie tables directly from the UI.

## Conventions

- **This repository is public** (GitHub Pages). Never put people's names, company names, or site/unit names in code, docs, or commit messages. Say "the operator" instead.

- Printer IDs are always `H-NNx` (zero-padded, lowercase `a`/`b`).
- Store raw events only. Every metric is computed from them, and no derived totals are stored as the source of truth.
- Edits never destroy data: void or edit writes to `AuditLog` with before/after values. Analysis ignores voided records.
- Every record has `id` (UUID), `created_at`, `updated_at`.
- Keep the domain logic (group assignment, yield math, statistics) in pure, unit-tested modules separate from the UI.
