from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import clickhouse_connect
import pyarrow as pa
import pyarrow.ipc as ipc

WORK = Path("/tmp/origo_arrow_work")
ENV_FILE = WORK / "clickhouse.env"
OUT_DIR = WORK / "arrow" / "btc_master_panel"
BLOCK_MS = tuple(125 * (2**power) for power in range(18))
CHUNK_BYTES = 16 * 1024 * 1024


def load_env(path: Path) -> None:
    for line in path.read_text().splitlines():
        key, sep, value = line.partition("=")
        if sep != "=":
            raise ValueError(f"Invalid env line in {path}: {line}")
        os.environ.setdefault(key, value)


def dt64(value: datetime, scale: int) -> str:
    text = value.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S.%f")
    if scale == 3:
        return text[:-3]
    if scale == 6:
        return text
    raise ValueError(f"Unsupported DateTime64 scale: {scale}")


def count_arrow_rows(path: Path) -> int:
    with pa.memory_map(str(path), "r") as source:
        with ipc.open_file(source) as reader:
            return sum(reader.get_batch(i).num_rows for i in range(reader.num_record_batches))


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
    with urlopen(request, timeout=1800) as response, out_path.open("wb") as handle:
        while True:
            chunk = response.read(CHUNK_BYTES)
            if not chunk:
                break
            handle.write(chunk)


def panel_query(start: datetime, end: datetime, block_ms: int) -> str:
    start6 = dt64(start, 6)
    end6 = dt64(end, 6)
    start3 = dt64(start, 3)
    end3 = dt64(end, 3)
    block = f"toDateTime64(toStartOfInterval(datetime, INTERVAL {block_ms} MILLISECOND), 6, 'UTC')"
    return f"""
WITH
    toDateTime64('{start6}', 6, 'UTC') AS start_ts6,
    toDateTime64('{end6}', 6, 'UTC') AS end_ts6,
    toDateTime64('{start3}', 3, 'UTC') AS start_ts3,
    toDateTime64('{end3}', 3, 'UTC') AS end_ts3,
    daily_max AS (SELECT max(datetime) AS mx FROM origo.binance_daily_spot_trades),
    tape AS (
        SELECT
            datetime,
            trade_id,
            price,
            quantity,
            quote_quantity,
            is_buyer_maker,
            toUInt64(round(quantity * 100000)) AS u
        FROM origo.binance_daily_spot_trades
        WHERE datetime >= start_ts6
          AND datetime < end_ts6
        UNION ALL
        SELECT
            toDateTime64(datetime, 6, 'UTC') AS datetime,
            trade_id,
            price,
            quantity,
            quote_quantity,
            is_buyer_maker,
            toUInt64(round(quantity * 100000)) AS u
        FROM origo.binance_spot_trades_latest
        WHERE datetime > (SELECT mx FROM daily_max)
          AND datetime >= start_ts3
          AND datetime < end_ts3
    ),
    tape_block AS (
        SELECT
            {block} AS block,
            argMax(price, trade_id) / argMin(price, trade_id) - 1 AS ret_pct,
            (max(price) / min(price) - 1) * 10000 AS range_bps,
            count() AS trades,
            sum(quote_quantity) AS turnover,
            countIf(u <= 10) / count() AS clip_pct,
            medianIf(quote_quantity, u > 10) AS med_declip,
            if(
                countIf(u > 10) = 0,
                CAST(NULL, 'Nullable(Float64)'),
                countIf(u > 10 AND is_buyer_maker = 0) / countIf(u > 10)
            ) AS buy_pct,
            sumIf(quote_quantity, u > 10 AND is_buyer_maker = 0)
              - sumIf(quote_quantity, u > 10 AND is_buyer_maker = 1) AS ofi
        FROM tape
        GROUP BY block
    ),
    book_raw AS (
        SELECT
            datetime,
            {block} AS block,
            (bids[1].1 + asks[1].1) / 2 AS mid,
            asks[1].1 - bids[1].1 AS spread,
            (asks[20].1 / ((bids[1].1 + asks[1].1) / 2) - 1) * 10000 AS reach20_bps,
            arraySum(x -> (x.1 * x.2), bids) AS bid_notional,
            arraySum(x -> (x.1 * x.2), asks) AS ask_notional,
            (arraySum(x -> (x.1 * x.2), bids) - arraySum(x -> (x.1 * x.2), asks))
              / (arraySum(x -> (x.1 * x.2), bids) + arraySum(x -> (x.1 * x.2), asks)) AS book_imb
        FROM origo.binance_spot_depth20_snapshots
        WHERE datetime >= start_ts3
          AND datetime < end_ts3
    ),
    book_block AS (
        SELECT
            block,
            median(mid) AS mid,
            quantileExact(0.999)(spread) AS spread_p999,
            median(reach20_bps) AS reach20_bps,
            median(bid_notional + ask_notional) / 1000 AS depth20_k,
            median(abs(book_imb)) AS abs_imb
        FROM book_raw
        GROUP BY block
    ),
    tape_sec AS (
        SELECT
            toStartOfSecond(datetime) AS s,
            sumIf(quote_quantity, u > 10 AND is_buyer_maker = 0)
              - sumIf(quote_quantity, u > 10 AND is_buyer_maker = 1) AS ofi_sec
        FROM tape
        GROUP BY s
    ),
    book_sec AS (
        SELECT
            toStartOfSecond(datetime) AS s,
            {block} AS block,
            argMax(mid, datetime) AS mid,
            argMax(book_imb, datetime) AS book_imb_sec
        FROM book_raw
        GROUP BY s, block
    ),
    per_sec AS (
        SELECT
            b.s AS s,
            b.block AS block,
            b.mid AS mid,
            b.book_imb_sec AS book_imb_sec,
            ifNull(t.ofi_sec, 0) AS ofi_sec
        FROM book_sec AS b
        LEFT JOIN tape_sec AS t ON b.s = t.s
    ),
    sec_markout AS (
        SELECT
            p.block AS block,
            p.ofi_sec AS ofi_sec,
            p.book_imb_sec AS book_imb_sec,
            f.mid / p.mid - 1 AS ret5
        FROM per_sec AS p
        INNER JOIN per_sec AS f ON f.s = p.s + INTERVAL 5 SECOND
    ),
    inter AS (
        SELECT
            block,
            corr(ofi_sec, ret5) AS flow_mo5s,
            corr(book_imb_sec, ret5) AS book_mo5s,
            if(
                countIf(abs(ofi_sec) > 1000 AND abs(book_imb_sec) > 0.1) = 0,
                CAST(NULL, 'Nullable(Float64)'),
                countIf(abs(ofi_sec) > 1000 AND abs(book_imb_sec) > 0.1 AND sign(ofi_sec) != sign(book_imb_sec))
                  / countIf(abs(ofi_sec) > 1000 AND abs(book_imb_sec) > 0.1)
            ) AS div_pct
        FROM sec_markout
        GROUP BY block
    )
SELECT
    t.block AS datetime,
    b.mid AS mid,
    t.ret_pct AS ret_pct,
    t.range_bps AS range_bps,
    t.trades AS trades,
    t.turnover AS turnover,
    t.clip_pct AS clip_pct,
    t.med_declip AS med_declip,
    t.buy_pct AS buy_pct,
    t.ofi AS ofi,
    b.spread_p999 AS spread_p999,
    b.reach20_bps AS reach20_bps,
    b.depth20_k AS depth20_k,
    b.abs_imb AS abs_imb,
    i.flow_mo5s AS flow_mo5s,
    i.book_mo5s AS book_mo5s,
    i.div_pct AS div_pct
FROM tape_block AS t
INNER JOIN book_block AS b ON t.block = b.block
LEFT JOIN inter AS i ON t.block = i.block
ORDER BY datetime
FORMAT Arrow
"""


