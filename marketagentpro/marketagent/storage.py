import json
import re
import shutil
from pathlib import Path

import streamlit as st

from marketagent.config import (
    ALPACA_API_KEY,
    ALPACA_DATA_FEED,
    ALPACA_OPTIONS_FEED,
    ALPACA_SECRET_KEY,
    ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL,
    ANTHROPIC_MODEL,
    DEFAULT_AI_PROVIDER,
    DEFAULT_AI_LANGUAGE_MODE,
    DEFAULT_DASHBOARD_AI_MAX_NEWS_ITEMS,
    DEFAULT_DASHBOARD_AI_MODE,
    DEFAULT_DASHBOARD_AI_OUTPUT_LENGTH,
    DEFAULT_AI_STREAMING,
    DEFAULT_OLLAMA_MODEL,
    DEFAULT_OLLAMA_NUM_CTX,
    DEFAULT_OLLAMA_TEMPERATURE,
    DEFAULT_SETTINGS,
    DEFAULT_WATCHLIST,
    DEFAULT_PORTFOLIO_PROFILE_ID,
    DEFAULT_PORTFOLIO_PROFILE_NAME,
    MARKET_DATA_PROVIDER,
    OPENAI_API_KEY,
    OPENAI_BASE_URL,
    OPENAI_MODEL,
    OPTIONS_STRATEGIES_FILE,
    PORTFOLIO_HISTORY_FILE,
    PORTFOLIO_PROFILES_FILE,
    PORTFOLIOS_DIR,
    SETTINGS_FILE,
    TRANSACTIONS_FILE,
)
from marketagent.utils import ensure_data_dir, normalize_symbol, now_et_string, safe_float
from marketagent.options import sanitize_strategy



# ------------------------------------------------------------
# Portfolio profiles
# ------------------------------------------------------------
# v1 keeps the global watchlist / displayed symbols / AI settings shared, while
# stock positions, transactions, portfolio snapshots, and option strategies live
# under each profile folder:
# data/portfolios/<profile_id>/
#   profile_state.json
#   transactions.jsonl
#   portfolio_history.jsonl
#   options_strategies.json

PROFILE_STATE_FILENAME = "profile_state.json"
TRANSACTIONS_FILENAME = "transactions.jsonl"
PORTFOLIO_HISTORY_FILENAME = "portfolio_history.jsonl"
OPTIONS_STRATEGIES_FILENAME = "options_strategies.json"


def _profile_slug(name: str) -> str:
    text = str(name or "").strip().lower()
    text = re.sub(r"[^a-z0-9]+", "_", text).strip("_")
    return text or DEFAULT_PORTFOLIO_PROFILE_ID


def _unique_profile_id(base_name: str, existing_ids: set[str] | None = None) -> str:
    existing_ids = set(existing_ids or [])
    base = _profile_slug(base_name)
    candidate = base
    counter = 2
    while candidate in existing_ids:
        candidate = f"{base}_{counter}"
        counter += 1
    return candidate


def _profile_dir(profile_id: str | None = None) -> Path:
    profile_id = _profile_slug(profile_id or get_active_portfolio_profile_id())
    return PORTFOLIOS_DIR / profile_id


def _profile_file(filename: str, profile_id: str | None = None) -> Path:
    return _profile_dir(profile_id) / filename


def _read_json_file(path: Path, fallback):
    if not path.exists():
        return fallback
    try:
        with open(path, "r", encoding="utf-8") as file:
            return json.load(file)
    except Exception:
        return fallback


