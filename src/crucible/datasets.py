"""Dataset sources: klines (Limen Arrow), sweep results (Furnace CSV), uploads.

One selected dataset at a time becomes a Polars frame for the scatter layer.
Klines load through Limen's `get_arrow_file` (same call as the sister apps);
sweep results and uploads load through Polars CSV/Parquet readers.
"""

from __future__ import annotations

import os
import re
import shutil
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
from pathlib import Path

import polars as pl
from limen import HistoricalData

DATA_ROOT = Path(os.environ.get('CRUCIBLE_DATA_ROOT', '/data/experiments/crucible'))
ARROW_DIR = Path(os.environ.get('CRUCIBLE_ARROW_DIR', '/opt/arrow'))
SWEEP_ROOT = Path(os.environ.get('CRUCIBLE_SWEEP_ROOT', '/data/experiments/experiments'))
UPLOAD_DIR = Path(os.environ.get('CRUCIBLE_UPLOAD_DIR', str(DATA_ROOT / 'uploads')))

ARROW_LATEST_NAME = 'latest.arrow'
RESULTS_NAME = 'results.csv'
UPLOAD_SUFFIXES = ('.csv', '.parquet')

TIME_COLUMN_NAMES = ('datetime', 'timestamp')
_EXCLUDED_CHANNEL_NAMES = frozenset({'datetime', 'timestamp', 'ts'})
_SAFE_NAME = re.compile(r'^[A-Za-z0-9._-]+$')
_UNIT_SECONDS = {'s': 1, 'm': 60, 'h': 3600, 'd': 86400}


@dataclass(frozen=True)
class DatasetRef:
    source: str
    series: str = ''
    experiment: str = ''
    round_id: str = ''
    upload_id: str = ''


def _safe(value: str, field: str) -> str:
    if not _SAFE_NAME.fullmatch(value):
        raise ValueError(f'unsafe {field}: {value!r}')
    return value


def parse_ref(params: dict[str, list[str]]) -> DatasetRef:
    source = (params.get('source') or [''])[0]
    if source == 'klines':
        return DatasetRef(source, series=_safe((params.get('series') or [''])[0], 'series'))
    if source == 'sweep':
        return DatasetRef(
            source,
            experiment=_safe((params.get('experiment') or [''])[0], 'experiment'),
            round_id=_safe((params.get('round') or [''])[0], 'round'),
        )
    if source == 'upload':
        return DatasetRef(source, upload_id=_safe((params.get('upload') or [''])[0], 'upload'))
    raise ValueError(f'unknown dataset source: {source!r}')


def _klines_path(series: str) -> Path:
    path = ARROW_DIR / _safe(series, 'series') / ARROW_LATEST_NAME
    if not path.is_file():
        raise FileNotFoundError(str(path))
    return path


def _sweep_path(experiment: str, round_id: str) -> Path:
    path = SWEEP_ROOT / _safe(experiment, 'experiment') / 'rounds' / _safe(round_id, 'round') / 'limen_output' / RESULTS_NAME
    if not path.is_file():
        raise FileNotFoundError(str(path))
    return path


def _upload_path(upload_id: str) -> Path:
    path = UPLOAD_DIR / _safe(upload_id, 'upload')
    if not path.is_file():
        raise FileNotFoundError(str(path))
    return path


@lru_cache(maxsize=8)
def base_frame(ref: DatasetRef) -> pl.DataFrame:
    if ref.source == 'klines':
        return HistoricalData().get_arrow_file(file_path=str(_klines_path(ref.series)))
    if ref.source == 'sweep':
        return pl.read_csv(_sweep_path(ref.experiment, ref.round_id), infer_schema_length=200)
    if ref.source == 'upload':
        path = _upload_path(ref.upload_id)
        if path.suffix == '.parquet':
            return pl.read_parquet(path)
        return pl.read_csv(path, infer_schema_length=200)
    raise ValueError(f'unknown dataset source: {ref.source!r}')


def time_column(frame: pl.DataFrame) -> str | None:
    for name in frame.columns:
        if name.lower() in TIME_COLUMN_NAMES:
            return name
    return None


