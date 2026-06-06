from __future__ import annotations

import os
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import clickhouse_connect
import pyarrow as pa
import pyarrow.ipc as ipc

WORK = Path("/tmp/origo_arrow_work")
ENV_FILE = WORK / "clickhouse.env"
OUT_DIR = WORK / "arrow" / "binance_daily_spot_trades"
TABLE = "origo.binance_spot_trades_latest"
CHUNK_BYTES = 16 * 1024 * 1024


def load_env(path: Path) -> None:
    for line in path.read_text().splitlines():
        key, sep, value = line.partition("=")
        if sep != "=":
            raise ValueError(f"Invalid env line in {path}: {line}")
        os.environ.setdefault(key, value)


def dt64(value: datetime) -> str:
    return value.strftime("%Y-%m-%d %H:%M:%S.%f")


def count_arrow_rows(path: Path) -> int:
    with pa.memory_map(str(path), "r") as source:
        with ipc.open_file(source) as reader:
            return sum(reader.get_batch(index).num_rows for index in range(reader.num_record_batches))


def post_arrow(query: str, out_path: Path) -> None:
    host = os.environ["CH_HOST"]
    port = os.environ["CH_PORT"]
    database = os.environ["CH_DATABASE"]
    params = urlencode({"database": database, "wait_end_of_query": "0"})
    request = Request(
        f"http://{host}:{port}/?{params}",
        data=query.encode(),
        headers={
            "X-ClickHouse-User": os.environ["CH_USER"],
            "X-ClickHouse-Key": os.environ["CH_PASSWORD"],
        },
        method="POST",
    )
    with urlopen(request, timeout=900) as response, out_path.open("wb") as handle:
        while True:
            chunk = response.read(CHUNK_BYTES)
            if not chunk:
                break
            handle.write(chunk)


def main() -> None:
    load_env(ENV_FILE)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    client = clickhouse_connect.get_client(
        host=os.environ["CH_HOST"],
        port=int(os.environ["CH_PORT"]),
        username=os.environ["CH_USER"],
        password=os.environ["CH_PASSWORD"],
        database=os.environ["CH_DATABASE"],
    )
    day = client.query(f"SELECT toDate(max(datetime)) FROM {TABLE}").result_rows[0][0]
    start = datetime.combine(day, datetime.min.time())
    end = start + timedelta(days=1)
    expected_rows = client.query(
        f"""
        SELECT count()
        FROM {TABLE}
        WHERE datetime >= toDateTime64('{dt64(start)}', 3)
          AND datetime < toDateTime64('{dt64(end)}', 3)
        """
    ).result_rows[0][0]
    final_path = OUT_DIR / f"trades_{day.isoformat()}.arrow"
    temp_path = final_path.with_suffix(".arrow.tmp")
    query = f"""
        SELECT
            trade_id,
            price,
            quantity,
            quote_quantity,
            timestamp,
            is_buyer_maker,
            is_best_match,
            CAST(datetime, 'DateTime64(6)') AS datetime
        FROM {TABLE}
        WHERE datetime >= toDateTime64('{dt64(start)}', 3)
          AND datetime < toDateTime64('{dt64(end)}', 3)
        ORDER BY datetime, trade_id
        FORMAT Arrow
    """
    print(f"export {day.isoformat()} rows={expected_rows} path={final_path}", flush=True)
    post_arrow(query, temp_path)
    actual_rows = count_arrow_rows(temp_path)
    if actual_rows != expected_rows:
        raise RuntimeError(f"{day.isoformat()} expected {expected_rows} rows, wrote {actual_rows}")
    os.replace(temp_path, final_path)
    max_datetime = client.query(f"SELECT max(datetime) FROM {TABLE} WHERE toDate(datetime) = toDate('{day.isoformat()}')").result_rows[0][0]
    print(f"ok {day.isoformat()} rows={actual_rows} max_datetime={max_datetime}", flush=True)


if __name__ == "__main__":
    main()
