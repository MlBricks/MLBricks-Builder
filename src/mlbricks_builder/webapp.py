from __future__ import annotations

import json
import os
import re
import secrets
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse


def _free_port(host: str = "127.0.0.1") -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


def _kaggle_proxy_url(port: int, session_token: str) -> str | None:
    """Return Kaggle's authenticated Jupyter proxy URL for a local port."""
    try:
        from jupyter_server.serverapp import list_running_servers
        for server in list_running_servers():
            base = str(server.get("base_url") or "")
            match = re.search(r"/k/([^/]+)/([^/]+)/?", base)
            if not match:
                continue
            kernel, token = match.groups()
            return (
                "https://kkb-production.jupyter-proxy.kaggle.net"
                f"/k/{kernel}/{token}/proxy/proxy/{int(port)}/session/{session_token}/"
            )
    except Exception:
        return None
    return None


def _public_url(port: int, session_token: str, environment: dict | None = None) -> tuple[str, str]:
    kind = str((environment or {}).get("kind") or "").lower()
    if kind == "kaggle" or os.environ.get("KAGGLE_KERNEL_RUN_TYPE") or os.path.isdir("/kaggle"):
        url = _kaggle_proxy_url(port, session_token)
        if url:
            return url, "Kaggle Jupyter Proxy"
    return f"http://127.0.0.1:{int(port)}/session/{session_token}/", "Localhost"


class BuilderWebApp:
    def __init__(self, builder, host: str = "127.0.0.1", port: int | None = None):
        self.builder = builder
        self.host = host
        self.port = int(port or _free_port(host))
        self.session_token = secrets.token_urlsafe(24)
        self._lock = threading.RLock()
        self._httpd: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self._progress = {
            "status": "idle",
            "overall": 0,
            "message": "Builder web app ready.",
            "nodes": {},
            "ts": time.time(),
        }
        self.url, self.access_mode = _public_url(
            self.port, self.session_token, getattr(builder, "local_environment", None)
        )

    @property
    def running(self) -> bool:
        return bool(self._thread and self._thread.is_alive() and self._httpd)

    def publish_progress(self, payload: dict):
        with self._lock:
            data = dict(payload or {})
            data["ts"] = time.time()
            self._progress = data

    def progress(self) -> dict:
        with self._lock:
            return json.loads(json.dumps(self._progress, default=str))

    def _page_html(self) -> str:
        bridge = {
            "mode": "http",
            "run": "__http_run__",
            "stop": "__http_stop__",
            "state": "__http_state__",
            "command": "__http_command__",
            "progress": "__http_progress__",
        }
        body = self.builder._html(bridge=bridge)
        return (
            '<!doctype html><html><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            '<title>MLBricks Builder</title>'
            '<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#0b1118}'
            'body{padding:0}.mlb-root{width:100vw!important;height:100vh!important;min-height:0!important;'
            'max-height:none!important;min-width:0!important;border:0!important;border-radius:0!important;'
            'box-shadow:none!important}</style></head><body>'
            + body + '</body></html>'
        )

    def start(self):
        if self.running:
            return self.info()

        app = self
        prefix = f"/session/{self.session_token}/"

        class Handler(BaseHTTPRequestHandler):
            server_version = "MLBricksBuilder/0.7.19"

            def log_message(self, format, *args):
                return

            def _json(self, status: int, data):
                raw = json.dumps(data, default=str).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(raw)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(raw)

            def _body(self):
                n = int(self.headers.get("Content-Length") or 0)
                if n <= 0:
                    return {}
                return json.loads(self.rfile.read(n).decode("utf-8"))

            def _relative(self):
                path = urlparse(self.path).path
                if not path.startswith(prefix):
                    return None
                return path[len(prefix):].lstrip("/")

            def do_GET(self):
                rel = self._relative()
                if rel is None:
                    self.send_error(404)
                    return
                if rel in {"", "index.html"}:
                    raw = app._page_html().encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.send_header("Content-Length", str(len(raw)))
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    self.wfile.write(raw)
                    return
                if rel == "api/health":
                    self._json(200, {"ok": True, "version": "0.7.19", "access_mode": app.access_mode})
                    return
                if rel == "api/progress":
                    self._json(200, app.progress())
                    return
                if rel == "api/state":
                    self._json(200, {"state": app.builder.to_dict()})
                    return
                self.send_error(404)

            def do_POST(self):
                rel = self._relative()
                if rel is None:
                    self.send_error(404)
                    return
                try:
                    body = self._body()
                    if rel == "api/run":
                        state = body.get("state") if isinstance(body, dict) else None
                        command = body.get("command") if isinstance(body, dict) else None
                        command = command if isinstance(command, dict) else {"action": "data"}
                        started = app.builder._launch_command(
                            command,
                            incoming_state=state if isinstance(state, dict) else None,
                            progress_callback=app.publish_progress,
                        )
                        if not started:
                            self._json(409, {"ok": False, "message": "A Builder runtime action is already active."})
                        else:
                            self._json(202, {"ok": True, "message": "Runtime action started."})
                        return
                    if rel == "api/stop":
                        app.builder.stop()
                        self._json(200, {"ok": True, "message": "Stop requested."})
                        return
                    if rel == "api/state":
                        state = body.get("state") if isinstance(body, dict) else None
                        if not isinstance(state, dict) or not state.get("components"):
                            self._json(400, {"ok": False, "message": "Invalid Builder state."})
                            return
                        with app._lock:
                            app.builder.state = state
                        self._json(200, {"ok": True})
                        return
                except Exception as exc:
                    self._json(500, {"ok": False, "message": f"{type(exc).__name__}: {exc}"})
                    return
                self.send_error(404)

        self._httpd = ThreadingHTTPServer((self.host, self.port), Handler)
        self._thread = threading.Thread(
            target=self._httpd.serve_forever,
            name=f"mlbricks-builder-web-{self.port}",
            daemon=True,
        )
        self._thread.start()
        return self.info()

    def info(self) -> dict:
        return {
            "running": self.running,
            "url": self.url,
            "port": self.port,
            "access_mode": self.access_mode,
            "environment": (getattr(self.builder, "local_environment", {}) or {}).get("name", "Python Environment"),
        }

    def stop(self):
        httpd = self._httpd
        self._httpd = None
        if httpd is not None:
            try:
                httpd.shutdown()
            except Exception:
                pass
            try:
                httpd.server_close()
            except Exception:
                pass
        return self.info()
