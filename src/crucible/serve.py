"""HTTP layer: serve the static UI and the dataset/scatter JSON endpoints.

The data lives in the selected dataset (klines, sweep results, or an upload);
this module only routes requests to `crucible.datasets` and `crucible.scatter`
and enforces basic/bearer auth.
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
import os
import secrets
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from crucible import datasets
from crucible.datasets import parse_ref
from crucible.scatter import compute_scatter

APP_NAME = 'Crucible'
APP_DIR = Path(__file__).resolve().parent
ASSET_DIR = APP_DIR / 'assets'
ALLOW_ANONYMOUS = os.environ.get('CRUCIBLE_ALLOW_ANONYMOUS', '') == '1'
MAX_UPLOAD_BYTES = 512 * 1024 * 1024

_app_username = ''
_app_password = ''
_api_secret = ''


def _require_auth_env() -> None:
    global _app_username, _app_password, _api_secret
    _app_username = os.environ.get('APP_USERNAME', '')
    _app_password = os.environ.get('APP_PASSWORD', '')
    _api_secret = os.environ.get('API_SECRET', '')
    if not (_app_username and _app_password and _api_secret):
        raise RuntimeError(
            'Crucible requires APP_USERNAME, APP_PASSWORD, and API_SECRET environment variables'
        )


def host() -> str:
    return os.environ.get('CRUCIBLE_HOST', '127.0.0.1')


def port() -> int:
    return int(os.environ.get('CRUCIBLE_PORT', '8877'))


def app_config() -> dict[str, object]:
    return {
        'app_name': APP_NAME,
        'endpoints': {
            'klines': 'api/klines',
            'sweeps': 'api/sweeps',
            'uploads': 'api/uploads',
            'upload': 'api/upload',
            'clear_uploads': 'api/clear-uploads',
            'meta': 'api/meta',
            'scatter': 'api/scatter',
        },
    }


def _first(params: dict[str, list[str]], key: str, default: str = '') -> str:
    values = params.get(key)
    return values[0] if values else default


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path: str) -> str:
        raw_path = urlparse(path).path
        clean = raw_path.removeprefix('/assets/').lstrip('/') or 'index.html'
        return str(ASSET_DIR / clean)

    def send_json(self, status: HTTPStatus, payload: str | dict[str, object]) -> None:
        body = payload if isinstance(payload, str) else json.dumps(payload, separators=(',', ':'))
        self.send_bytes(status, 'application/json', body.encode())

    def send_bytes(self, status: int | HTTPStatus, ctype: str, data: bytes) -> None:
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def _handle_api(self, path: str, query: str) -> bool:
        if path == '/app-config':
            self.send_json(HTTPStatus.OK, app_config())
            return True
        if path == '/api/klines':
            self.send_json(HTTPStatus.OK, {'series': datasets.list_klines()})
            return True
        if path == '/api/sweeps':
            self.send_json(HTTPStatus.OK, {'experiments': datasets.list_sweeps()})
            return True
        if path == '/api/uploads':
            self.send_json(HTTPStatus.OK, {'uploads': datasets.list_uploads()})
            return True
        if path == '/api/meta':
            self.send_json(HTTPStatus.OK, datasets.dataset_meta(parse_ref(parse_qs(query))))
            return True
        if path == '/api/scatter':
            params = parse_qs(query)
            payload = compute_scatter(
                parse_ref(params),
                _first(params, 'x'),
                _first(params, 'y'),
                _first(params, 'color'),
                _first(params, 'size'),
                float(_first(params, 'fraction', '1')),
                _first(params, 'start'),
                _first(params, 'end'),
            )
            self.send_json(HTTPStatus.OK, payload)
            return True
        return False

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if not self._authorized(parsed.path):
            self._unauthorized()
            return
        if parsed.path == '/health':
            self.send_json(HTTPStatus.OK, {'status': 'ok'})
            return
        try:
            if self._handle_api(parsed.path, parsed.query):
                return
        except (ValueError, FileNotFoundError, KeyError) as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {'error': str(exc)})
            return
        super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if not self._authorized(parsed.path):
            self._unauthorized()
            return
        try:
            if parsed.path == '/api/upload':
                name = datasets.save_upload(_first(parse_qs(parsed.query), 'filename'), self._read_body())
                self.send_json(HTTPStatus.OK, {'upload': name})
                return
            if parsed.path == '/api/clear-uploads':
                datasets.clear_uploads()
                self.send_json(HTTPStatus.OK, {'cleared': True})
                return
        except (ValueError, FileNotFoundError, KeyError) as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {'error': str(exc)})
            return
        self.send_json(HTTPStatus.NOT_FOUND, {'error': 'not found'})

    def _read_body(self) -> bytes:
        length = int(self.headers.get('Content-Length', '0'))
        if not 0 < length <= MAX_UPLOAD_BYTES:
            raise ValueError(f'upload size must be 1..{MAX_UPLOAD_BYTES} bytes')
        return self.rfile.read(length)

    def do_HEAD(self) -> None:
        parsed = urlparse(self.path)
        if not self._authorized(parsed.path):
            self._unauthorized(head=True)
            return
        if parsed.path in {'/', '/health'}:
            self.send_response(HTTPStatus.OK)
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            return
        self.send_response(HTTPStatus.NOT_FOUND)
        self.end_headers()

    def log_message(self, format: str, *args: object) -> None:
        return

    def _authorized(self, path: str) -> bool:
        if ALLOW_ANONYMOUS:
            return True
        if path == '/health':
            return True
        if self.command == 'HEAD' and path == '/':
            return True
        auth = self.headers.get('authorization', '')
        scheme, _, credentials = auth.partition(' ')
        scheme_lc = scheme.lower()
        if scheme_lc == 'basic':
            try:
                decoded = base64.b64decode(credentials, validate=True).decode('utf-8', 'strict')
            except (binascii.Error, ValueError, UnicodeDecodeError):
                decoded = ''
            user, sep, password = decoded.partition(':')
            return (
                bool(sep)
                and secrets.compare_digest(user, _app_username)
                and secrets.compare_digest(password, _app_password)
            )
        if scheme_lc == 'bearer':
            return secrets.compare_digest(credentials, _api_secret)
        return False

    def _unauthorized(self, *, head: bool = False) -> None:
        body = b'{"detail":"authentication required"}'
        self.send_response(HTTPStatus.UNAUTHORIZED)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('WWW-Authenticate', 'Basic realm="Crucible"')
        self.end_headers()
        if not head:
            self.wfile.write(body)


def main() -> None:
    _require_auth_env()
    bind_host = host()
    bind_port = port()
    server = ThreadingHTTPServer((bind_host, bind_port), Handler)
    logging.warning('crucible http://%s:%s', bind_host, bind_port)
    server.serve_forever()


if __name__ == '__main__':
    main()
