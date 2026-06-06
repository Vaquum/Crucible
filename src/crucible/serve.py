from __future__ import annotations

import base64
import binascii
import json
import logging
import math
import os
import secrets
import time
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.dataset as ds
import pyarrow.ipc as ipc

APP_NAME = "Crucible"
APP_DIR = Path(__file__).resolve().parent
ASSET_DIR = APP_DIR / "assets"
DATA_ROOT = Path(os.environ.get("CRUCIBLE_DATA_ROOT", "/data/experiments/crucible"))
ARROW_DIR = Path(os.environ.get("ORIGO_ARROW_DIR", str(DATA_ROOT / "binance_daily_spot_trades")))
PANEL_DIR = Path(os.environ.get("ORIGO_PANEL_DIR", str(DATA_ROOT / "btc_master_panel")))
API_UPSTREAM = os.environ.get("CRUCIBLE_API_UPSTREAM", "").rstrip("/")
UPSTREAM_API_SECRET = os.environ.get("CRUCIBLE_UPSTREAM_API_SECRET", "")
ALLOW_ANONYMOUS = os.environ.get("CRUCIBLE_ALLOW_ANONYMOUS", "") == "1"
VALUE_COLUMNS = ("price", "quantity", "quote_quantity")
PANEL_FIELDS = (
    "mid",
    "ret_pct",
    "range_bps",
    "trades",
    "turnover",
    "clip_pct",
    "med_declip",
    "buy_pct",
    "ofi",
    "spread_p999",
    "reach20_bps",
    "depth20_k",
    "abs_imb",
    "flow_mo5s",
    "book_mo5s",
    "div_pct",
)
PANEL_BLOCK_MS = tuple(125 * (2**power) for power in range(18))
AGGREGATES = {
    "count": "count",
    "max": "max",
    "mean": "mean",
    "min": "min",
    "std": "stddev",
    "stddev": "stddev",
    "sum": "sum",
    "variance": "variance",
}
TIMESTAMP_TYPE = pa.timestamp("us", tz="UTC")
MAX_SCATTER_POINTS = 60_000
MAX_GROUPBY_GRID_POINTS = 15_000
_app_username = ""
_app_password = ""
_api_secret = ""


def _require_auth_env() -> None:
    global _app_username, _app_password, _api_secret
    _app_username = os.environ.get("APP_USERNAME", "")
    _app_password = os.environ.get("APP_PASSWORD", "")
    _api_secret = os.environ.get("API_SECRET", "")
    if not (_app_username and _app_password and _api_secret):
        raise RuntimeError(
            "Crucible requires APP_USERNAME, APP_PASSWORD, and API_SECRET environment variables"
        )


def host() -> str:
    return os.environ.get("CRUCIBLE_HOST", "127.0.0.1")


def port() -> int:
    return int(os.environ.get("CRUCIBLE_PORT", os.environ.get("ORIGO_HISTOGRAM_PORT", "8877")))