def coverage(client: clickhouse_connect.driver.Client) -> tuple[datetime, datetime]:
    row = client.query(
        """
        WITH
            (SELECT max(datetime) FROM origo.binance_daily_spot_trades) AS daily_max,
            book_bounds AS (
                SELECT
                    min(toDateTime64(datetime, 6, 'UTC')) AS start_dt,
                    max(toDateTime64(datetime, 6, 'UTC')) AS end_dt
                FROM origo.binance_spot_depth20_snapshots
            ),
            tape_end AS (
                SELECT greatest(
                    daily_max,
                    (SELECT max(toDateTime64(datetime, 6, 'UTC')) FROM origo.binance_spot_trades_latest)
                ) AS end_dt
            )
        SELECT
            (SELECT start_dt FROM book_bounds) AS start_dt,
            least((SELECT end_dt FROM tape_end), (SELECT end_dt FROM book_bounds)) AS end_dt
        """
    ).first_row
    start, end = row
    return start.replace(tzinfo=UTC), end.replace(tzinfo=UTC)


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
    start, end = coverage(client)
    end_exclusive = end + timedelta(milliseconds=1)
    for block_ms in BLOCK_MS:
        final_path = OUT_DIR / f"btc_master_panel_{block_ms}ms.arrow"
        temp_path = final_path.with_suffix(".arrow.tmp")
        print(
            f"export block={block_ms}ms start={start.isoformat()} end={end_exclusive.isoformat()}",
            flush=True,
        )
        post_arrow(panel_query(start, end_exclusive, block_ms), temp_path)
        rows = count_arrow_rows(temp_path)
        if rows == 0:
            raise RuntimeError(f"{final_path} has no rows")
        os.replace(temp_path, final_path)
        print(f"ok block={block_ms}ms rows={rows} bytes={final_path.stat().st_size}", flush=True)


if __name__ == "__main__":
    main()
