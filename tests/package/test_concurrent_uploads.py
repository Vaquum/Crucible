from __future__ import annotations

import json
import os
from http import HTTPStatus
from pathlib import Path
from typing import ClassVar

import pytest

import crucible.serve as serve
from crucible.datasets import DatasetRef, base_frame, parse_ref, save_upload, upload_generation
from crucible.scatter import compute_scatter


class _CapturingHandler(serve.Handler):
    """Drives `do_POST` without a socket; records what `send_json` emits."""

    sent: ClassVar[list[tuple[HTTPStatus, str | dict[str, object]]]] = []

    def send_json(self, status: HTTPStatus, payload: str | dict[str, object]) -> None:
        type(self).sent.append((status, payload))


def test_app_config_has_no_clear_uploads() -> None:
    assert "clear_uploads" not in serve.app_config()["endpoints"]


def test_clear_uploads_route_returns_404(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(serve, "ALLOW_ANONYMOUS", True)
    _CapturingHandler.sent.clear()
    handler = _CapturingHandler.__new__(_CapturingHandler)
    handler.path = "/api/clear-uploads"
    handler.do_POST()
    assert _CapturingHandler.sent == [(HTTPStatus.NOT_FOUND, {"error": "not found"})]


def test_save_upload_publishes_atomically(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    uploads = tmp_path / "uploads"
    monkeypatch.setattr("crucible.datasets.UPLOAD_DIR", uploads)
    replaced: list[tuple[str, str]] = []
    real_replace = os.replace

    def spy(src: str, dst: Path) -> None:
        replaced.append((str(src), str(dst)))
        real_replace(src, dst)

    monkeypatch.setattr("crucible.datasets.os.replace", spy)
    assert save_upload("atomic.csv", b"a,b\n1,2\n") == "atomic.csv"
    assert [path.name for path in uploads.iterdir()] == ["atomic.csv"]
    assert (uploads / "atomic.csv").read_bytes() == b"a,b\n1,2\n"
    save_upload("atomic.csv", b"a,b\n9,9\n")
    assert [path.name for path in uploads.iterdir()] == ["atomic.csv"]
    assert (uploads / "atomic.csv").read_bytes() == b"a,b\n9,9\n"
    assert [Path(src).parent for src, _ in replaced] == [uploads, uploads]
    assert [dst for _, dst in replaced] == [str(uploads / "atomic.csv")] * 2


def test_stale_inflight_result_cannot_stick(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("crucible.datasets.UPLOAD_DIR", tmp_path / "uploads")
    base_frame.cache_clear()
    save_upload("stale.csv", b"a,b\n1,2\n")
    old_ref = DatasetRef("upload", upload_id="stale.csv", generation=upload_generation())
    assert base_frame(old_ref).height == 1
    save_upload("stale.csv", b"a,b\n1,2\n3,4\n")
    # The in-flight pre-overwrite load lands under the old generation key;
    # any ref parsed after the save carries the new generation and re-reads.
    assert base_frame(old_ref).height == 1
    fresh_ref = DatasetRef("upload", upload_id="stale.csv", generation=upload_generation())
    assert fresh_ref != old_ref
    assert base_frame(fresh_ref).height == 2
    base_frame.cache_clear()


def test_scatter_reflects_reupload(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("crucible.datasets.UPLOAD_DIR", tmp_path / "uploads")
    base_frame.cache_clear()
    params = {"source": ["upload"], "upload": ["rescatter.csv"]}
    save_upload("rescatter.csv", b"a,b\n1,2\n3,4\n")
    first = json.loads(compute_scatter(parse_ref(params), "a", "b", "a", "b", 1.0, "", ""))
    assert first["rows"] == 2
    save_upload("rescatter.csv", b"a,b\n1,2\n3,4\n5,6\n")
    second = json.loads(compute_scatter(parse_ref(params), "a", "b", "a", "b", 1.0, "", ""))
    assert second["rows"] == 3
    base_frame.cache_clear()
