from datetime import datetime, timedelta

import pandas as pd

from marketagent.config import DATA_DIR, MARKET_TZ


def normalize_symbol(symbol: str) -> str:
    if not symbol:
        return ""
    return symbol.strip().upper()


def safe_float(value, default=0.0):
    try:
        if value is None or pd.isna(value):
            return default
        return float(value)
    except Exception:
        return default


def nullable_float(value):
    try:
        if value is None or pd.isna(value):
            return None
        return float(value)
    except Exception:
        return None


def format_price(value) -> str:
    if value is None or pd.isna(value):
        return "N/A"
    return f"${float(value):,.2f}"


def format_signed_price(value) -> str | None:
    if value is None or pd.isna(value):
        return None
    value = float(value)
    return f"+${value:,.2f}" if value >= 0 else f"-${abs(value):,.2f}"


def format_pct(value) -> str:
    if value is None or pd.isna(value):
        return "N/A"
    return f"{float(value):+.2f}%"



def format_volume(value) -> str:
    """Format share volume in a compact, readable way."""
    if value is None or pd.isna(value):
        return "N/A"

    value = float(value)
    abs_value = abs(value)

    if abs_value >= 1_000_000_000:
        return f"{value / 1_000_000_000:.2f}B"
    if abs_value >= 1_000_000:
        return f"{value / 1_000_000:.2f}M"
    if abs_value >= 1_000:
        return f"{value / 1_000:.2f}K"

    return f"{value:,.0f}"

def format_refresh(seconds: int) -> str:
    if seconds >= 3600:
        hours = seconds / 3600
        return "1 hour" if hours == 1 else f"{hours:g} hours"
    if seconds >= 60:
        minutes = seconds / 60
        return "1 min" if minutes == 1 else f"{minutes:g} min"
    return f"{seconds} sec"


def distance_pct(price, level):
    if price is None or level is None or level == 0:
        return None
    return (price - level) / level * 100


def ensure_data_dir():
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def now_et_string() -> str:
    return datetime.now(MARKET_TZ).strftime("%Y-%m-%d %H:%M:%S ET")


def today_et_string() -> str:
    return datetime.now(MARKET_TZ).strftime("%Y-%m-%d")




# ------------------------------------------------------------
# US equity market session helpers (ET)
# ------------------------------------------------------------

def now_et() -> datetime:
    """Return current timezone-aware New York time."""
    return datetime.now(MARKET_TZ)


def _next_weekday_datetime(base_dt: datetime, hour: int, minute: int = 0) -> datetime:
    """Return the next weekday datetime at the requested ET clock time."""
    candidate = base_dt.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if candidate <= base_dt:
        candidate = candidate + timedelta(days=1)

    while candidate.weekday() >= 5:
        candidate = candidate + timedelta(days=1)

    return candidate


def format_duration_until(target_dt, base_dt=None) -> str:
    """Format a compact duration until a target ET datetime."""
    target = parse_datetime_to_et(target_dt)
    base = parse_datetime_to_et(base_dt) or now_et()
    if target is None or base is None:
        return "N/A"

    seconds = max((target - base).total_seconds(), 0)
    if seconds < 60:
        return f"{int(seconds)}s"

    minutes = seconds / 60
    if minutes < 60:
        return f"{minutes:.0f}m"

    hours = minutes / 60
    if hours < 24:
        return f"{hours:.1f}h"

    days = hours / 24
    return f"{days:.1f}d"


