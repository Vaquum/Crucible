# PRD — Concurrency-safe uploads

Status: locked with operator · Owner: operator · Delivery: **one PR** closing slice CU-1 (issue [#5](https://github.com/Vaquum/Crucible/issues/5)).

## 1. Goal

Two people share one Crucible (one credential pair, one process). Make the upload source safe under concurrent use: no user can destroy another user's uploads, no reader ever sees a torn file, and no cache can stick to stale data after a re-upload. Read-only browsing (klines, sweeps, scatter over them) is already safe and is untouched.

## 2. Current state (the three findings)

1. **Destructive shared clear.** `POST /api/clear-uploads` (`src/crucible/serve.py:166`) calls `datasets.clear_uploads()` → `shutil.rmtree(UPLOAD_DIR)` (`src/crucible/datasets.py:230`). Any authenticated user irreversibly deletes every user's uploads; the "Clear all" button (`src/crucible/assets/app.js:165`) puts that one click away.
2. **Sticky stale-cache race.** The mutation path is write file → `base_frame.cache_clear()` (`datasets.py:226`) → `compute_scatter.cache_clear()` (`serve.py:163`). `cache_clear()` does not stop an in-flight call: a `base_frame` load that began before an overwrite and finishes after the clear re-inserts the pre-overwrite frame into the freshly cleared cache, which is then served to everyone until the next mutation. Same shape for `compute_scatter`.
3. **Torn reads.** `save_upload` truncates the destination in place via `write_bytes` (`datasets.py:225`). A concurrent reader can parse a clean truncated prefix of a half-written CSV and silently see partial data.

Not findings (verified safe, unchanged): `ThreadingHTTPServer` request isolation, immutable cached Polars frames, `lru_cache` internal thread safety, auth globals written once before `serve_forever()`.

## 3. Decisions (locked with operator, 2026-06-12)

1. **Drop the destructive clear entirely** — endpoint, `clear_uploads()` function, app-config key, and the "Clear all" button. The shared bucket stays; no per-user namespacing. Upload cleanup becomes an operator filesystem action on `CRUCIBLE_UPLOAD_DIR`. (Supersedes decision 8 of `docs/prd-dataset-sources.md` — uploads now persist until the operator removes them server-side.)
2. **Same-name re-upload stays allowed**: last write wins, atomically.
3. **Cache invalidation moves from `cache_clear()` to a generation key.** All `cache_clear()` calls in `src/crucible/` are deleted.
4. **Non-goals**: cache-stampede dedup, memory caps on concurrent uploads, per-user auth, and staleness from external rewrites of klines `latest.arrow` (a pipeline concern; behavior unchanged by this slice).

## 4. Design

### 4.1 Remove the clear path

`serve.py`: drop the `/api/clear-uploads` route and the `clear_uploads` key from `app_config()['endpoints']`. `datasets.py`: delete `clear_uploads()` (and the then-unused `shutil` import). `app.js`: drop the "Clear all" action and `clearUploads()`.

### 4.2 Atomic publish

`save_upload` writes to a `tempfile.NamedTemporaryFile(dir=UPLOAD_DIR, delete=False)` and publishes with `os.replace(tmp.name, UPLOAD_DIR / name)`. Readers holding the old file keep reading the old bytes (POSIX unlink semantics); new opens see whole new bytes — never a prefix. Temp names carry no `.csv`/`.parquet` suffix, so `list_uploads` never surfaces them.

### 4.3 Generation-keyed caches

A module-level upload generation in `datasets.py`: `upload_generation() -> int` reads it; `save_upload` increments it under a `threading.Lock` **after** the `os.replace` (the lock makes the value strictly increasing under concurrent saves; a lock-free `+= 1` can lose an increment and let a stale entry answer the current generation).

The generation rides inside the cache key that already exists: `DatasetRef` gains a `generation: int = 0` field, and `parse_ref` stamps upload refs with `upload_generation()`. Since `base_frame` and `compute_scatter` are keyed by the ref, the generation joins both `lru_cache` keys without changing any function signature (`compute_scatter` already has ruff's `PLR0913` maximum of 8 parameters — a ninth would fail the lint gate). Klines/sweep refs keep generation 0, so their cache entries are untouched by uploads.

Why this kills race 2: an in-flight load that began before a bump completes and inserts under the *old-generation* ref. No future `parse_ref` produces that ref again, so the entry ages out of the LRU. Stale results become unreachable instead of resurrectable — there is no clear-then-repopulate window because nothing is ever cleared.

### 4.4 Considered and rejected

- **Per-user upload prefixes** — real multi-tenancy, but Crucible has one shared credential pair; out of scope.
- **mtime-keyed caches** — also covers external rewrites, but adds a `stat` per request and asymmetric semantics across sources; the generation covers every mutation Crucible itself performs.
- **Keep clear-uploads behind a confirmation dialog** — still lets one user destroy another's data.

## 5. Slice

Single slice **CU-1** (issue [#5](https://github.com/Vaquum/Crucible/issues/5)); the capability ("uploads survive two concurrent users") is only delivered whole — atomic writes without generation keys still serve sticky-stale data, generation keys without atomic writes still serve torn reads, and the clear endpoint removal is part of the same contract. PR title byte-equals the issue title: `fix: atomic upload writes, generation-keyed caches, remove clear-uploads`.

## 6. Acceptance criteria

- `POST /api/clear-uploads` → 404; no clear affordance in the UI; `app_config()['endpoints']` has no `clear_uploads` key.
- Re-uploading over an in-use name: concurrent scatter/meta requests return either the old or the new dataset in full — never a torn file, never a stuck-stale frame once the save returns.
- No `cache_clear()` remains under `src/crucible/`.
- `pytest tests/package -q` green, including new tests proving route removal, atomic publish, and generation freshness.

## 7. Ten-laws checklist for the PR

- One slice issue (CU-1); CC type `fix` → **patch bump 0.3.0 → 0.3.1** + `CHANGELOG.md` `# v0.3.1`.
- Surfaces: `src/crucible/serve.py`, `src/crucible/datasets.py`, `src/crucible/assets/app.js`, `tests/package/test_delivery_contract.py`, `tests/package/test_concurrent_uploads.py` (new), `docs/prd-concurrent-uploads.md` (new), `pyproject.toml`, `CHANGELOG.md`. (`scatter.py` ended up untouched: the generation rides in `DatasetRef`, so `compute_scatter`'s key changed without its code changing.)
- No new `Any`/ignores; no new silent fallbacks (the temp-file write is a plain `with` + `os.replace`, no exception handler); ruff clean; `pytest tests/package` green.
