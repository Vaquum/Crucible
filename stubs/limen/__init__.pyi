"""Minimal type stub for the parts of Limen that Crucible uses.

Limen (`vaquum_limen`) ships no `py.typed`; Crucible's pyright runs strict with
`reportMissingTypeStubs = error`, so this stub declares the single surface we
call — `HistoricalData.get_arrow_file` — to keep typing clean without any
`# type: ignore`. Keep this in sync with `limen/data/historical_data.py`.
"""

from __future__ import annotations

import polars as pl

class HistoricalData:
    def __init__(self) -> None: ...
    def get_arrow_file(
        self,
        file_path: str,
        row_count_limit: int | None = ...,
        start_date_limit: str | None = ...,
        end_date_limit: str | None = ...,
        *,
        n_rows: int | None = ...,
    ) -> pl.DataFrame: ...
