# v0.3.1

- Make uploads safe under concurrent users: `save_upload` publishes atomically (temp file + `os.replace`) so a concurrent reader never sees a torn file, and upload dataset refs carry a generation that joins the frame/scatter cache keys, so an in-flight read can no longer re-populate a cleared cache with stale data (no `cache_clear()` remains).
- Remove the destructive `POST /api/clear-uploads` endpoint and the "Clear all" button: with a shared upload bucket, any user could irreversibly delete every other user's uploads. Upload cleanup is now an operator action on `CRUCIBLE_UPLOAD_DIR`.

# v0.3.0

- Add a `/version` endpoint returning the build provenance (`sha`, `date`, `subject`) baked into the image at build time, so Smithy can render the actually-running version on its landing tile instead of a hand-set value.

# v0.2.0

- Dataset source selection: choose klines (read via Limen `get_arrow_file`), Furnace sweep results (`results.csv`), or an uploaded CSV/Parquet from a Mill-style modal. Removes the hardcoded Origo trades/panel data, the GROUPBY and GROUPBY FUNC controls, and the panel export scripts. Non-numeric columns plot as categorical; date/timeline controls show only for datasets with a `datetime`/`timestamp` column.
- Completes the CI gate scaffold: adds the `tests/tools/` contract suite and `tests/honesty/` (ported from the sister apps and adapted to Crucible) so the `pr_checks_ruleset` and `pr_checks_honesty` gates run.

# v0.1.0

- Initial Crucible package, Docker delivery, CI scaffold, and Origo rubric scatter explorer.
