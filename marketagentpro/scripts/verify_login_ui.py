#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main() -> int:
    from streamlit.testing.v1 import AppTest

    at = AppTest.from_file(str(ROOT / "app.py"), default_timeout=45)
    at.run()

    titles = [t.value for t in at.title]
    print(f"titles={titles}")
    if "MarketAgentPro" not in titles:
        print("FAIL missing login title")
        return 1

    at.text_input[0].set_value("faz")
    at.text_input[1].set_value("wrong-password")
    at.button[0].click().run()
    errors = [e.value for e in at.error]
    print(f"bad_password_errors={errors}")
    if not any("Wrong username or password" in str(e) for e in errors):
        print("FAIL missing rejection")
        return 1
    try:
        bad_user = at.session_state["auth_user"]
    except (KeyError, AttributeError):
        bad_user = None
    if bad_user:
        print("FAIL signed in on bad password")
        return 1

    at.text_input[0].set_value("faz")
    at.text_input[1].set_value("23532259")
    at.button[0].click().run()
    try:
        user = at.session_state["auth_user"]
    except (KeyError, AttributeError):
        user = None
    print(f"auth_user={user}")
    if user != "faz":
        print("FAIL good password did not sign in")
        return 1
    if any("Wrong username or password" in str(e) for e in [e.value for e in at.error]):
        print("FAIL error still showing after good password")
        return 1
    captions = [c.value for c in at.sidebar.caption]
    print(f"sidebar_captions={captions}")
    if not any("Signed in as faz" in str(c) for c in captions):
        print("FAIL missing signed-in caption")
        return 1

    print("PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