def windowed_frame(ref: DatasetRef, start: str, end: str) -> pl.DataFrame:
    frame = base_frame(ref)
    column = time_column(frame)
    if column is None or not (start or end):
        return frame
    dtype = frame.schema[column]
    wall_clock = pl.col(column)
    if isinstance(dtype, pl.Datetime) and dtype.time_zone is not None:
        wall_clock = wall_clock.dt.convert_time_zone('UTC').dt.replace_time_zone(None)
    wall_clock = wall_clock.cast(pl.Datetime('us'))
    if start:
        frame = frame.filter(wall_clock >= pl.lit(datetime.fromisoformat(start)).cast(pl.Datetime('us')))
    if end:
        frame = frame.filter(wall_clock < pl.lit(datetime.fromisoformat(end)).cast(pl.Datetime('us')))
    return frame


def channel_columns(frame: pl.DataFrame) -> list[dict[str, str]]:
    columns: list[dict[str, str]] = []
    for name, dtype in frame.schema.items():
        if name.lower() in _EXCLUDED_CHANNEL_NAMES or dtype.is_temporal():
            continue
        columns.append({'name': name, 'kind': 'numeric' if dtype.is_numeric() else 'categorical'})
    return columns


def _iso(value: object) -> str:
    if not isinstance(value, datetime):
        raise ValueError(f'time column bound is not a datetime: {value!r}')
    return value.replace(tzinfo=None, microsecond=0).strftime('%Y-%m-%dT%H:%M:%S')


def dataset_meta(ref: DatasetRef) -> dict[str, object]:
    frame = base_frame(ref)
    column = time_column(frame)
    meta: dict[str, object] = {
        'columns': channel_columns(frame),
        'rows': frame.height,
        'time_column': column,
    }
    if column is not None and frame.height:
        meta['start'] = _iso(frame[column].min())
        meta['end'] = _iso(frame[column].max())
    return meta


def _klines_sort_key(series: str) -> tuple[int, int]:
    bar_type, _, interval = series.partition('_')
    match = re.fullmatch(r'(\d+)([A-Za-z]+)', interval)
    if match is None:
        return (2, 0)
    magnitude = int(match.group(1))
    if bar_type == 'time':
        return (0, magnitude * _UNIT_SECONDS.get(match.group(2).lower(), 1))
    return (1, magnitude)


def list_klines() -> list[dict[str, str]]:
    if not ARROW_DIR.is_dir():
        return []
    series = [
        entry.name
        for entry in ARROW_DIR.iterdir()
        if entry.is_dir() and (entry / ARROW_LATEST_NAME).is_file()
    ]
    out: list[dict[str, str]] = []
    for name in sorted(series, key=_klines_sort_key):
        bar_type, _, interval = name.partition('_')
        out.append({'series': name, 'bar_type': bar_type, 'interval': interval})
    return out


def list_sweeps() -> list[dict[str, object]]:
    if not SWEEP_ROOT.is_dir():
        return []
    experiments: list[dict[str, object]] = []
    for exp_dir in sorted(SWEEP_ROOT.iterdir()):
        rounds_dir = exp_dir / 'rounds'
        if not rounds_dir.is_dir():
            continue
        rounds = [
            round_dir.name
            for round_dir in sorted(rounds_dir.iterdir())
            if (round_dir / 'limen_output' / RESULTS_NAME).is_file()
        ]
        if rounds:
            experiments.append({'experiment': exp_dir.name, 'rounds': rounds})
    return experiments


def list_uploads() -> list[str]:
    if not UPLOAD_DIR.is_dir():
        return []
    return sorted(entry.name for entry in UPLOAD_DIR.iterdir() if entry.is_file())


def save_upload(filename: str, data: bytes) -> str:
    name = _safe(filename, 'upload')
    if not name.endswith(UPLOAD_SUFFIXES):
        raise ValueError(f'upload must be one of {UPLOAD_SUFFIXES}: {filename!r}')
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    (UPLOAD_DIR / name).write_bytes(data)
    base_frame.cache_clear()
    return name


def clear_uploads() -> None:
    if UPLOAD_DIR.is_dir():
        shutil.rmtree(UPLOAD_DIR)
    base_frame.cache_clear()
