# v0.2.0

- Dataset source selection: choose klines (read via Limen `get_arrow_file`), Furnace sweep results (`results.csv`), or an uploaded CSV/Parquet from a Mill-style modal. Removes the hardcoded Origo trades/panel data, the GROUPBY and GROUPBY FUNC controls, and the panel export scripts. Non-numeric columns plot as categorical; date/timeline controls show only for datasets with a `datetime`/`timestamp` column.

# v0.1.0

- Initial Crucible package, Docker delivery, CI scaffold, and Origo rubric scatter explorer.
