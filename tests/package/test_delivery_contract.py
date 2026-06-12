from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest

import crucible.serve as serve
from crucible.datasets import DatasetRef, base_frame, dataset_meta, parse_ref
from crucible.scatter import compute_scatter

REPO_ROOT = Path(__file__).resolve().parents[2]
ASSETS = REPO_ROOT / "src" / "crucible" / "assets"


def test_package_imports() -> None:
    assert importlib.import_module("crucible").__name__ == "crucible"


def test_app_config_lists_sources_with_relative_endpoints() -> None:
    payload = serve.app_config()
    assert payload["app_name"] == "Crucible"
    endpoints = payload["endpoints"]
    for key in ("klines", "sweeps", "uploads", "upload", "meta", "scatter"):
        assert key in endpoints
    assert all(not value.startswith("/") for value in endpoints.values())


def test_static_assets_packaged_and_proxy_relative() -> None:
    html = (ASSETS / "index.html").read_text(encoding="utf-8")
    assert (ASSETS / "app.js").is_file()
    assert (ASSETS / "style.css").is_file()
    assert 'href="assets/style.css' in html
    assert 'src="assets/app.js' in html
    assert 'id="datasetToggle"' in html
    assert 'id="datasetModal"' in html
    for source in ("klines", "sweep", "upload"):
        assert f'data-source-card="{source}"' in html
    assert 'href="/' not in html
    assert 'src="/' not in html


def test_groupby_controls_removed() -> None:
    html = (ASSETS / "index.html").read_text(encoding="utf-8")
    assert 'id="barInterval"' not in html
    assert 'id="barFunction"' not in html
    assert "Groupby" not in html


def test_browser_api_calls_are_proxy_relative() -> None:
    js = (ASSETS / "app.js").read_text(encoding="utf-8")
    assert 'fetch("app-config")' in js
    assert '"/api/' not in js
    assert "fetch(`/api/" not in js


def test_klines_loader_uses_limen() -> None:
    source = (REPO_ROOT / "src" / "crucible" / "datasets.py").read_text(encoding="utf-8")
    assert "from limen import HistoricalData" in source
    assert "get_arrow_file" in source


def test_parse_ref_validates_source() -> None:
    assert parse_ref({"source": ["klines"], "series": ["time_1h"]}).series == "time_1h"
    with pytest.raises(ValueError):
        parse_ref({"source": ["bogus"]})
    with pytest.raises(ValueError):
        parse_ref({"source": ["klines"], "series": ["../escape"]})


def test_csv_upload_typing_and_categorical_scatter(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    (uploads / "demo.csv").write_text("a,b,grp\n1,2,x\n3,4,y\n5,6,x\n", encoding="utf-8")
    monkeypatch.setattr("crucible.datasets.UPLOAD_DIR", uploads)
    base_frame.cache_clear()
    ref = DatasetRef("upload", upload_id="demo.csv")
    meta = dataset_meta(ref)
    kinds = {column["name"]: column["kind"] for column in meta["columns"]}
    assert kinds == {"a": "numeric", "b": "numeric", "grp": "categorical"}
    assert meta["time_column"] is None
    payload = json.loads(compute_scatter(ref, "a", "b", "grp", "a", 1.0, "", ""))
    assert payload["points"] == 3
    assert payload["color_categories"] == ["x", "y"]
    base_frame.cache_clear()


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
    assert "target: /data/experiments" in compose
    assert "target: /opt/arrow" in compose
    assert "source: arrow" in compose
    assert "external: true" in compose
    assert "CRUCIBLE_ARROW_DIR: /opt/arrow" in compose
    assert "${CRUCIBLE_PORT:-8877}:8877" in compose
    assert "ORIGO_" not in compose
