#!/usr/bin/env python3
"""Start or reuse this workspace's local garden, then open it in a browser.

The server runs in its own process session. Closing the launcher or its Terminal
window does not stop it. No import runs until the user requests a refresh.
"""

from __future__ import annotations

import argparse
import errno
import json
from pathlib import Path
import socket
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
import webbrowser

if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from local.serve_garden import APP_ID, REPO_ROOT, workspace_identity


SERVER = REPO_ROOT / "local/serve_garden.py"
RUNTIME = REPO_ROOT / "local/runtime"
START_TIMEOUT = 9.0


class LaunchError(RuntimeError):
    """An actionable local startup failure."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def probe_server(port: int, timeout: float = 0.6) -> dict | None:
    """Return verified health, None for a free port, or reject another service.

    A PID file is never proof of ownership. Both the app identity and the resolved
    workspace identity must match the currently listening HTTP server.
    """
    url = f"http://127.0.0.1:{port}/api/status"
    request = Request(url, headers={"Accept": "application/json"})
    try:
        # Local checks must not pass through system HTTP proxies.
        with build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=timeout) as response:
            if response.geturl() != url:
                raise LaunchError(f"Port {port} redirects to another service.")
            data = json.loads(response.read(65537))
    except HTTPError as error:
        raise LaunchError(f"Port {port} is occupied by an unverified service (HTTP {error.code}).") from error
    except URLError as error:
        reason = error.reason
        if isinstance(reason, OSError) and reason.errno == errno.ECONNREFUSED:
            return None
        raise LaunchError(f"Port {port} did not return garden health: {reason}.") from error
    except (TimeoutError, socket.timeout) as error:
        raise LaunchError(f"Port {port} is occupied but its health check timed out.") from error
    except (ValueError, OSError) as error:
        raise LaunchError(f"Port {port} did not return valid garden health.") from error
    if not isinstance(data, dict) or data.get("appId") != APP_ID:
        raise LaunchError(f"Port {port} belongs to an unverified service, not this garden.")
    if data.get("workspaceId") != workspace_identity():
        raise LaunchError(f"Port {port} belongs to a different garden workspace.")
    if data.get("available") is not True:
        raise LaunchError(f"The garden on port {port} is not ready.")
    return data


def record_pid(port: int, status: dict, runtime: Path = RUNTIME) -> None:
    pid = status.get("processId")
    if isinstance(pid, int) and not isinstance(pid, bool) and pid > 0:
        runtime.mkdir(parents=True, exist_ok=True)
        (runtime / f"server-{port}.pid").write_text(f"{pid}\n")


def start_or_reuse(port: int = 8766, runtime: Path = RUNTIME) -> tuple[dict, bool]:
    status = probe_server(port)
    if status is not None:
        record_pid(port, status, runtime)
        return status, False
    runtime.mkdir(parents=True, exist_ok=True)
    log_path = runtime / f"server-{port}.log"
    try:
        with log_path.open("ab", buffering=0) as log:
            process = subprocess.Popen(
                [sys.executable, "-u", str(SERVER), "--port", str(port)],
                cwd=REPO_ROOT,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=log,
                start_new_session=True,
                close_fds=True,
            )
    except OSError as error:
        raise LaunchError(f"Could not start the garden: {error}. Log: {log_path}") from error
    deadline = time.monotonic() + START_TIMEOUT
    last_error = None
    while time.monotonic() < deadline:
        try:
            status = probe_server(port, timeout=min(0.6, max(0.01, deadline - time.monotonic())))
            if status is not None:
                record_pid(port, status, runtime)
                return status, status.get("processId") == process.pid
        except LaunchError as error:
            last_error = error
        if process.poll() is not None:
            raise LaunchError(
                f"Garden server exited with code {process.returncode}. "
                f"{last_error or 'Check the startup log.'} Log: {log_path}"
            )
        time.sleep(min(0.15, max(0, deadline - time.monotonic())))
    # This is only the process created above, never a process from a stale PID.
    process.terminate()
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        pass
    raise LaunchError(f"Garden startup did not finish within {START_TIMEOUT:g} seconds. "
                      f"{last_error or 'Check the Python installation.'} Log: {log_path}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-open", action="store_true", help="Start without opening a browser.")
    parser.add_argument("--port", type=int, default=8766, help="Explicit local port (default: 8766).")
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    try:
        status, started = start_or_reuse(args.port)
    except (LaunchError, OSError) as error:
        log_path = RUNTIME / "launcher.log"
        try:
            RUNTIME.mkdir(parents=True, exist_ok=True)
            with log_path.open("a") as log:
                log.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {error}\n")
            log_note = f"Launcher log: {log_path}"
        except OSError:
            log_note = f"Could not write launcher log: {log_path}"
        print(f"Garden did not start: {error}", file=sys.stderr)
        print(log_note, file=sys.stderr)
        print("If another app owns this port, close that app or choose an explicit --port. "
              "No existing process was stopped.", file=sys.stderr)
        return 1
    url = f"http://127.0.0.1:{args.port}/index.html"
    print(f"{'Started' if started else 'Reused'} garden server (PID {status.get('processId', 'unknown')}).")
    print(f"Garden: {url}")
    print(f"Log: {RUNTIME / f'server-{args.port}.log'}")
    if not args.no_open:
        try:
            if sys.platform == "darwin":
                subprocess.run(["/usr/bin/open", url], check=True)
            elif not webbrowser.open(url):
                raise OSError("No default browser is available")
        except (OSError, subprocess.CalledProcessError) as error:
            print(f"The server is running. Open the Garden URL above. Browser error: {error}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
