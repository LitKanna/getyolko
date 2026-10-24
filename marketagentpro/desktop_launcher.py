from __future__ import annotations

import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

from streamlit.web import cli as streamlit_cli


APP_NAME = "MarketAgentPro"
DEFAULT_PORT = 8501


def bundled_path(*parts: str) -> Path:
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS")).joinpath(*parts)
    return Path(__file__).resolve().parent.joinpath(*parts)


def runtime_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def find_free_port(start_port: int = DEFAULT_PORT, attempts: int = 20) -> int:
    for port in range(start_port, start_port + attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.2)
            if sock.connect_ex(("127.0.0.1", port)) != 0:
                return port
    return start_port


def skip_streamlit_email_prompt() -> None:
    os.environ.setdefault("STREAMLIT_BROWSER_GATHER_USAGE_STATS", "false")
    config_dir = Path.home() / ".streamlit"
    config_dir.mkdir(parents=True, exist_ok=True)
    creds = config_dir / "credentials.toml"
    if not creds.exists():
        creds.write_text('[general]\nemail = ""\n', encoding="utf-8")


def wait_for_health(url: str, timeout_sec: float = 45.0) -> bool:
    deadline = time.time() + timeout_sec
    health = url.rstrip("/") + "/_stcore/health"
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(health, timeout=1.5) as resp:
                if getattr(resp, "status", 200) == 200:
                    return True
        except (urllib.error.URLError, TimeoutError, OSError):
            time.sleep(0.3)
    return False


def open_browser_when_ready(url: str) -> None:
    if wait_for_health(url):
        webbrowser.open(url)


def main():
    app_path = bundled_path("app.py")
    work_dir = runtime_dir()
    os.chdir(work_dir)
    work_dir.joinpath("data").mkdir(parents=True, exist_ok=True)
    skip_streamlit_email_prompt()

    port = find_free_port()
    url = f"http://127.0.0.1:{port}"
    threading.Thread(target=open_browser_when_ready, args=(url,), daemon=True).start()

    sys.argv = [
        "streamlit",
        "run",
        str(app_path),
        "--server.headless=true",
        f"--server.port={port}",
        "--server.address=127.0.0.1",
        "--browser.gatherUsageStats=false",
        "--global.developmentMode=false",
    ]
    sys.exit(streamlit_cli.main())


if __name__ == "__main__":
    main()
