from __future__ import annotations

import hashlib
import hmac
import json
from pathlib import Path

from marketagent.config import DATA_DIR

USERS_FILE = DATA_DIR / "users.json"
ITERATIONS = 210_000
ALGO = "sha256"

SEED_USERS = {
    "faz": {
        "salt": "a1b2c3d4e5f60718293a4b5c6d7e8f90",
        "hash": "cad2d252cfdbb2ad0b31929414ef9a0ae820f784512cfbea9022b95efbf40551",
        "iterations": ITERATIONS,
        "algo": ALGO,
    }
}


def normalize_username(raw: str) -> str:
    return str(raw or "").strip().lower()


def _digest(password: str, salt: bytes, iterations: int) -> bytes:
    return hashlib.pbkdf2_hmac(ALGO, password.encode("utf-8"), salt, iterations)


def verify_password(password: str, record: dict) -> bool:
    try:
        salt = bytes.fromhex(str(record.get("salt") or ""))
        expected = str(record.get("hash") or "")
        iterations = int(record.get("iterations") or ITERATIONS)
    except (TypeError, ValueError):
        return False
    if not salt or not expected or not password:
        return False
    actual = _digest(password, salt, iterations).hex()
    return hmac.compare_digest(actual, expected)


def load_users(path: Path | None = None) -> dict:
    users_path = path or USERS_FILE
    if not users_path.exists():
        return {}
    try:
        raw = json.loads(users_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    users = raw.get("users") if isinstance(raw, dict) else raw
    if not isinstance(users, dict):
        return {}
    return {normalize_username(name): value for name, value in users.items() if isinstance(value, dict)}


def save_users(users: dict, path: Path | None = None) -> None:
    users_path = path or USERS_FILE
    users_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"users": users}
    tmp = users_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    tmp.replace(users_path)


def ensure_seed_users(path: Path | None = None) -> dict:
    users_path = path or USERS_FILE
    users = load_users(users_path)
    changed = False
    for name, record in SEED_USERS.items():
        if name not in users:
            users[name] = dict(record)
            changed = True
    if changed or not users_path.exists():
        save_users(users, users_path)
    return users


def check_credentials(username: str, password: str, path: Path | None = None) -> bool:
    users = ensure_seed_users(path)
    record = users.get(normalize_username(username))
    if not record:
        return False
    return verify_password(str(password or ""), record)