def get_us_equity_market_status(value=None) -> dict:
    """Return a lightweight US equity session status in ET.

    This intentionally uses standard US equity trading hours and weekends only.
    It does not attempt to model exchange holidays or half-days; the banner is
    meant to explain normal pre-market/regular/after-hours/closed behavior and
    support quote-staleness logic.
    """
    dt = parse_datetime_to_et(value) or now_et()
    minutes = dt.hour * 60 + dt.minute

    pre_start = 4 * 60
    regular_start = 9 * 60 + 30
    regular_end = 16 * 60
    after_end = 20 * 60

    if dt.weekday() >= 5:
        next_open = _next_weekday_datetime(dt, 4, 0)
        return {
            "key": "weekend_closed",
            "label": "Weekend / Market Closed",
            "session": "Closed",
            "is_open": False,
            "is_regular": False,
            "is_extended": False,
            "is_closed": True,
            "description": "US equities are closed on weekends. Quote updates normally stop until the next trading session.",
            "next_session_label": "Next pre-market",
            "next_session_time_et": next_open,
            "next_session_in": format_duration_until(next_open, dt),
            "stale_threshold_seconds": None,
        }

    if pre_start <= minutes < regular_start:
        end = dt.replace(hour=9, minute=30, second=0, microsecond=0)
        return {
            "key": "pre_market",
            "label": "Pre-market",
            "session": "Extended Hours",
            "is_open": True,
            "is_regular": False,
            "is_extended": True,
            "is_closed": False,
            "description": "Pre-market session is active. Liquidity can be thinner and some symbols may update less frequently.",
            "next_session_label": "Regular open",
            "next_session_time_et": end,
            "next_session_in": format_duration_until(end, dt),
            "stale_threshold_seconds": 300,
        }

    if regular_start <= minutes < regular_end:
        end = dt.replace(hour=16, minute=0, second=0, microsecond=0)
        return {
            "key": "regular_open",
            "label": "Market Open",
            "session": "Regular Hours",
            "is_open": True,
            "is_regular": True,
            "is_extended": False,
            "is_closed": False,
            "description": "Regular US equity session is active.",
            "next_session_label": "Regular close",
            "next_session_time_et": end,
            "next_session_in": format_duration_until(end, dt),
            "stale_threshold_seconds": 120,
        }

    if regular_end <= minutes < after_end:
        end = dt.replace(hour=20, minute=0, second=0, microsecond=0)
        return {
            "key": "after_hours",
            "label": "After-hours",
            "session": "Extended Hours",
            "is_open": True,
            "is_regular": False,
            "is_extended": True,
            "is_closed": False,
            "description": "After-hours session is active. Quotes/trades may be sparse and spreads can be wider.",
            "next_session_label": "After-hours close",
            "next_session_time_et": end,
            "next_session_in": format_duration_until(end, dt),
            "stale_threshold_seconds": 300,
        }

    if minutes < pre_start:
        next_open = dt.replace(hour=4, minute=0, second=0, microsecond=0)
    else:
        next_open = _next_weekday_datetime(dt, 4, 0)

    reason = "US equities are closed. Quote updates normally pause outside 4:00am-8:00pm ET."
    if minutes >= after_end:
        reason = "US equities are closed after the 8:00pm ET extended-hours close. Last quotes near 7:59pm ET are usually normal."

    return {
        "key": "closed",
        "label": "Market Closed",
        "session": "Closed",
        "is_open": False,
        "is_regular": False,
        "is_extended": False,
        "is_closed": True,
        "description": reason,
        "next_session_label": "Next pre-market",
        "next_session_time_et": next_open,
        "next_session_in": format_duration_until(next_open, dt),
        "stale_threshold_seconds": None,
    }


def format_age(seconds) -> str:
    """Format an age in seconds for UI captions."""
    if seconds is None or pd.isna(seconds):
        return "N/A"

    seconds = max(float(seconds), 0.0)

    if seconds < 60:
        return f"{int(seconds)}s ago"

    minutes = seconds / 60
    if minutes < 60:
        return f"{minutes:.1f}m ago"

    hours = minutes / 60
    if hours < 24:
        return f"{hours:.1f}h ago"

    days = hours / 24
    return f"{days:.1f}d ago"

def parse_datetime_to_et(value):
    """Parse common timestamp values and return a timezone-aware ET datetime.

    Handles Alpaca UTC ISO strings ending with Z, pandas timestamps, and strings
    already formatted with an ET suffix. Returns None when parsing fails.
    """
    if value is None or value == "":
        return None

    try:
        if isinstance(value, pd.Timestamp):
            ts = value
            if ts.tzinfo is None:
                ts = ts.tz_localize(MARKET_TZ)
            else:
                ts = ts.tz_convert(MARKET_TZ)
            return ts.to_pydatetime()
    except Exception:
        pass

    try:
        if isinstance(value, datetime):
            dt = value
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=MARKET_TZ)
            return dt.astimezone(MARKET_TZ)
    except Exception:
        pass

    text = str(value).strip()
    if not text or text.upper() in {"N/A", "NONE", "NAN"}:
        return None

    # Existing UI strings like "2026-07-16 19:41:05 ET".
    if text.endswith(" ET"):
        core = text[:-3].strip()
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
            try:
                return datetime.strptime(core, fmt).replace(tzinfo=MARKET_TZ)
            except Exception:
                pass

    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=MARKET_TZ)
        return dt.astimezone(MARKET_TZ)
    except Exception:
        return None


def format_datetime_et(value) -> str:
    """Format a timestamp as ET for display."""
    dt = parse_datetime_to_et(value)
    if dt is None:
        return "N/A"
    return dt.strftime("%Y-%m-%d %H:%M:%S ET")


def is_extended_hours_et(value) -> bool:
    """Return True when an ET timestamp is in pre-market or after-hours.

    This intentionally treats weekdays only; it is a lightweight UI helper for
    Dashboard display logic rather than an exchange holiday calendar.
    """
    dt = parse_datetime_to_et(value)
    if dt is None:
        return False
    if dt.weekday() >= 5:
        return False
    minutes = dt.hour * 60 + dt.minute
    pre_start = 4 * 60
    regular_start = 9 * 60 + 30
    regular_end = 16 * 60
    after_end = 20 * 60
    return (pre_start <= minutes < regular_start) or (regular_end <= minutes <= after_end)

