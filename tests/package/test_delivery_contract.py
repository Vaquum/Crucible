from __future__ import annotations

import importlib
from pathlib import Path

import pytest

import crucible.serve as serve

REPO_ROOT = Path(__file__).resolve().parents[2]
ASSETS = REPO_ROOT / "src" / "crucible" / "assets"


def test_package_imports() -> None:
    assert importlib.import_module("crucible").__name__ == "crucible"


def test_app_config_endpoint_payload_uses_mill_contract(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(serve, "API_UPSTREAM", "")
    monkeypatch.setattr(serve, "meta", lambda: {"start": "2026-05-14T10:28:00", "end": "2026-06-06T06:55:53", "files": []})
    payload = serve.app_config()
    assert payload["app_name"] == "Crucible"
    assert payload["default_block_ms"] == 125
    assert payload["endpoints"]["meta"] == "/api/meta"
    assert "mid" in payload["fields"]


def test_app_config_uses_upstream_meta_without_proxying_it(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(serve, "API_UPSTREAM", "http://127.0.0.1:1")
    monkeypatch.setattr(serve, "upstream_meta", lambda: {"start": "2026-05-14T10:28:00", "end": "2026-06-06T06:55:53", "files": []})
    payload = serve.app_config()
    assert payload["app_name"] == "Crucible"
    assert payload["endpoints"]["scatter"] == "/api/scatter"


def test_static_assets_are_packaged_and_proxy_relative() -> None:
    html = (ASSETS / "index.html").read_text(encoding="utf-8")
    assert (ASSETS / "app.js").is_file()
    assert (ASSETS / "style.css").is_file()
    assert 'href="assets/style.css' in html
    assert 'src="assets/app.js' in html
    assert 'id="timelinePlay"' in html
    assert 'id="timeline"' in html
    assert 'id="timelineSpeed"' in html
    assert 'id="timelineLabel"' not in html
    assert 'id="start" type="datetime-local" step="0.001"' in html
    assert 'id="end" type="datetime-local" step="0.001"' in html
    assert 'href="/' not in html
    assert 'src="/' not in html


def test_browser_api_calls_are_proxy_relative() -> None:
    js = (ASSETS / "app.js").read_text(encoding="utf-8")
    assert 'fetch("api/meta")' in js
    assert "fetch(`/api/" not in js
    assert 'fetch("/api/' not in js


def test_timeline_playback_preserves_window_and_steps_by_groupby() -> None:
    js = (ASSETS / "app.js").read_text(encoding="utf-8")
    assert "function blockStepMs()" in js
    assert "Math.round(Number(el.barInterval.value) * 1000)" in js
    assert "let timelineDomainStart" in js
    assert "function setSelectedDateRange(start, end" in js
    assert "function timelineStepForEnd(end" in js
    assert 'iso.slice(20, 23) === "000"' in js
    assert "function playbackDelayMs()" in js
    assert "function playbackStepCount()" in js
    assert "Math.ceil(maxStep / width)" in js
    assert "function playLoop()" in js
    assert "setTimeout(playLoop, playbackDelayMs())" in js
    assert "requestAnimationFrame(playLoop)" not in js
    assert 'el.timeline.value = "0"' in js
    assert "if (!advanceTimelineStep()) return;" in js
    assert "setRangeFromTimeline" in js
    assert "pointerdown" in js


def test_canvas_labels_are_hidden_and_timeline_speed_is_explicit() -> None:
    html = (ASSETS / "index.html").read_text(encoding="utf-8")
    css = (ASSETS / "style.css").read_text(encoding="utf-8")
    js = (ASSETS / "app.js").read_text(encoding="utf-8")
    assert '<select id="timelineSpeed"' in html
    for speed in ("1", "2", "4", "8", "16", "32"):
        assert f'<option value="{speed}">{speed}x</option>' in html
    assert "#status, #tooltip { display: none !important; }" in css
    assert 'addEventListener("mousemove"' not in js
    assert 'fillText("x=0"' not in js
    assert 'fillText("y=0"' not in js


def test_current_hour_preset_uses_latest_data_hour_not_exclusive_end_hour() -> None:
    js = (ASSETS / "app.js").read_text(encoding="utf-8")
    assert "hourStart(new Date(end.getTime() - 1))" in js


def test_initial_query_is_bounded_to_latest_four_hours() -> None:
    js = (ASSETS / "app.js").read_text(encoding="utf-8")
    assert "availableEnd.getTime() - 4 * 60 * 60 * 1000" in js
    assert "el.start.value = meta.start" not in js


def test_auth_env_is_required(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in ("APP_USERNAME", "APP_PASSWORD", "API_SECRET"):
        monkeypatch.delenv(key, raising=False)
    with pytest.raises(RuntimeError):
        serve._require_auth_env()
    monkeypatch.setenv("APP_USERNAME", "user")
    monkeypatch.setenv("APP_PASSWORD", "pass")
    monkeypatch.setenv("API_SECRET", "secret")
    serve._require_auth_env()


def test_delivery_files_match_sister_app_shape() -> None:
    dockerfile = (REPO_ROOT / "Dockerfile").read_text(encoding="utf-8")
    compose = (REPO_ROOT / "deploy" / "docker-compose.yml").read_text(encoding="utf-8")
    assert 'CMD ["python", "-m", "crucible"]' in dockerfile
    assert "EXPOSE 8877" in dockerfile
    assert "services:\n  crucible:" in compose
    assert "APP_USERNAME" in compose
    assert "API_SECRET" in compose
    assert "${CRUCIBLE_PORT:-8877}:8877" in compose
    assert "target: /data/experiments" in compose
