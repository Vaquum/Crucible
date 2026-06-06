# PRD — Dataset source selection

Status: draft for review · Owner: operator · Delivery: **one PR** (slices below are stages of that PR, not separate PRs).

## 1. Goal

Remove Crucible's hardcoded Origo data and let the user pick the dataset to analyse from a **Mill-style modal** opened by a new top-left icon (before the calendar). Crucible becomes a **generic columnar scatter explorer** over whatever dataset is selected. Sources at launch: **Upload**, **Sweep logs** (Furnace results), **Klines** (`/opt/arrow` via Limen). The card grid is extensible — more source cards land later.

## 2. Current state (all of this is removed)

`src/crucible/serve.py` hardcodes two Arrow sources read with `pyarrow.dataset`:
- `binance_daily_spot_trades` (`trades_<day>.arrow`) and `btc_master_panel` (`btc_master_panel_<ms>.arrow`), via `ORIGO_ARROW_DIR` / `ORIGO_PANEL_DIR`.
- On-the-fly time-grouping + `rubric` aggregation (`bar_table`, `aggregate`, groupby grids), and a fixed `PANEL_FIELDS` column set.

The GUI exposes `Bar`, `Groupby`, `Groupby Func`, `Grid`. **GROUPBY and GROUPBY FUNC are removed entirely**; the hardcoded trades/panel/rubric path is deleted.

## 3. Ground truth (from investigation — conclusive)

**Mill modal (style + mechanics to copy 1:1)** — `Mill/src/mill/assets/index.html`
- `.modal{position:absolute;inset:0;background:var(--bg);display:none}` + `.modal.open{display:flex}`; `.modal-panel` (margin `--s-6`, 1px `--border`, 2px radius); `.modal-head` (title + `×`); `.modal-body{overflow:auto}`. Opaque full-bleed, not a translucent backdrop.
- One-overlay-at-a-time state machine (`toggleOverlay`/`closeAllOverlays`); close via `×`, backdrop click (`e.target===modal`), global `Escape`. Trigger = `.icon-button` (36×36, `title=` tooltip, currentColor SVG), `.active`→accent while open.
- Mill has **no card grid and no tree** — both are built in Mill's token language. Closest idioms: `.row-groups` (auto-fill option-column grid) and `.active-chip` (single-open collapsible disclosure) for the sweep tree.

**Limen — the klines loader** — `Limen/limen/data/historical_data.py:960`
- `HistoricalData().get_arrow_file(file_path=..., start_date_limit=..., end_date_limit=..., row_count_limit=...) -> polars.DataFrame`. Internally `pl.read_ipc(path, memory_map=True, rechunk=False)` behind a strict guard: file must be a **single, uncompressed record batch** with an `Int64`-ns `ts` column (a `datetime` column is derived from `ts`).
- Reads one local file `<arrow_root>/<series>/latest.arrow` (Mill's `arrow_latest_path`, default root `/opt/arrow`).
- **Version gate:** `get_arrow_file` exists from Limen **3.14.0**; Crucible has no Limen and Furnace's 3.13.0 lacks it. Depend on `vaquum_limen @ git+https://github.com/Vaquum/Limen.git@main` (Mill's pin).