def parse_datetime(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def daily_paths(start: datetime, end: datetime) -> list[Path]:
    if start >= end:
        raise ValueError("start_datetime must be before end_datetime")
    last_day = (end - timedelta(microseconds=1)).date()
    day = start.date()
    paths: list[Path] = []
    while day <= last_day:
        path = ARROW_DIR / f"trades_{day.isoformat()}.arrow"
        if not path.exists():
            raise FileNotFoundError(str(path))
        paths.append(path)
        day += timedelta(days=1)
    return paths


def normalize_aggregate(name: str) -> str:
    key = name.lower()
    if key not in AGGREGATES:
        raise ValueError(f"Unsupported aggregate: {name}")
    return AGGREGATES[key]


def load_table(start: datetime, end: datetime, columns: tuple[str, ...]) -> pa.Table:
    dataset = ds.dataset([str(path) for path in daily_paths(start, end)], format="ipc")
    return dataset.to_table(
        columns=list(dict.fromkeys(("datetime", *columns))),
        filter=(
            (ds.field("datetime") >= pa.scalar(start, TIMESTAMP_TYPE))
            & (ds.field("datetime") < pa.scalar(end, TIMESTAMP_TYPE))
        ),
    )


def downsample(table: pa.Table, fraction: float, seed: int) -> pa.Table:
    if not 0 < fraction <= 1:
        raise ValueError("fraction must be in (0, 1]")
    if fraction == 1:
        return table
    mask = pc.less(pc.random(table.num_rows, initializer=seed), pa.scalar(fraction, pa.float64()))
    return table.filter(mask)


def panel_path(block_ms: int) -> Path:
    path = PANEL_DIR / f"btc_master_panel_{block_ms}ms.arrow"
    if not path.exists():
        raise FileNotFoundError(str(path))
    return path


def normalize_block_ms(value: float) -> int:
    block_ms = round(value * 1000)
    if not math.isclose(block_ms / 1000, value):
        raise ValueError("groupby must resolve to whole milliseconds")
    if block_ms not in PANEL_BLOCK_MS:
        allowed = ", ".join(format_block(ms) for ms in PANEL_BLOCK_MS)
        raise ValueError(f"Unsupported groupby. Available: {allowed}")
    return block_ms


def load_panel(start: datetime, end: datetime, block_ms: int, columns: tuple[str, ...]) -> pa.Table:
    for column in columns:
        if column not in PANEL_FIELDS:
            raise ValueError(f"Unsupported panel field: {column}")
    dataset = ds.dataset(str(panel_path(block_ms)), format="ipc")
    table = dataset.to_table(
        columns=list(dict.fromkeys(("datetime", *columns))),
        filter=ds.field("datetime") < pa.scalar(end, TIMESTAMP_TYPE),
    )
    block_end = pc.add(table["datetime"], pa.scalar(timedelta(milliseconds=block_ms), pa.duration("us")))
    mask = pc.greater(block_end, pa.scalar(start, TIMESTAMP_TYPE))
    return table.filter(mask)


def format_block(block_ms: int) -> str:
    if block_ms < 1000:
        return f"{block_ms}ms"
    seconds = block_ms / 1000
    if seconds.is_integer():
        return f"{int(seconds)}s"
    return f"{seconds:g}s"


def signed_quote_quantity(table: pa.Table) -> pa.ChunkedArray:
    buy_taker = pc.equal(table["is_buyer_maker"], pa.scalar(0, pa.uint8()))
    side = pc.if_else(buy_taker, pa.scalar(1.0), pa.scalar(-1.0))
    return pc.multiply(table["quote_quantity"], side)


def raw_imbalance(table: pa.Table) -> np.ndarray:
    buy_taker = pc.equal(table["is_buyer_maker"], pa.scalar(0, pa.uint8()))
    side = pc.if_else(buy_taker, pa.scalar(1.0), pa.scalar(-1.0))
    return values_to_numpy(side)


def aggregate(table: pa.Table, bar: pa.Array | pa.ChunkedArray, function: str) -> pa.Table:
    aggregate_function = normalize_aggregate(function)
    with_signed = table.append_column("signed_quote_quantity", signed_quote_quantity(table))
    with_bar = with_signed.append_column("bar", bar)
    aggregations = [
        ("trade_id", "count"),
        ("datetime", "min"),
        ("datetime", "max"),
        ("quote_quantity", "sum"),
        ("signed_quote_quantity", "sum"),
    ]
    aggregations.extend(
        (column, aggregate_function)
        for column in VALUE_COLUMNS
        if column != "quote_quantity" or aggregate_function != "sum"
    )
    grouped = with_bar.group_by("bar").aggregate(aggregations)
    imbalance = pc.divide(grouped["signed_quote_quantity_sum"], grouped["quote_quantity_sum"])
    grouped = grouped.append_column("imbalance", imbalance)
    order = pc.sort_indices(grouped, sort_keys=[("bar", "ascending")])
    return grouped.take(order)


def bar_table(start: datetime, end: datetime, bar_type: str, bar_interval: float, function: str, fraction: float) -> pa.Table:
    table = load_table(start, end, ("trade_id", "price", "quantity", "quote_quantity", "is_buyer_maker"))
    table = downsample(table, fraction, 0)
    if bar_type == "time":
        seconds = int(bar_interval)
        if seconds != bar_interval or seconds <= 0:
            raise ValueError("time bar_interval must be whole seconds")
        bar = pc.floor_temporal(table["datetime"], multiple=seconds, unit="second")
        return aggregate(table, bar, function)
    if bar_type == "dollar":
        if bar_interval <= 0:
            raise ValueError("dollar bar_interval must be positive")
        quote = table["quote_quantity"]
        cumulative = pc.cumulative_sum(quote)
        before = pc.subtract(cumulative, quote)
        bar = pc.cast(pc.floor(pc.divide(before, float(bar_interval) * 10_000.0)), pa.int64())
        return aggregate(table, bar, function)
    raise ValueError(f"Unsupported bar_type: {bar_type}")


def values_to_numpy(values: pa.Array | pa.ChunkedArray) -> np.ndarray:
    array = values.combine_chunks() if isinstance(values, pa.ChunkedArray) else values
    data = array.to_numpy(zero_copy_only=False)
    return data[np.isfinite(data)]


def array_to_numpy(values: pa.Array | pa.ChunkedArray) -> np.ndarray:
    array = values.combine_chunks() if isinstance(values, pa.ChunkedArray) else values
    if pa.types.is_floating(array.type):
        array = pc.fill_null(array, pa.scalar(float("nan"), array.type))
    return array.to_numpy(zero_copy_only=False)


def histogram(values: np.ndarray, n_bins: int) -> dict[str, object]:
    if not 1 <= n_bins <= 1000:
        raise ValueError("n_bins must be between 1 and 1000")
    if values.size == 0:
        raise ValueError("No rows match the current slice")
    low = float(values.min())
    high = float(values.max())
    if math.isclose(low, high):
        low -= 0.5
        high += 0.5
    counts, edges = np.histogram(values, bins=n_bins, range=(low, high))
    return {
        "edges": edges.tolist(),
        "counts": counts.astype(np.int64).tolist(),
        "min": low,
        "max": high,
        "mean": float(values.mean()),
        "std": float(values.std()),
        "points": int(values.size),
    }


@lru_cache(maxsize=4)
def value_vector(cache_key: tuple[str, str, str, float, str, str, float]) -> tuple[np.ndarray, int]:
    start_text, end_text, bar_type, bar_interval, function, field, fraction = cache_key
    start = parse_datetime(start_text)
    end = parse_datetime(end_text)
    if bar_type == "none":
        if field == "imbalance":
            table = downsample(load_table(start, end, ("is_buyer_maker",)), fraction, 0)
            return raw_imbalance(table), table.num_rows
        if field not in (*VALUE_COLUMNS, "timestamp"):
            raise ValueError(f"Unsupported raw field: {field}")
        table = downsample(load_table(start, end, (field,)), fraction, 0)
        return values_to_numpy(table[field]), table.num_rows
    grouped = bar_table(start, end, bar_type, bar_interval, function, fraction)
    if field == "imbalance":
        return values_to_numpy(grouped["imbalance"]), grouped.num_rows
    if field == "trade_count":
        return values_to_numpy(grouped["trade_id_count"]), grouped.num_rows
    if field not in VALUE_COLUMNS:
        raise ValueError(f"Unsupported bar field: {field}")
    return values_to_numpy(grouped[f"{field}_{normalize_aggregate(function)}"]), grouped.num_rows


def raw_field_values(table: pa.Table, field: str) -> np.ndarray:
    if field == "imbalance":
        return raw_imbalance(table)
    if field not in (*VALUE_COLUMNS, "timestamp"):
        raise ValueError(f"Unsupported raw field: {field}")
    return array_to_numpy(table[field])


def bar_field_values(grouped: pa.Table, field: str, function: str) -> np.ndarray:
    if field == "imbalance":
        return array_to_numpy(grouped["imbalance"])
    if field == "trade_count":
        return array_to_numpy(grouped["trade_id_count"])
    if field not in VALUE_COLUMNS:
        raise ValueError(f"Unsupported bar field: {field}")
    return array_to_numpy(grouped[f"{field}_{normalize_aggregate(function)}"])


def panel_field_values(table: pa.Table, field: str) -> np.ndarray:
    if field not in PANEL_FIELDS:
        raise ValueError(f"Unsupported panel field: {field}")
    return array_to_numpy(table[field])


def finite_vectors(vectors: tuple[np.ndarray, ...]) -> tuple[np.ndarray, ...]:
    mask = np.ones(vectors[0].shape, dtype=bool)
    for vector in vectors:
        mask &= np.isfinite(vector)
    return tuple(vector[mask] for vector in vectors)


def decimate_vectors(vectors: tuple[np.ndarray, ...]) -> tuple[np.ndarray, ...]:
    if vectors[0].size <= MAX_SCATTER_POINTS:
        return vectors
    indices = np.linspace(0, vectors[0].size - 1, MAX_SCATTER_POINTS, dtype=np.int64)
    return tuple(vector[indices] for vector in vectors)


def decimation_indices(size: int, max_points: int = MAX_SCATTER_POINTS) -> np.ndarray:
    if size <= max_points:
        return np.arange(size, dtype=np.int64)
    return np.linspace(0, size - 1, max_points, dtype=np.int64)


def nullable_float_list(values: np.ndarray) -> list[float | None]:
    return [float(value) if np.isfinite(value) else None for value in values]


def datetime_days(table: pa.Table) -> np.ndarray:
    array = table["datetime"].combine_chunks()
    return array.to_numpy(zero_copy_only=False).astype("datetime64[D]")


def scatter_payload(
    x_values: np.ndarray,
    y_values: np.ndarray,
    color_values: np.ndarray,
    size_values: np.ndarray,
    rows: int,
    started: float,
) -> dict[str, object]:
    x_values, y_values, color_values, size_values = finite_vectors((x_values, y_values, color_values, size_values))
    points = int(x_values.size)
    if points == 0:
        raise ValueError("No finite scatter rows match the current slice")
    x_plot, y_plot, color_plot, size_plot = decimate_vectors((x_values, y_values, color_values, size_values))
    return {
        "x": x_plot.astype(float).tolist(),
        "y": y_plot.astype(float).tolist(),
        "color": color_plot.astype(float).tolist(),
        "size": size_plot.astype(float).tolist(),
        "x_min": float(x_values.min()),
        "x_max": float(x_values.max()),
        "y_min": float(y_values.min()),
        "y_max": float(y_values.max()),
        "color_min": float(color_values.min()),
        "color_max": float(color_values.max()),
        "size_min": float(size_values.min()),
        "size_max": float(size_values.max()),
        "rows": int(rows),
        "points": points,
        "shown": int(x_plot.size),
        "max_points": MAX_SCATTER_POINTS,
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
    }


@lru_cache(maxsize=32)
def compute_scatter(cache_key: tuple[str, str, str, float, str, str, str, str, str, float]) -> str:
    started = time.perf_counter()
    start_text, end_text, bar_type, bar_interval, function, x_field, y_field, color_field, size_field, fraction = cache_key
    start = parse_datetime(start_text)
    end = parse_datetime(end_text)
    if bar_type == "none":
        raw_columns = tuple(
            column
            for field in (x_field, y_field, color_field, size_field)
            for column in (("is_buyer_maker",) if field == "imbalance" else (field,))
        )
        table = downsample(load_table(start, end, raw_columns), fraction, 0)
        payload = scatter_payload(
            raw_field_values(table, x_field),
            raw_field_values(table, y_field),
            raw_field_values(table, color_field),
            raw_field_values(table, size_field),
            table.num_rows,
            started,
        )
    else:
        grouped = bar_table(start, end, bar_type, bar_interval, function, fraction)
        payload = scatter_payload(
            bar_field_values(grouped, x_field, function),
            bar_field_values(grouped, y_field, function),
            bar_field_values(grouped, color_field, function),
            bar_field_values(grouped, size_field, function),
            grouped.num_rows,
            started,
        )
    return json.dumps(payload, separators=(",", ":"))


@lru_cache(maxsize=64)
def compute_panel_scatter(cache_key: tuple[str, str, int, str, str, str, str, float]) -> str:
    started = time.perf_counter()
    start_text, end_text, block_ms, x_field, y_field, color_field, size_field, fraction = cache_key
    start = parse_datetime(start_text)
    end = parse_datetime(end_text)
    table = load_panel(start, end, block_ms, (x_field, y_field, color_field, size_field))
    table = downsample(table, fraction, 0)
    payload = scatter_payload(
        panel_field_values(table, x_field),
        panel_field_values(table, y_field),
        panel_field_values(table, color_field),
        panel_field_values(table, size_field),
        table.num_rows,
        started,
    )
    payload["block_ms"] = block_ms
    payload["block_seconds"] = block_ms / 1000
    return json.dumps(payload, separators=(",", ":"))


@lru_cache(maxsize=32)
def compute_grid_fields(cache_key: tuple[str, str, int, tuple[str, ...], float]) -> str:
    started = time.perf_counter()
    start_text, end_text, block_ms, fields, fraction = cache_key
    start = parse_datetime(start_text)
    end = parse_datetime(end_text)
    table = load_panel(start, end, block_ms, fields)
    table = downsample(table, fraction, 0)
    days = datetime_days(table)
    unique_days, starts, counts = np.unique(days, return_index=True, return_counts=True)
    cells: list[dict[str, object]] = []
    for day, offset, count in zip(unique_days, starts, counts):
        indices = offset + decimation_indices(int(count))
        cell_fields: dict[str, object] = {}
        for field in fields:
            values = panel_field_values(table, field)[indices]
            cell_fields[field] = nullable_float_list(values)
        cells.append(
            {
                "label": np.datetime_as_string(day, unit="D"),
                "rows": int(count),
                "shown": int(indices.size),
                "fields": cell_fields,
            }
        )
    payload = {
        "kind": "grid_fields",
        "block_ms": block_ms,
        "block_seconds": block_ms / 1000,
        "fields": list(fields),
        "cells": cells,
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
    }
    return json.dumps(payload, separators=(",", ":"))


@lru_cache(maxsize=16)
def compute_groupby_fields(cache_key: tuple[str, str, tuple[str, ...], float]) -> str:
    started = time.perf_counter()
    start_text, end_text, fields, fraction = cache_key
    start = parse_datetime(start_text)
    end = parse_datetime(end_text)
    cells: list[dict[str, object]] = []
    for block_ms in PANEL_BLOCK_MS:
        table = load_panel(start, end, block_ms, fields)
        table = downsample(table, fraction, 0)
        if table.num_rows == 0:
            continue
        indices = decimation_indices(table.num_rows, MAX_GROUPBY_GRID_POINTS)
        cell_fields: dict[str, object] = {}
        for field in fields:
            values = panel_field_values(table, field)[indices]
            cell_fields[field] = nullable_float_list(values)
        cells.append(
            {
                "label": format_block(block_ms),
                "rows": table.num_rows,
                "shown": int(indices.size),
                "fields": cell_fields,
            }
        )
    payload = {
        "kind": "groupby_fields",
        "fields": list(fields),
        "cells": cells,
        "max_points_per_cell": MAX_GROUPBY_GRID_POINTS,
        "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
    }
    return json.dumps(payload, separators=(",", ":"))


@lru_cache(maxsize=128)
def compute_histogram(cache_key: tuple[str, str, str, float, str, str, float, int]) -> str:
    started = time.perf_counter()
    values, rows = value_vector(cache_key[:-1])
    result = histogram(values, cache_key[-1])
    result.update({"rows": int(rows), "elapsed_ms": round((time.perf_counter() - started) * 1000, 1)})
    return json.dumps(result, separators=(",", ":"))


def first_datetime(path: Path) -> datetime:
    with pa.memory_map(str(path), "r") as source:
        with ipc.open_file(source) as reader:
            batch = reader.get_batch(0)
            return batch.column(batch.schema.get_field_index("datetime"))[0].as_py()


def last_datetime(path: Path) -> datetime:
    with pa.memory_map(str(path), "r") as source:
        with ipc.open_file(source) as reader:
            batch = reader.get_batch(reader.num_record_batches - 1)
            column = batch.column(batch.schema.get_field_index("datetime"))
            return column[len(column) - 1].as_py()


def display_start(value: datetime) -> str:
    return value.replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%S")


def display_end(value: datetime) -> str:
    return (value.replace(microsecond=0) + timedelta(seconds=1)).strftime("%Y-%m-%dT%H:%M:%S")


def meta() -> dict[str, object]:
    panel_files = [panel_path(block_ms) for block_ms in PANEL_BLOCK_MS if (PANEL_DIR / f"btc_master_panel_{block_ms}ms.arrow").exists()]
    if panel_files:
        base_ms = min(PANEL_BLOCK_MS)
        base_path = panel_path(base_ms)
        return {
            "start": display_start(first_datetime(base_path)),
            "end": display_start(last_datetime(base_path) + timedelta(milliseconds=base_ms)),
            "files": [path.name for path in panel_files],
            "fields": list(PANEL_FIELDS),
            "blocks_ms": list(PANEL_BLOCK_MS),
        }
    files = sorted(ARROW_DIR.glob("trades_*.arrow"))
    if not files:
        raise FileNotFoundError(str(ARROW_DIR))
    return {
        "start": display_start(first_datetime(files[0])),
        "end": display_end(last_datetime(files[-1])),
        "files": [path.name for path in files],
    }


def upstream_meta() -> dict[str, object]:
    headers = {"Authorization": f"Bearer {UPSTREAM_API_SECRET}"} if UPSTREAM_API_SECRET else {}
    request = Request(f"{API_UPSTREAM}/api/meta", headers=headers)
    with urlopen(request, timeout=300) as response:
        return json.loads(response.read())


def app_config() -> dict[str, object]:
    payload = upstream_meta() if API_UPSTREAM else meta()
    payload.update(
        {
            "app_name": APP_NAME,
            "default_block_ms": PANEL_BLOCK_MS[0],
            "fields": list(PANEL_FIELDS),
            "blocks_ms": list(PANEL_BLOCK_MS),
            "endpoints": {
                "scatter": "/api/scatter",
                "grid_fields": "/api/grid_fields",
                "groupby_fields": "/api/groupby_fields",
                "meta": "/api/meta",
            },
        }
    )
    return payload


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path: str) -> str:
        raw_path = urlparse(path).path
        clean = raw_path.removeprefix("/assets/").lstrip("/") or "index.html"
        return str(ASSET_DIR / clean)

    def send_json(self, status: HTTPStatus, payload: str | dict[str, object]) -> None:
        body = payload if isinstance(payload, str) else json.dumps(payload, separators=(",", ":"))
        data = body.encode()
        self.send_bytes(status, "application/json", data)

    def send_bytes(self, status: int | HTTPStatus, ctype: str, data: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def proxy_upstream(self, path: str, query: str) -> None:
        url = f"{API_UPSTREAM}{path}"
        if query:
            url = f"{url}?{query}"
        headers = {"Authorization": f"Bearer {UPSTREAM_API_SECRET}"} if UPSTREAM_API_SECRET else {}
        request = Request(url, headers=headers)
        with urlopen(request, timeout=300) as response:
            ctype = response.headers.get("Content-Type", "application/json")
            self.send_bytes(response.status, ctype, response.read())

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if not self._authorized(parsed.path):
            self._unauthorized()
            return
        if parsed.path == "/health":
            self.send_json(HTTPStatus.OK, {"status": "ok"})
            return
        if API_UPSTREAM and parsed.path.startswith("/api/"):
            self.proxy_upstream(parsed.path, parsed.query)
            return
        if parsed.path == "/app-config":
            self.send_json(HTTPStatus.OK, app_config())
            return
        if parsed.path == "/api/meta":
            self.send_json(HTTPStatus.OK, meta())
            return
        if parsed.path == "/api/histogram":
            params = parse_qs(parsed.query)
            key = (
                params.get("start_datetime", [""])[0],
                params.get("end_datetime", [""])[0],
                params.get("bar_type", ["none"])[0],
                float(params.get("bar_interval", ["1"])[0]),
                params.get("bar_interval_function", ["mean"])[0],
                params.get("field", ["price"])[0],
                float(params.get("fraction", ["1"])[0]),
                int(params.get("n_bins", ["80"])[0]),
            )
            self.send_json(HTTPStatus.OK, compute_histogram(key))
            return
        if parsed.path == "/api/scatter":
            params = parse_qs(parsed.query)
            block_ms = normalize_block_ms(float(params.get("bar_interval", ["0.125"])[0]))
            key = (
                params.get("start_datetime", [""])[0],
                params.get("end_datetime", [""])[0],
                block_ms,
                params.get("x_field", ["mid"])[0],
                params.get("y_field", ["ret_pct"])[0],
                params.get("color_field", ["ofi"])[0],
                params.get("size_field", ["turnover"])[0],
                float(params.get("fraction", ["1"])[0]),
            )
            self.send_json(HTTPStatus.OK, compute_panel_scatter(key))
            return
        if parsed.path == "/api/grid_fields":
            params = parse_qs(parsed.query)
            block_ms = normalize_block_ms(float(params.get("bar_interval", ["0.125"])[0]))
            fields = tuple(dict.fromkeys(params.get("fields", ["mid,ret_pct,ofi,turnover"])[0].split(",")))
            if not fields:
                raise ValueError("fields must not be empty")
            for field in fields:
                if field not in PANEL_FIELDS:
                    raise ValueError(f"Unsupported panel field: {field}")
            key = (
                params.get("start_datetime", [""])[0],
                params.get("end_datetime", [""])[0],
                block_ms,
                fields,
                float(params.get("fraction", ["1"])[0]),
            )
            self.send_json(HTTPStatus.OK, compute_grid_fields(key))
            return
        if parsed.path == "/api/groupby_fields":
            params = parse_qs(parsed.query)
            fields = tuple(dict.fromkeys(params.get("fields", ["mid,ret_pct,ofi,turnover"])[0].split(",")))
            if not fields:
                raise ValueError("fields must not be empty")
            for field in fields:
                if field not in PANEL_FIELDS:
                    raise ValueError(f"Unsupported panel field: {field}")
            key = (
                params.get("start_datetime", [""])[0],
                params.get("end_datetime", [""])[0],
                fields,
                float(params.get("fraction", ["1"])[0]),
            )
            self.send_json(HTTPStatus.OK, compute_groupby_fields(key))
            return
        super().do_GET()

    def do_HEAD(self) -> None:
        parsed = urlparse(self.path)
        if not self._authorized(parsed.path):
            self._unauthorized(head=True)
            return
        if parsed.path in {"/", "/health"}:
            self.send_response(HTTPStatus.OK)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        self.send_response(HTTPStatus.NOT_FOUND)
        self.end_headers()

    def log_message(self, *args: object) -> None:
        return

    def _authorized(self, path: str) -> bool:
        if ALLOW_ANONYMOUS:
            return True
        if path == "/health":
            return True
        if self.command == "HEAD" and path == "/":
            return True
        auth = self.headers.get("authorization", "")
        scheme, _, credentials = auth.partition(" ")
        scheme_lc = scheme.lower()
        if scheme_lc == "basic":
            try:
                decoded = base64.b64decode(credentials, validate=True).decode("utf-8", "strict")
            except (binascii.Error, ValueError, UnicodeDecodeError):
                decoded = ""
            user, sep, password = decoded.partition(":")
            return (
                bool(sep)
                and secrets.compare_digest(user, _app_username)
                and secrets.compare_digest(password, _app_password)
            )
        if scheme_lc == "bearer":
            return secrets.compare_digest(credentials, _api_secret)
        return False

    def _unauthorized(self, *, head: bool = False) -> None:
        body = b'{"detail":"authentication required"}'
        self.send_response(HTTPStatus.UNAUTHORIZED)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("WWW-Authenticate", 'Basic realm="Crucible"')
        self.end_headers()
        if not head:
            self.wfile.write(body)


def main() -> None:
    _require_auth_env()
    bind_host = host()
    bind_port = port()
    server = ThreadingHTTPServer((bind_host, bind_port), Handler)
    logging.warning("crucible http://%s:%s", bind_host, bind_port)
    server.serve_forever()


if __name__ == "__main__":
    main()
