#!/usr/bin/env python3
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from marketagent.auth import check_credentials


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        users_path = Path(tmp) / "users.json"
        good = check_credentials("faz", "23532259", users_path)
        good_case = check_credentials("FAZ", "23532259", users_path)
        bad_password = check_credentials("faz", "wrong-password", users_path)
        bad_user = check_credentials("not-faz", "23532259", users_path)
        empty = check_credentials("", "", users_path)

    print(f"faz/23532259 accepted={good}")
    print(f"FAZ/23532259 accepted={good_case}")
    print(f"faz/wrong-password accepted={bad_password}")
    print(f"not-faz/23532259 accepted={bad_user}")
    print(f"empty accepted={empty}")

    if good is True and good_case is True and bad_password is False and bad_user is False and empty is False:
        print("PASS")
        return 0
    print("FAIL")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