**Klines store (remote ground truth, TDW `37.27.112.167`)**
- Docker volume `tdw-control-plane_arrow` → `/var/lib/docker/volumes/tdw-control-plane_arrow/_data/<series>/latest.arrow`.
- Series present: `time_1m, time_15m, time_30m, time_1h, time_2h, time_4h`, `dollar_1M, dollar_15M, dollar_30M, dollar_60M, dollar_120M, dollar_240M`.
- Columns: `ts` (Int64 ns) + OHLCV+microstructure (`open, high, low, close, volume, mean, std, maker_ratio, no_of_trades, *_liquidity, …`); Limen adds `datetime`.
- Container access = external volume `arrow` mounted `/opt/arrow` **read-only** (Furnace's exact pattern).

**Sweep logs (Furnace results)**
- Path: `/data/experiments/experiments/<experiment-id>/rounds/<NNNN>/limen_output/results.csv` (confirmed on TDW). `<experiment-id>` = slug (long names, e.g. `btc_dollar120m_legcap`, `btc_15m_rulefactory`); `<NNNN>` = zero-padded round.
- Leaf is **CSV** (one row per permutation; metric columns like `edge_per_signal_bps_p50`, `backtest_trade_pnl_net_bps_p50`, `num_trades_train`). Loaded with polars `read_csv`, **not** Limen.
- Crucible already binds `/data/experiments`, so the tree is readable from the existing mount.

## 4. Decisions (locked with operator)

1. **Time controls gating:** date-range + timeline are shown **only when the active dataset has a column named `datetime` or `timestamp`**; hidden otherwise. (Klines qualify; sweep/upload usually don't.)
2. **Upload accepts CSV and Parquet** (not Arrow). Klines remain Arrow-via-Limen.
3. **Klines load via Limen `get_arrow_file`.** Sweep/upload load via polars CSV/Parquet.
4. **Local data:** copy real files from `root@37.27.112.167` so the app provably works locally.
5. **Delivery:** one PR; this PRD carries the slice breakdown.
6. **Klines picker:** two selects — bar type (`time`/`dollar`) + interval — populated from the series present.
7. **Series list:** include **every** `<series>/latest.arrow` found under the arrow root — including `time_1m` and `dollar_1M` — not limited to Mill's catalog.
8. **Uploads persist until explicitly cleared** (a clear action deletes them); no automatic/session cleanup.
9. **Column plottability:** numeric columns plot as-is; **non-numeric columns are treated as categorical and are also plottable** (discrete encoding on any channel). `datetime`/`timestamp` columns are excluded from the X/Y/Color/Size channels — they drive the time controls only.

## 5. Design

### 5.1 UI (`src/crucible/assets/*`)
- New header `.icon-button` **before** the calendar → opens `#dataset-modal` (Mill mechanics 1:1: `.open` toggle, backdrop/Escape/`×` close, trigger `.active`→accent).
- Modal body = **card grid** (`Upload`, `Sweep logs`, `Klines`; extensible). Selecting a card reveals its picker:
  - **Klines:** bar-type select (`time` / `dollar`) + interval select, both populated from the series actually present under the arrow root (`/api/klines`). Date-range applies (Limen date limits).
  - **Sweep logs:** a **tree** — experiment (collapsible, `.active-chip` idiom) → round → `results.csv`. Designed for many long names (search/filter, truncation with full name on hover).
  - **Upload:** file input accepting `.csv` / `.parquet`.
- On selection the dataset becomes active: X/Y/Color/Size selects populate from the dataset's **numeric columns**; date-range + timeline appear iff `datetime`/`timestamp` present.
- **Removed:** `Groupby`, `Groupby Func`, and the groupby `Grid` option. `Fraction` stays. The old `Bar` control is replaced by the klines bar-type/interval picker (inside the card).

### 5.2 Backend (`src/crucible/*.py`)
- A small **dataset abstraction**: each source resolves to a normalized in-memory table (numeric columns + optional `datetime`). Three loaders:
  - `klines`: `HistoricalData().get_arrow_file('<arrow_root>/<series>/latest.arrow', start/end)`.
  - `sweep`: `polars.read_csv(<results.csv>)`.
  - `upload`: `polars.read_csv|read_parquet(<uploaded file>)`.
- Endpoints (replacing the trades/panel/groupby handlers):
  - `GET /api/klines` — series available under the arrow root (scan `<root>/*/latest.arrow`).
  - `GET /api/sweeps` — the experiment→round→results tree under the sweep root.
  - `POST /api/upload` — accept CSV/Parquet, persist to an uploads dir, return a dataset handle.
  - `GET /api/meta?dataset=…` — columns (typed) + datetime bounds (if present).
  - `GET /api/scatter?dataset=…&x=…&y=…&color=…&size=…&…` — points for the selected dataset/columns.
- Delete: `daily_paths`, `load_table`, `panel_path`, `load_panel`, `bar_table`, `aggregate`, rubric/groupby grids, `PANEL_FIELDS`, `PANEL_BLOCK_MS`, the `ORIGO_*` env.

### 5.3 Config / deploy
- Env: `CRUCIBLE_ARROW_DIR` (default `/opt/arrow`), `CRUCIBLE_SWEEP_ROOT` (default `/data/experiments/experiments`), `CRUCIBLE_UPLOAD_DIR` (default under the data root).
- `deploy/docker-compose.yml`: add external volume `arrow` → `/opt/arrow` **ro** (mirror Furnace); keep the `/data/experiments` bind. Declare the external volume.
- Update `pr_checks_deploy_contract.yml` + `tests/package/test_delivery_contract.py` to expect the arrow volume (mirror Furnace's contract).
- Deps (`pyproject.toml`): add `vaquum_limen @ git+https://github.com/Vaquum/Limen.git@main` and `polars`. Limen ships **no `py.typed`**, and Crucible's pyright is strict (`reportMissingTypeStubs = error`) — add a local `stubs/limen/` stub for `HistoricalData.get_arrow_file` (no `# type: ignore`; preserves law 3).
- **Dependency weight (recorded, not silent):** `vaquum_limen` 3.16 pulls a heavy stack — `pandas, scikit-learn, xgboost, lightgbm, statsmodels, tslearn, scipy`, and **`ta-lib`** (a system C library, satisfied by manylinux wheels on Linux). `from limen import HistoricalData` executes Limen's full package `__init__` (Cohort, Trainer, backtest, …), so the entire stack loads at startup — there is no lighter import path to `get_arrow_file`. This is the cost of "use Limen like the other apps." Mill absorbs it with a minimal Dockerfile (`apt-get install git` + `pip install .`); Crucible mirrors that. Image size and cold-start grow accordingly.

### 5.4 Local dev story
- `/opt` isn't writable without sudo. Local runs set `CRUCIBLE_ARROW_DIR` to a writable path (e.g. `~/dev/Crucible/.localdata/arrow`); the container still uses `/opt/arrow` via the volume. (Or operator creates `/opt/arrow` once with sudo.)
- Copy real data from `root@37.27.112.167`:
  - Klines (subset): `/var/lib/docker/volumes/tdw-control-plane_arrow/_data/{time_15m,time_1h,dollar_15M,dollar_120M}/latest.arrow` → `<CRUCIBLE_ARROW_DIR>/<series>/latest.arrow`.
  - Sweep sample: `/data/experiments/experiments/btc_15m_rulefactory/` (rounds + `limen_output/results.csv`) → `<CRUCIBLE_SWEEP_ROOT>/btc_15m_rulefactory/`.

## 6. Slices (stages of the single PR)

- **S0 — Local data** — copy the klines + sweep sample from TDW; confirm Limen reads `latest.arrow`.
- **S1 — Deps + Limen stub + klines loader** — `pyproject`, `stubs/limen/`, a `klines` module (list series, load via `get_arrow_file`).
- **S2 — Generic dataset backend** — dataset abstraction + generic `/api/meta` + `/api/scatter`; delete trades/panel/groupby/rubric.
- **S3 — Dataset modal + cards + klines bar UI** — header icon, modal, card grid, klines picker; remove GROUPBY/FUNC controls.
- **S4 — Sweep-logs source** — `/api/sweeps` + tree UI + CSV load.
- **S5 — Upload source** — `/api/upload` (CSV/Parquet) + upload card.
- **S6 — Deploy volume + contract** — compose arrow volume + contract test/workflow update.

## 7. Acceptance criteria
- Each source selects a real dataset and renders a scatter from its numeric columns.
- `datetime`/`timestamp` gating drives the date-range + timeline visibility.
- No hardcoded trades/panel; GROUPBY + GROUPBY FUNC gone.
- Klines read through Limen `get_arrow_file`; sweep/upload through polars.
- Verified locally against the copied TDW data.

## 8. Ten-laws checklist for the PR
- One slice issue; PR title byte-equals it; CC type `feat` → **minor bump 0.1.0 → 0.2.0** + CHANGELOG.
- `## Surfaces`: `src/crucible/**`, `stubs/**`, `deploy/**`, `.github/workflows/pr_checks_deploy_contract.yml`, `docs/**`, `tests/**`, `pyproject.toml`, `CHANGELOG.md`.
- No new `Any`/ignores (Limen stub keeps pyright clean); no new silent-fallbacks; ruff clean; `pytest tests/package` green; deploy-contract green.

## 9. Resolved (was: open questions)
All four resolved with the operator and folded into §4 decisions 6–9:
1. Klines UI → two selects (bar type + interval).
2. Sweep `results.csv` → every numeric column plottable as-is; non-numeric → categorical (also plottable), datetime excluded.
3. Uploads → keep until explicitly cleared.
4. Series list → include every `latest.arrow` found, `time_1m` / `dollar_1M` included.
