# Crucible

Crucible is the Origo rubric scatter explorer packaged as a sister app to Mill and Furnace.

## Run locally

```bash
python -m venv .venv
. .venv/bin/activate
python -m pip install -e '.[dev]'
APP_USERNAME=dev APP_PASSWORD=dev API_SECRET=dev \
ORIGO_ARROW_DIR=/tmp/origo_arrow_work/arrow/binance_daily_spot_trades \
ORIGO_PANEL_DIR=/tmp/origo_arrow_work/arrow/btc_master_panel \
python -m crucible
```

Default port: `8877`. Health: `/health`. App config: `/app-config`.

For local iframe/browser preview only, set `CRUCIBLE_ALLOW_ANONYMOUS=1`.

## Production access

The deploy compose publishes Crucible on `127.0.0.1:8877` only. Portal (https://portal.vaquum.fi) is the single entry point and proxies Crucible from `http://127.0.0.1:8877`.

## Production data contract

The container reads Arrow files from `/data/experiments/crucible` by default:

- raw trades: `/data/experiments/crucible/binance_daily_spot_trades`
- rubric panels: `/data/experiments/crucible/btc_master_panel`

Override with `ORIGO_ARROW_DIR` and `ORIGO_PANEL_DIR` when Smithy mounts data elsewhere.