def _write_json_file(path: Path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as file:
        json.dump(payload, file, indent=2, ensure_ascii=False)


def get_active_portfolio_profile_id() -> str:
    profile_id = str(st.session_state.get("active_portfolio_profile_id") or "").strip()
    return _profile_slug(profile_id or DEFAULT_PORTFOLIO_PROFILE_ID)


def get_portfolio_profile_files(profile_id: str | None = None) -> dict:
    profile_id = _profile_slug(profile_id or get_active_portfolio_profile_id())
    return {
        "dir": _profile_dir(profile_id),
        "state": _profile_file(PROFILE_STATE_FILENAME, profile_id),
        "transactions": _profile_file(TRANSACTIONS_FILENAME, profile_id),
        "history": _profile_file(PORTFOLIO_HISTORY_FILENAME, profile_id),
        "options": _profile_file(OPTIONS_STRATEGIES_FILENAME, profile_id),
    }


def _load_profiles_index_raw() -> dict:
    payload = _read_json_file(PORTFOLIO_PROFILES_FILE, {})
    if not isinstance(payload, dict):
        return {}
    profiles = payload.get("profiles", [])
    if not isinstance(profiles, list):
        profiles = []
    cleaned = []
    seen = set()
    for item in profiles:
        if not isinstance(item, dict):
            continue
        profile_id = _profile_slug(item.get("id") or item.get("name") or DEFAULT_PORTFOLIO_PROFILE_NAME)
        if profile_id in seen:
            continue
        seen.add(profile_id)
        cleaned.append({
            "id": profile_id,
            "name": str(item.get("name") or profile_id).strip() or profile_id,
            "created_at_et": str(item.get("created_at_et") or now_et_string()),
            "updated_at_et": str(item.get("updated_at_et") or item.get("created_at_et") or now_et_string()),
        })
    return {"profiles": cleaned}


def _save_profiles_index(profiles: list[dict]):
    ensure_data_dir()
    PORTFOLIOS_DIR.mkdir(parents=True, exist_ok=True)
    cleaned = []
    seen = set()
    for item in profiles or []:
        if not isinstance(item, dict):
            continue
        profile_id = _profile_slug(item.get("id") or item.get("name"))
        if not profile_id or profile_id in seen:
            continue
        seen.add(profile_id)
        cleaned.append({
            "id": profile_id,
            "name": str(item.get("name") or profile_id).strip() or profile_id,
            "created_at_et": str(item.get("created_at_et") or now_et_string()),
            "updated_at_et": str(item.get("updated_at_et") or now_et_string()),
        })
    if not cleaned:
        cleaned = [{
            "id": DEFAULT_PORTFOLIO_PROFILE_ID,
            "name": DEFAULT_PORTFOLIO_PROFILE_NAME,
            "created_at_et": now_et_string(),
            "updated_at_et": now_et_string(),
        }]
    _write_json_file(PORTFOLIO_PROFILES_FILE, {"profiles": cleaned, "updated_at_et": now_et_string()})


def _copy_legacy_file_once(source: Path, destination: Path):
    if destination.exists() or not source.exists():
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        shutil.copy2(source, destination)
    except Exception:
        pass


def _migrate_legacy_default_profile():
    """Create the default profile from legacy data files, without deleting them."""
    ensure_data_dir()
    PORTFOLIOS_DIR.mkdir(parents=True, exist_ok=True)
    files = get_portfolio_profile_files(DEFAULT_PORTFOLIO_PROFILE_ID)
    files["dir"].mkdir(parents=True, exist_ok=True)

    _copy_legacy_file_once(TRANSACTIONS_FILE, files["transactions"])
    _copy_legacy_file_once(PORTFOLIO_HISTORY_FILE, files["history"])
    _copy_legacy_file_once(OPTIONS_STRATEGIES_FILE, files["options"])

    if not files["state"].exists():
        legacy_settings = _read_json_file(SETTINGS_FILE, {})
        legacy_positions = sanitize_positions(legacy_settings.get("positions", {})) if isinstance(legacy_settings, dict) else {}
        state = {
            "positions": legacy_positions,
            "last_auto_snapshot_date": str(legacy_settings.get("last_auto_snapshot_date", "")) if isinstance(legacy_settings, dict) else "",
            "created_at_et": now_et_string(),
            "updated_at_et": now_et_string(),
        }
        _write_json_file(files["state"], state)


def ensure_portfolio_profiles() -> list[dict]:
    """Ensure profile metadata and default profile files exist; return profiles."""
    _migrate_legacy_default_profile()
    raw = _load_profiles_index_raw()
    profiles = raw.get("profiles", [])
    if not any(item.get("id") == DEFAULT_PORTFOLIO_PROFILE_ID for item in profiles):
        profiles.insert(0, {
            "id": DEFAULT_PORTFOLIO_PROFILE_ID,
            "name": DEFAULT_PORTFOLIO_PROFILE_NAME,
            "created_at_et": now_et_string(),
            "updated_at_et": now_et_string(),
        })
    _save_profiles_index(profiles)
    for profile in profiles:
        files = get_portfolio_profile_files(profile.get("id"))
        files["dir"].mkdir(parents=True, exist_ok=True)
        if not files["state"].exists():
            _write_json_file(files["state"], {"positions": {}, "last_auto_snapshot_date": "", "created_at_et": now_et_string(), "updated_at_et": now_et_string()})
    return list_portfolio_profiles()


def list_portfolio_profiles() -> list[dict]:
    raw = _load_profiles_index_raw()
    profiles = raw.get("profiles", [])
    if not profiles:
        profiles = [{
            "id": DEFAULT_PORTFOLIO_PROFILE_ID,
            "name": DEFAULT_PORTFOLIO_PROFILE_NAME,
            "created_at_et": now_et_string(),
            "updated_at_et": now_et_string(),
        }]
    return sorted(profiles, key=lambda item: (0 if item.get("id") == DEFAULT_PORTFOLIO_PROFILE_ID else 1, str(item.get("name", "")).lower()))


def get_portfolio_profile_name(profile_id: str | None = None) -> str:
    profile_id = _profile_slug(profile_id or get_active_portfolio_profile_id())
    for profile in list_portfolio_profiles():
        if profile.get("id") == profile_id:
            return str(profile.get("name") or profile_id)
    return profile_id


def load_portfolio_profile_state(profile_id: str | None = None) -> dict:
    ensure_portfolio_profiles()
    files = get_portfolio_profile_files(profile_id)
    state = _read_json_file(files["state"], {})
    if not isinstance(state, dict):
        state = {}
    return {
        "positions": sanitize_positions(state.get("positions", {})),
        "last_auto_snapshot_date": str(state.get("last_auto_snapshot_date", "")),
    }


def save_portfolio_profile_state(profile_id: str | None = None, *, positions: dict | None = None, last_auto_snapshot_date: str | None = None):
    profile_id = _profile_slug(profile_id or get_active_portfolio_profile_id())
    files = get_portfolio_profile_files(profile_id)
    current = _read_json_file(files["state"], {})
    if not isinstance(current, dict):
        current = {}
    if positions is not None:
        current["positions"] = sanitize_positions(positions)
    if last_auto_snapshot_date is not None:
        current["last_auto_snapshot_date"] = str(last_auto_snapshot_date or "")
    current.setdefault("created_at_et", now_et_string())
    current["updated_at_et"] = now_et_string()
    _write_json_file(files["state"], current)


def switch_portfolio_profile(profile_id: str):
    ensure_portfolio_profiles()
    profile_id = _profile_slug(profile_id)
    # Save the currently active profile before switching away.
    if "positions" in st.session_state:
        save_portfolio_profile_state(
            get_active_portfolio_profile_id(),
            positions=st.session_state.positions,
            last_auto_snapshot_date=st.session_state.get("last_auto_snapshot_date", ""),
        )

    st.session_state.active_portfolio_profile_id = profile_id
    state = load_portfolio_profile_state(profile_id)
    st.session_state.positions = state["positions"]
    st.session_state.last_auto_snapshot_date = state.get("last_auto_snapshot_date", "")
    st.session_state.option_strategies = load_option_strategies()
    st.session_state.pop("realized_pl_rows_cache", None)
    st.session_state.pop("last_realized_pl_cache_key", None)
    save_app_settings()


def create_portfolio_profile(name: str, *, duplicate_from_active: bool = False) -> tuple[bool, str, str]:
    name = str(name or "").strip()
    if not name:
        return False, "Profile name is required.", ""
    profiles = ensure_portfolio_profiles()
    existing_ids = {item.get("id") for item in profiles}
    profile_id = _unique_profile_id(name, existing_ids)
    profile = {"id": profile_id, "name": name, "created_at_et": now_et_string(), "updated_at_et": now_et_string()}
    profiles.append(profile)
    _save_profiles_index(profiles)

    files = get_portfolio_profile_files(profile_id)
    files["dir"].mkdir(parents=True, exist_ok=True)
    if duplicate_from_active:
        active_files = get_portfolio_profile_files(get_active_portfolio_profile_id())
        for key in ["transactions", "history", "options", "state"]:
            _copy_legacy_file_once(active_files[key], files[key])
    if not files["state"].exists():
        _write_json_file(files["state"], {"positions": {}, "last_auto_snapshot_date": "", "created_at_et": now_et_string(), "updated_at_et": now_et_string()})
    if not files["options"].exists():
        _write_json_file(files["options"], [])
    return True, f"Created portfolio profile: {name}", profile_id


def rename_portfolio_profile(profile_id: str, new_name: str) -> tuple[bool, str]:
    profile_id = _profile_slug(profile_id)
    new_name = str(new_name or "").strip()
    if not new_name:
        return False, "Profile name is required."
    profiles = ensure_portfolio_profiles()
    changed = False
    for profile in profiles:
        if profile.get("id") == profile_id:
            profile["name"] = new_name
            profile["updated_at_et"] = now_et_string()
            changed = True
            break
    if not changed:
        return False, "Profile not found."
    _save_profiles_index(profiles)
    return True, f"Renamed profile to: {new_name}"


def delete_portfolio_profile(profile_id: str) -> tuple[bool, str]:
    profile_id = _profile_slug(profile_id)
    if profile_id == DEFAULT_PORTFOLIO_PROFILE_ID:
        return False, "Default Portfolio cannot be deleted."
    profiles = ensure_portfolio_profiles()
    remaining = [profile for profile in profiles if profile.get("id") != profile_id]
    if len(remaining) == len(profiles):
        return False, "Profile not found."
    _save_profiles_index(remaining)
    try:
        shutil.rmtree(_profile_dir(profile_id), ignore_errors=True)
    except Exception:
        pass
    if get_active_portfolio_profile_id() == profile_id:
        switch_portfolio_profile(DEFAULT_PORTFOLIO_PROFILE_ID)
    return True, "Deleted portfolio profile."

def get_default_position() -> dict:
    return {
        "shares": 0.0,
        "cost": 0.0,
        "alert_above": 0.0,
        "alert_below": 0.0,
        "pnl_warning_pct": 5.0,
    }


def sanitize_positions(raw_positions: dict) -> dict:
    if not isinstance(raw_positions, dict):
        return {}

    cleaned = {}
    for symbol, position in raw_positions.items():
        symbol = normalize_symbol(symbol)
        if not symbol or not isinstance(position, dict):
            continue

        cleaned[symbol] = {
            "shares": safe_float(position.get("shares"), 0.0),
            "cost": safe_float(position.get("cost"), 0.0),
            "alert_above": safe_float(position.get("alert_above"), 0.0),
            "alert_below": safe_float(position.get("alert_below"), 0.0),
            "pnl_warning_pct": safe_float(position.get("pnl_warning_pct"), 5.0),
        }

    return cleaned




def sanitize_ai_settings(raw_settings: dict | None) -> dict:
    if not isinstance(raw_settings, dict):
        raw_settings = {}

    provider = str(raw_settings.get("provider") or DEFAULT_AI_PROVIDER or "off").strip().lower()
    if provider in {"none", "disabled", "disable", "no_ai", "no-ai"}:
        provider = "off"
    if provider in {"ollama local", "ollama_local", "local"}:
        provider = "ollama"
    if provider in {"gpt", "chatgpt", "openai_api"}:
        provider = "openai"
    if provider in {"claude", "anthropic_api"}:
        provider = "anthropic"
    if provider not in {"off", "ollama", "openai", "anthropic"}:
        provider = "off"

    language_mode = str(raw_settings.get("language_mode") or DEFAULT_AI_LANGUAGE_MODE or "english_only").strip().lower()
    if language_mode in {"english", "en", "source", "source_only"}:
        language_mode = "english_only"
    if language_mode in {"zh", "chinese_summary"}:
        language_mode = "chinese"
    if language_mode not in {"english_only", "chinese", "bilingual"}:
        language_mode = "english_only"

    model = str(raw_settings.get("ollama_model") or DEFAULT_OLLAMA_MODEL).strip() or DEFAULT_OLLAMA_MODEL

    try:
        num_ctx = int(raw_settings.get("ollama_num_ctx", DEFAULT_OLLAMA_NUM_CTX))
    except Exception:
        num_ctx = DEFAULT_OLLAMA_NUM_CTX

    allowed_ctx = [2048, 4096, 8192, 16384, 32768, 65536]
    if num_ctx not in allowed_ctx:
        # Keep custom values within a reasonable range, but default if clearly invalid.
        if num_ctx < 1024 or num_ctx > 131072:
            num_ctx = DEFAULT_OLLAMA_NUM_CTX

    try:
        temperature = float(raw_settings.get("ollama_temperature", DEFAULT_OLLAMA_TEMPERATURE))
    except Exception:
        temperature = DEFAULT_OLLAMA_TEMPERATURE
    temperature = max(0.0, min(float(temperature), 1.5))

    dashboard_ai_mode = str(raw_settings.get("dashboard_ai_mode") or DEFAULT_DASHBOARD_AI_MODE or "balanced").strip().lower()
    if dashboard_ai_mode not in {"fast", "balanced", "detailed"}:
        dashboard_ai_mode = "balanced"

    ai_streaming = str(raw_settings.get("ai_streaming") or DEFAULT_AI_STREAMING or "auto").strip().lower()
    if ai_streaming in {"true", "yes", "1"}:
        ai_streaming = "on"
    if ai_streaming in {"false", "no", "0"}:
        ai_streaming = "off"
    if ai_streaming not in {"auto", "on", "off"}:
        ai_streaming = "auto"

    try:
        max_news_items = int(raw_settings.get("dashboard_max_news_items", DEFAULT_DASHBOARD_AI_MAX_NEWS_ITEMS))
    except Exception:
        max_news_items = DEFAULT_DASHBOARD_AI_MAX_NEWS_ITEMS
    if max_news_items not in {3, 5, 8}:
        max_news_items = 5

    output_length = str(raw_settings.get("dashboard_output_length") or DEFAULT_DASHBOARD_AI_OUTPUT_LENGTH or "medium").strip().lower()
    if output_length not in {"short", "medium", "long"}:
        output_length = "medium"

    openai_api_key = str(raw_settings.get("openai_api_key") or OPENAI_API_KEY or "").strip()
    openai_model = str(raw_settings.get("openai_model") or OPENAI_MODEL or "gpt-4o-mini").strip() or "gpt-4o-mini"
    openai_base_url = str(raw_settings.get("openai_base_url") or OPENAI_BASE_URL or "https://api.openai.com/v1").strip().rstrip("/")

    anthropic_api_key = str(raw_settings.get("anthropic_api_key") or ANTHROPIC_API_KEY or "").strip()
    anthropic_model = str(raw_settings.get("anthropic_model") or ANTHROPIC_MODEL or "claude-3-5-sonnet-latest").strip() or "claude-3-5-sonnet-latest"
    anthropic_base_url = str(raw_settings.get("anthropic_base_url") or ANTHROPIC_BASE_URL or "https://api.anthropic.com/v1").strip().rstrip("/")

    return {
        "provider": provider,
        "language_mode": language_mode,
        "ollama_model": model,
        "ollama_num_ctx": num_ctx,
        "ollama_temperature": temperature,
        "openai_api_key": openai_api_key,
        "openai_model": openai_model,
        "openai_base_url": openai_base_url,
        "anthropic_api_key": anthropic_api_key,
        "anthropic_model": anthropic_model,
        "anthropic_base_url": anthropic_base_url,
        "dashboard_ai_mode": dashboard_ai_mode,
        "ai_streaming": ai_streaming,
        "dashboard_max_news_items": max_news_items,
        "dashboard_output_length": output_length,
    }


def sanitize_api_settings(raw_settings: dict | None) -> dict:
    """Normalize user-provided market data / Alpaca API settings (BYOK).

    Empty values fall back to environment / .env defaults so the app keeps
    working when a demo user has not entered anything yet. Keys are stored in
    the local settings file only (data/ is gitignored).
    """
    if not isinstance(raw_settings, dict):
        raw_settings = {}

    provider = str(
        raw_settings.get("market_data_provider") or MARKET_DATA_PROVIDER or "yfinance"
    ).strip().lower()
    if provider not in {"yfinance", "alpaca"}:
        provider = "yfinance"

    api_key = str(raw_settings.get("alpaca_api_key") or ALPACA_API_KEY or "").strip()
    secret_key = str(raw_settings.get("alpaca_secret_key") or ALPACA_SECRET_KEY or "").strip()

    data_feed = str(
        raw_settings.get("alpaca_data_feed") or ALPACA_DATA_FEED or "iex"
    ).strip().lower()
    if data_feed not in {"iex", "sip"}:
        data_feed = "iex"

    options_feed = str(
        raw_settings.get("alpaca_options_feed") or ALPACA_OPTIONS_FEED or "indicative"
    ).strip().lower()
    if options_feed not in {"indicative", "opra"}:
        options_feed = "indicative"

    return {
        "market_data_provider": provider,
        "alpaca_api_key": api_key,
        "alpaca_secret_key": secret_key,
        "alpaca_data_feed": data_feed,
        "alpaca_options_feed": options_feed,
    }


def load_app_settings() -> dict:
    if not SETTINGS_FILE.exists():
        return DEFAULT_SETTINGS.copy()

    try:
        with open(SETTINGS_FILE, "r", encoding="utf-8") as file:
            settings = json.load(file)

        watchlist = [
            normalize_symbol(symbol)
            for symbol in settings.get("watchlist", DEFAULT_WATCHLIST.copy())
            if normalize_symbol(symbol)
        ]
        watchlist = sorted(list(dict.fromkeys(watchlist)))

        display_symbols = [
            normalize_symbol(symbol)
            for symbol in settings.get("display_symbols", [])
            if normalize_symbol(symbol) in watchlist
        ]

        return {
            "watchlist": watchlist,
            "display_symbols": display_symbols,
            "positions": sanitize_positions(settings.get("positions", {})),  # legacy fallback only
            "last_auto_snapshot_date": settings.get("last_auto_snapshot_date", ""),  # legacy fallback only
            "active_portfolio_profile_id": settings.get("active_portfolio_profile_id", DEFAULT_PORTFOLIO_PROFILE_ID),
            "ai_settings": sanitize_ai_settings(settings.get("ai_settings", {})),
            "api_settings": sanitize_api_settings(settings.get("api_settings", {})),
        }
    except Exception:
        return DEFAULT_SETTINGS.copy()


def save_app_settings():
    ensure_data_dir()
    # Save active-profile state separately before writing global settings.
    if "positions" in st.session_state:
        save_portfolio_profile_state(
            get_active_portfolio_profile_id(),
            positions=st.session_state.positions,
            last_auto_snapshot_date=st.session_state.get("last_auto_snapshot_date", ""),
        )

    settings = {
        "watchlist": st.session_state.watchlist,
        "display_symbols": st.session_state.display_symbols,
        "active_portfolio_profile_id": get_active_portfolio_profile_id(),
        # Legacy fallback copies are kept for compatibility with older packages.
        "positions": sanitize_positions(st.session_state.get("positions", {})),
        "last_auto_snapshot_date": st.session_state.get("last_auto_snapshot_date", ""),
        "ai_settings": sanitize_ai_settings(st.session_state.get("ai_settings", {})),
        "api_settings": sanitize_api_settings(st.session_state.get("api_settings", {})),
        "last_saved_et": now_et_string(),
    }
    with open(SETTINGS_FILE, "w", encoding="utf-8") as file:
        json.dump(settings, file, indent=2)


def init_session_state():
    if "settings_loaded" not in st.session_state:
        settings = load_app_settings()
        st.session_state.watchlist = settings["watchlist"]
        st.session_state.display_symbols = settings["display_symbols"]
        ensure_portfolio_profiles()
        profile_id = settings.get("active_portfolio_profile_id", DEFAULT_PORTFOLIO_PROFILE_ID)
        st.session_state.active_portfolio_profile_id = _profile_slug(profile_id)
        profile_state = load_portfolio_profile_state(st.session_state.active_portfolio_profile_id)
        # Use per-profile state first. If the profile is empty but legacy settings had positions,
        # keep the legacy fallback during the first migration.
        st.session_state.positions = profile_state.get("positions") or settings.get("positions", {})
        st.session_state.last_auto_snapshot_date = profile_state.get("last_auto_snapshot_date") or settings.get("last_auto_snapshot_date", "")
        st.session_state.ai_settings = sanitize_ai_settings(settings.get("ai_settings", {}))
        st.session_state.api_settings = sanitize_api_settings(settings.get("api_settings", {}))
        st.session_state.settings_loaded = True

    if "ai_settings" not in st.session_state:
        st.session_state.ai_settings = sanitize_ai_settings({})

    if "api_settings" not in st.session_state:
        st.session_state.api_settings = sanitize_api_settings({})

    if "ai_summary_by_symbol" not in st.session_state:
        st.session_state.ai_summary_by_symbol = {}

    if "last_ai_risk_key_by_symbol" not in st.session_state:
        st.session_state.last_ai_risk_key_by_symbol = {}

    if "ai_summary_meta_by_symbol" not in st.session_state:
        st.session_state.ai_summary_meta_by_symbol = {}

    if "latest_quote_cache" not in st.session_state:
        st.session_state.latest_quote_cache = {}

    if "option_snapshot_cache" not in st.session_state:
        st.session_state.option_snapshot_cache = {}

    if "active_portfolio_profile_id" not in st.session_state:
        st.session_state.active_portfolio_profile_id = DEFAULT_PORTFOLIO_PROFILE_ID

    if "option_strategies" not in st.session_state:
        st.session_state.option_strategies = load_option_strategies()


def load_jsonl(file_path: Path) -> list:
    if not file_path.exists():
        return []

    rows = []
    try:
        with open(file_path, "r", encoding="utf-8") as file:
            for line in file:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except Exception:
                    continue
        return rows
    except Exception:
        return []


def append_jsonl(file_path: Path, record: dict):
    ensure_data_dir()
    file_path.parent.mkdir(parents=True, exist_ok=True)
    with open(file_path, "a", encoding="utf-8") as file:
        file.write(json.dumps(record, ensure_ascii=False) + "\n")


def load_transactions() -> list:
    return load_jsonl(get_portfolio_profile_files()["transactions"])


def append_transaction(transaction: dict):
    append_jsonl(get_portfolio_profile_files()["transactions"], transaction)


def save_transactions(transactions: list):
    """Overwrite the active profile's local stock transaction history JSONL file."""
    ensure_data_dir()
    file_path = get_portfolio_profile_files()["transactions"]
    file_path.parent.mkdir(parents=True, exist_ok=True)
    with open(file_path, "w", encoding="utf-8") as file:
        for transaction in transactions or []:
            if isinstance(transaction, dict):
                file.write(json.dumps(transaction, ensure_ascii=False) + "\n")


def load_portfolio_history() -> list:
    return load_jsonl(get_portfolio_profile_files()["history"])


def append_portfolio_history(snapshot: dict):
    append_jsonl(get_portfolio_profile_files()["history"], snapshot)


def load_option_strategies() -> list:
    file_path = get_portfolio_profile_files()["options"]
    if not file_path.exists():
        return []

    try:
        with open(file_path, "r", encoding="utf-8") as file:
            data = json.load(file)
        if not isinstance(data, list):
            return []

        strategies = []
        for raw_strategy in data:
            strategy = sanitize_strategy(raw_strategy)
            if strategy is not None:
                strategies.append(strategy)
        return strategies
    except Exception:
        return []


def save_option_strategies(strategies: list):
    ensure_data_dir()
    cleaned = []
    for raw_strategy in strategies or []:
        strategy = sanitize_strategy(raw_strategy)
        if strategy is not None:
            cleaned.append(strategy)

    file_path = get_portfolio_profile_files()["options"]
    file_path.parent.mkdir(parents=True, exist_ok=True)
    with open(file_path, "w", encoding="utf-8") as file:
        json.dump(cleaned, file, indent=2, ensure_ascii=False)
