from __future__ import annotations

from http import HTTPStatus

import pytest

import crucible.serve as serve


class _CapturingHandler(serve.Handler):
    """Drives `_handle_api` without a socket; records what `send_json` emits."""

    sent: list[tuple[HTTPStatus, str | dict[str, object]]] = []

    def send_json(self, status: HTTPStatus, payload: str | dict[str, object]) -> None:
        type(self).sent.append((status, payload))


def test_version_info_reads_build_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GIT_SHA", "abc1234")
    monkeypatch.setenv("BUILD_DATE", "2026-06-06T00:00:00Z")
    monkeypatch.setenv("GIT_SUBJECT", "feat: add /version build-provenance endpoint")
    assert serve.version_info() == {
        "sha": "abc1234",
        "date": "2026-06-06T00:00:00Z",
        "subject": "feat: add /version build-provenance endpoint",
    }


def test_version_info_defaults_blank(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in ("GIT_SHA", "BUILD_DATE", "GIT_SUBJECT"):
        monkeypatch.delenv(key, raising=False)
    assert serve.version_info() == {"sha": "", "date": "", "subject": ""}


def test_version_route_returns_provenance(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GIT_SHA", "deadbee")
    monkeypatch.setenv("BUILD_DATE", "2026-06-06T00:00:00Z")
    monkeypatch.setenv("GIT_SUBJECT", "feat: x")
    _CapturingHandler.sent.clear()
    handler = _CapturingHandler.__new__(_CapturingHandler)
    handled = handler._handle_api("/version", "")
    assert handled is True
    assert _CapturingHandler.sent == [
        (HTTPStatus.OK, {"sha": "deadbee", "date": "2026-06-06T00:00:00Z", "subject": "feat: x"}),
    ]
