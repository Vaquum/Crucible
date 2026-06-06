"""Generic scatter computation over a selected dataset.

Numeric columns plot directly; non-numeric columns are factorized to integer
category codes (with their labels carried in the payload) so they are plottable
on any channel. Values are finite-filtered across the four channels and
decimated to a render cap, matching the existing client payload shape.
"""

from __future__ import annotations

import json
import time
from functools import lru_cache

import numpy as np
import numpy.typing as npt
import polars as pl

from crucible.datasets import DatasetRef, windowed_frame

MAX_SCATTER_POINTS = 60_000
CHANNELS = ('x', 'y', 'color', 'size')

FloatArray = npt.NDArray[np.float64]


def _column_array(frame: pl.DataFrame, column: str) -> tuple[FloatArray, list[str] | None]:
    series = frame.get_column(column)
    if series.dtype.is_numeric():
        return series.cast(pl.Float64).to_numpy(), None
    categorical = series.cast(pl.Categorical)
    labels = [str(value) for value in categorical.cat.get_categories().to_list()]
    codes = categorical.to_physical().cast(pl.Float64).to_numpy()
    return codes, labels


def _decimation(size: int) -> npt.NDArray[np.int64]:
    if size <= MAX_SCATTER_POINTS:
        return np.arange(size, dtype=np.int64)
    return np.linspace(0, size - 1, MAX_SCATTER_POINTS, dtype=np.int64)


@lru_cache(maxsize=64)
def compute_scatter(
    ref: DatasetRef,
    x: str,
    y: str,
    color: str,
    size: str,
    fraction: float,
    start: str,
    end: str,
) -> str:
    if not 0 < fraction <= 1:
        raise ValueError('fraction must be in (0, 1]')
    started = time.perf_counter()
    frame = windowed_frame(ref, start, end)
    if fraction < 1 and frame.height:
        frame = frame.sample(fraction=fraction, seed=0)
    rows = frame.height
    arrays: dict[str, FloatArray] = {}
    categories: dict[str, list[str]] = {}
    for channel, column in zip(CHANNELS, (x, y, color, size)):
        values, labels = _column_array(frame, column)
        arrays[channel] = values
        if labels is not None:
            categories[channel] = labels
    mask: npt.NDArray[np.bool_] = np.ones(rows, dtype=np.bool_)
    for values in arrays.values():
        mask &= np.isfinite(values)
    points = int(mask.sum())
    if points == 0:
        raise ValueError('No finite rows match the current selection')
    indices = _decimation(points)
    payload: dict[str, object] = {
        'rows': rows,
        'points': points,
        'shown': int(indices.size),
        'max_points': MAX_SCATTER_POINTS,
        'elapsed_ms': round((time.perf_counter() - started) * 1000, 1),
    }
    for channel, values in arrays.items():
        finite = values[mask]
        payload[channel] = finite[indices].astype(float).tolist()
        payload[f'{channel}_min'] = float(finite.min())
        payload[f'{channel}_max'] = float(finite.max())
        if channel in categories:
            payload[f'{channel}_categories'] = categories[channel]
    return json.dumps(payload, separators=(',', ':'))
