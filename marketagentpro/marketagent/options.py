import uuid
from copy import deepcopy
from datetime import date, datetime

import pandas as pd

from marketagent.config import DEFAULT_OPTIONS_PROFIT_TARGET_PCT
from marketagent.utils import normalize_symbol, now_et_string, nullable_float, safe_float

OPTION_ACTIONS = ["Buy", "Sell"]
OPTION_TYPES = ["Call", "Put"]
STRATEGY_TYPES = [
    "Long Call",
    "Long Put",
    "Short Call",
    "Short Put",
    "Covered Call",
    "Cash Secured Put",
    "Bull Call Spread",
    "Bear Put Spread",
    "Put Credit Spread",
    "Call Credit Spread",
    "Credit Spread",
    "Debit Spread",
    "Iron Condor",
    "Straddle / Strangle",
    "Custom",
]

BUILDER_OUTLOOKS = ["Neutral", "Bullish", "Bearish"]
BUILDER_STRATEGY_TYPE_BY_OUTLOOK = {
    "Neutral": "Iron Condor",
    "Bullish": "Put Credit Spread",
    "Bearish": "Call Credit Spread",
}


def empty_strategy() -> dict:
    return {
        "id": str(uuid.uuid4()),
        "created_at_et": now_et_string(),
        "updated_at_et": now_et_string(),
        "name": "",
        "underlying": "",
        "strategy_type": "Custom",
        "expiration": "",
        "profit_target_pct": DEFAULT_OPTIONS_PROFIT_TARGET_PCT,
        "notes": "",
        "status": "Open",
        "closed_at_et": "",
        "close_fees": 0.0,
        "close_notes": "",
        "closed_profit_progress_pct": None,
        "legs": [],
    }


def parse_expiration_date(expiration) -> date | None:
    """Parse an expiration value into a date object when possible."""
    if isinstance(expiration, date) and not isinstance(expiration, datetime):
        return expiration

    if isinstance(expiration, datetime):
        return expiration.date()

    text = str(expiration or "").strip()
    if not text:
        return None

    for fmt in ["%Y-%m-%d", "%m/%d/%Y", "%Y/%m/%d"]:
        try:
            return datetime.strptime(text, fmt).date()
        except Exception:
            continue

    return None


def build_option_contract_symbol(
    underlying: str,
    expiration,
    option_type: str,
    strike,
) -> str:
    """Build an OCC-style option contract symbol used by Alpaca.

    Example: MU + 2026-07-17 + Call + 170 -> MU260717C00170000
    """
    underlying = normalize_symbol(underlying)
    expiration_date = parse_expiration_date(expiration)
    option_type = str(option_type or "").strip().title()
    strike = safe_float(strike, 0.0)

    if not underlying or expiration_date is None or option_type not in OPTION_TYPES or strike <= 0:
        return ""

    yy = expiration_date.strftime("%y")
    mmdd = expiration_date.strftime("%m%d")
    call_put_code = "C" if option_type == "Call" else "P"
    strike_code = int(round(strike * 1000))

    return f"{underlying}{yy}{mmdd}{call_put_code}{strike_code:08d}"


def round_strike_to_increment(value, increment=1.0) -> float:
    """Round a generated strike to the nearest valid-looking increment."""
    value = safe_float(value, 0.0)
    increment = safe_float(increment, 1.0)
    if value <= 0:
        return 0.0
    if increment <= 0:
        increment = 1.0
    return round(round(value / increment) * increment, 2)


def _ensure_ordered_put_wing(short_put: float, wing_width: float, strike_increment: float) -> tuple[float, float]:
    short_put = round_strike_to_increment(short_put, strike_increment)
    long_put = round_strike_to_increment(short_put - wing_width, strike_increment)
    if long_put <= 0:
        long_put = round_strike_to_increment(max(short_put - strike_increment, strike_increment), strike_increment)
    if long_put >= short_put:
        long_put = round_strike_to_increment(short_put - strike_increment, strike_increment)
    return long_put, short_put


def _ensure_ordered_call_wing(short_call: float, wing_width: float, strike_increment: float) -> tuple[float, float]:
    short_call = round_strike_to_increment(short_call, strike_increment)
    long_call = round_strike_to_increment(short_call + wing_width, strike_increment)
    if long_call <= short_call:
        long_call = round_strike_to_increment(short_call + strike_increment, strike_increment)
    return short_call, long_call


def build_strategy_candidate_legs(
    *,
    underlying_price,
    outlook: str,
    short_distance_pct=5.0,
    wing_width=10.0,
    contracts=1.0,
    strike_increment=1.0,
) -> list[dict]:
    """Generate simple option strategy legs from current stock price.

    This is a rules-based builder, not a trade recommendation. v1 uses price
    percentage and wing width. A future v2 can use option-chain delta.
    """
    price = safe_float(underlying_price, 0.0)
    short_distance_pct = max(safe_float(short_distance_pct, 5.0), 0.0)
    wing_width = max(safe_float(wing_width, 10.0), safe_float(strike_increment, 1.0))
    contracts = max(safe_float(contracts, 1.0), 0.0)
    strike_increment = max(safe_float(strike_increment, 1.0), 0.01)
    outlook = str(outlook or "Neutral").strip().title()

    if price <= 0 or contracts <= 0:
        return []

    lower_short_raw = price * (1 - short_distance_pct / 100)
    upper_short_raw = price * (1 + short_distance_pct / 100)

    if outlook == "Bullish":
        long_put, short_put = _ensure_ordered_put_wing(lower_short_raw, wing_width, strike_increment)
        return [
            {"action": "Sell", "option_type": "Put", "strike": short_put, "contracts": contracts, "entry_premium": 0.0, "current_premium": 0.0},
            {"action": "Buy", "option_type": "Put", "strike": long_put, "contracts": contracts, "entry_premium": 0.0, "current_premium": 0.0},
        ]

    if outlook == "Bearish":
        short_call, long_call = _ensure_ordered_call_wing(upper_short_raw, wing_width, strike_increment)
        return [
            {"action": "Sell", "option_type": "Call", "strike": short_call, "contracts": contracts, "entry_premium": 0.0, "current_premium": 0.0},
            {"action": "Buy", "option_type": "Call", "strike": long_call, "contracts": contracts, "entry_premium": 0.0, "current_premium": 0.0},
        ]

    long_put, short_put = _ensure_ordered_put_wing(lower_short_raw, wing_width, strike_increment)
    short_call, long_call = _ensure_ordered_call_wing(upper_short_raw, wing_width, strike_increment)
    return [
        {"action": "Buy", "option_type": "Put", "strike": long_put, "contracts": contracts, "entry_premium": 0.0, "current_premium": 0.0},
        {"action": "Sell", "option_type": "Put", "strike": short_put, "contracts": contracts, "entry_premium": 0.0, "current_premium": 0.0},
        {"action": "Sell", "option_type": "Call", "strike": short_call, "contracts": contracts, "entry_premium": 0.0, "current_premium": 0.0},
        {"action": "Buy", "option_type": "Call", "strike": long_call, "contracts": contracts, "entry_premium": 0.0, "current_premium": 0.0},
    ]


def build_strategy_candidate(
    *,
    underlying: str,
    underlying_price,
    outlook: str,
    expiration,
    short_distance_pct=5.0,
    wing_width=10.0,
    contracts=1.0,
    strike_increment=1.0,
    profit_target_pct=None,
    name: str | None = None,
    notes: str | None = None,
) -> dict:
    underlying = normalize_symbol(underlying)
    outlook = str(outlook or "Neutral").strip().title()
    strategy_type = BUILDER_STRATEGY_TYPE_BY_OUTLOOK.get(outlook, "Custom")
    expiration_text = str(expiration or "").strip()
    target_pct = DEFAULT_OPTIONS_PROFIT_TARGET_PCT if profit_target_pct is None else safe_float(profit_target_pct, DEFAULT_OPTIONS_PROFIT_TARGET_PCT)

    strategy = empty_strategy()
    strategy["name"] = (name or f"{underlying} {strategy_type} {expiration_text}").strip()
    strategy["underlying"] = underlying
    strategy["strategy_type"] = strategy_type
    strategy["expiration"] = expiration_text
    strategy["profit_target_pct"] = target_pct
    strategy["notes"] = (notes or f"Builder candidate. Outlook={outlook}; underlying price={safe_float(underlying_price, 0.0):.2f}; short distance={short_distance_pct}%; width={wing_width}.").strip()
    strategy["legs"] = build_strategy_candidate_legs(
        underlying_price=underlying_price,
        outlook=outlook,
        short_distance_pct=short_distance_pct,
        wing_width=wing_width,
        contracts=contracts,
        strike_increment=strike_increment,
    )
    return sanitize_strategy(strategy) or strategy


def select_open_premium_for_leg(leg: dict, snapshot: dict) -> tuple[float | None, str]:
    """Select an estimated opening premium.

    Conservative open logic:
    - Buy option: opening means buying, so prefer ask.
    - Sell option: opening means selling, so prefer bid.
    Fallback to latest trade, then mid, then the opposite quote side.
    """
    leg = sanitize_option_leg(leg)
    snapshot = snapshot or {}
    bid = snapshot.get("bid")
    ask = snapshot.get("ask")
    last = snapshot.get("last")
    mid = snapshot.get("mid")

    if leg.get("action") == "Sell":
        premium = _first_valid_price(bid, last, mid, ask)
        if premium == _first_valid_price(bid):
            return premium, "short_bid_to_open"
        if premium == _first_valid_price(last):
            return premium, "short_last_trade_open_fallback"
        if premium == _first_valid_price(mid):
            return premium, "short_mid_open_fallback"
        if premium == _first_valid_price(ask):
            return premium, "short_ask_open_fallback"
        return None, "short_open_unavailable"

    premium = _first_valid_price(ask, last, mid, bid)
    if premium == _first_valid_price(ask):
        return premium, "long_ask_to_open"
    if premium == _first_valid_price(last):
        return premium, "long_last_trade_open_fallback"
    if premium == _first_valid_price(mid):
        return premium, "long_mid_open_fallback"
    if premium == _first_valid_price(bid):
        return premium, "long_bid_open_fallback"
    return None, "long_open_unavailable"


def _sanitize_optional_float(value):
    parsed = nullable_float(value)
    return parsed if parsed is not None else None


def sanitize_option_leg(raw_leg: dict) -> dict:
    if not isinstance(raw_leg, dict):
        raw_leg = {}

    action = str(raw_leg.get("action", "Buy")).strip().title()
    if action not in OPTION_ACTIONS:
        action = "Buy"

    option_type = str(raw_leg.get("option_type", "Call")).strip().title()
    if option_type not in OPTION_TYPES:
        option_type = "Call"

    contracts = safe_float(raw_leg.get("contracts"), 1.0)
    strike = safe_float(raw_leg.get("strike"), 0.0)
    entry_premium = safe_float(raw_leg.get("entry_premium"), 0.0)
    current_premium = raw_leg.get("current_premium", entry_premium)
    current_premium = safe_float(current_premium, entry_premium)

    greeks = raw_leg.get("greeks", {})
    if not isinstance(greeks, dict):
        greeks = {}

    return {
        "id": str(raw_leg.get("id") or uuid.uuid4()),
        "action": action,
        "option_type": option_type,
        "strike": strike,
        "contracts": max(contracts, 0.0),
        "entry_premium": max(entry_premium, 0.0),
        "current_premium": max(current_premium, 0.0),
        "close_premium": _sanitize_optional_float(raw_leg.get("close_premium")),
        "close_price_method": str(raw_leg.get("close_price_method", "")).strip(),
        "note": str(raw_leg.get("note", "")).strip(),
        "contract_symbol": normalize_symbol(raw_leg.get("contract_symbol", "")),
        "bid": _sanitize_optional_float(raw_leg.get("bid")),
        "ask": _sanitize_optional_float(raw_leg.get("ask")),
        "mid": _sanitize_optional_float(raw_leg.get("mid")),
        "last": _sanitize_optional_float(raw_leg.get("last")),
        "implied_volatility": _sanitize_optional_float(raw_leg.get("implied_volatility")),
        "delta": _sanitize_optional_float(raw_leg.get("delta", greeks.get("delta"))),
        "gamma": _sanitize_optional_float(raw_leg.get("gamma", greeks.get("gamma"))),
        "theta": _sanitize_optional_float(raw_leg.get("theta", greeks.get("theta"))),
        "vega": _sanitize_optional_float(raw_leg.get("vega", greeks.get("vega"))),
        "rho": _sanitize_optional_float(raw_leg.get("rho", greeks.get("rho"))),
        "option_price_method": str(raw_leg.get("option_price_method", "manual")).strip() or "manual",
        "option_snapshot_status": str(raw_leg.get("option_snapshot_status", "manual")).strip() or "manual",
        "option_snapshot_source": str(raw_leg.get("option_snapshot_source", "")).strip(),
        "option_snapshot_feed": str(raw_leg.get("option_snapshot_feed", "")).strip(),
        "option_quote_timestamp": raw_leg.get("option_quote_timestamp"),
        "option_trade_timestamp": raw_leg.get("option_trade_timestamp"),
        "option_snapshot_updated_at_et": raw_leg.get("option_snapshot_updated_at_et"),
        "option_error": raw_leg.get("option_error"),
    }


def sanitize_strategy(raw_strategy: dict) -> dict | None:
    if not isinstance(raw_strategy, dict):
        return None

    strategy = empty_strategy()
    strategy["id"] = str(raw_strategy.get("id") or uuid.uuid4())
    strategy["created_at_et"] = str(raw_strategy.get("created_at_et") or now_et_string())
    strategy["updated_at_et"] = str(raw_strategy.get("updated_at_et") or strategy["created_at_et"])
    strategy["name"] = str(raw_strategy.get("name", "")).strip()
    strategy["underlying"] = normalize_symbol(raw_strategy.get("underlying", ""))

    strategy_type = str(raw_strategy.get("strategy_type", "Custom")).strip()
    strategy["strategy_type"] = strategy_type if strategy_type in STRATEGY_TYPES else "Custom"

    strategy["expiration"] = str(raw_strategy.get("expiration", "")).strip()
    strategy["profit_target_pct"] = safe_float(
        raw_strategy.get("profit_target_pct"),
        DEFAULT_OPTIONS_PROFIT_TARGET_PCT,
    )
    strategy["notes"] = str(raw_strategy.get("notes", "")).strip()

    raw_status = str(raw_strategy.get("status", "Open")).strip().title()
    strategy["status"] = "Closed" if raw_status == "Closed" else "Open"
    strategy["closed_at_et"] = str(raw_strategy.get("closed_at_et", "")).strip()
    strategy["close_fees"] = max(safe_float(raw_strategy.get("close_fees"), 0.0), 0.0)
    strategy["close_notes"] = str(raw_strategy.get("close_notes", "")).strip()
    strategy["closed_profit_progress_pct"] = _sanitize_optional_float(raw_strategy.get("closed_profit_progress_pct"))

    raw_legs = raw_strategy.get("legs", [])
    if not isinstance(raw_legs, list):
        raw_legs = []
    strategy["legs"] = [sanitize_option_leg(leg) for leg in raw_legs]

    if not strategy["name"] and strategy["underlying"]:
        strategy["name"] = f"{strategy['underlying']} {strategy['strategy_type']}"

    return strategy


def is_strategy_closed(strategy: dict) -> bool:
    strategy = sanitize_strategy(strategy) or empty_strategy()
    return str(strategy.get("status", "Open")).strip().title() == "Closed"


def calculate_closed_leg_metrics(leg: dict) -> dict:
    """Calculate realized P/L for a leg using its saved close premium."""
    leg = calculate_leg_metrics(leg)
    multiplier = 100.0
    contracts = safe_float(leg.get("contracts"), 0.0)
    entry_premium = safe_float(leg.get("entry_premium"), 0.0)
    close_premium = nullable_float(leg.get("close_premium"))
    if close_premium is None:
        close_premium = safe_float(leg.get("current_premium"), entry_premium)

    entry_value = entry_premium * multiplier * contracts
    close_value = close_premium * multiplier * contracts

    if leg.get("action") == "Sell":
        close_cash_flow = -close_value
        realized_pl = entry_value - close_value
    else:
        close_cash_flow = close_value
        realized_pl = close_value - entry_value

    realized_pl_pct = realized_pl / entry_value * 100 if entry_value > 0 else None

    return {
        **leg,
        "close_premium": max(safe_float(close_premium, 0.0), 0.0),
        "close_value": close_value,
        "close_cash_flow": close_cash_flow,
        "realized_pl": realized_pl,
        "realized_pl_pct": realized_pl_pct,
    }


def calculate_closed_strategy_metrics(strategy: dict) -> dict:
    """Calculate realized P/L for a closed strategy. Close fees are subtracted at strategy level."""
    strategy = sanitize_strategy(strategy) or empty_strategy()
    leg_metrics = [calculate_closed_leg_metrics(leg) for leg in strategy.get("legs", [])]

    entry_cash_flow = sum(leg.get("entry_cash_flow", 0.0) for leg in leg_metrics)
    close_cash_flow = sum(leg.get("close_cash_flow", 0.0) for leg in leg_metrics)
    gross_realized_pl = sum(leg.get("realized_pl", 0.0) for leg in leg_metrics)
    close_fees = max(safe_float(strategy.get("close_fees"), 0.0), 0.0)
    realized_pl = gross_realized_pl - close_fees

    if entry_cash_flow > 0:
        entry_type = "Credit"
        denominator = entry_cash_flow
        progress_label = "Profit captured"
    elif entry_cash_flow < 0:
        entry_type = "Debit"
        denominator = abs(entry_cash_flow)
        progress_label = "Return on debit"
    else:
        entry_type = "Even"
        denominator = None
        progress_label = "Realized progress"

    realized_pl_pct = realized_pl / denominator * 100 if denominator and denominator > 0 else None
    target_pct = safe_float(strategy.get("profit_target_pct"), DEFAULT_OPTIONS_PROFIT_TARGET_PCT)

    return {
        **strategy,
        "legs": leg_metrics,
        "entry_cash_flow": entry_cash_flow,
        "close_cash_flow": close_cash_flow,
        "gross_realized_pl": gross_realized_pl,
        "realized_pl": realized_pl,
        "realized_pl_pct": realized_pl_pct,
        "entry_type": entry_type,
        "profit_progress_pct": realized_pl_pct,
        "progress_label": progress_label,
        "target_hit": realized_pl_pct is not None and realized_pl_pct >= target_pct,
        **estimate_strategy_risk_metrics({**strategy, "legs": leg_metrics}),
    }


def calculate_strategy_display_metrics(strategy: dict) -> dict:
    strategy = sanitize_strategy(strategy) or empty_strategy()
    if is_strategy_closed(strategy):
        return calculate_closed_strategy_metrics(strategy)
    return calculate_strategy_metrics(strategy)


def close_strategy(strategies: list[dict], strategy_id: str, close_premiums: list[float], close_fees=0.0, close_notes: str = "") -> list[dict]:
    """Mark an option strategy as closed and store realized close premiums/P&L inputs."""
    updated_strategies = deepcopy(strategies)
    strategy = get_strategy_by_id(updated_strategies, strategy_id)
    if not strategy:
        return strategies

    strategy = sanitize_strategy(strategy) or empty_strategy()
    if is_strategy_closed(strategy):
        return strategies

    current_metrics = calculate_strategy_metrics(strategy)
    closed_legs = []
    for index, leg in enumerate(strategy.get("legs", [])):
        leg = sanitize_option_leg(leg)
        fallback_premium = safe_float(leg.get("current_premium"), safe_float(leg.get("entry_premium"), 0.0))
        close_premium = close_premiums[index] if index < len(close_premiums) else fallback_premium
        close_premium = max(safe_float(close_premium, fallback_premium), 0.0)
        leg["close_premium"] = close_premium
        leg["current_premium"] = close_premium
        leg["close_price_method"] = "manual_close"
        closed_legs.append(leg)

    strategy["legs"] = closed_legs
    strategy["status"] = "Closed"
    strategy["closed_at_et"] = now_et_string()
    strategy["updated_at_et"] = strategy["closed_at_et"]
    strategy["close_fees"] = max(safe_float(close_fees, 0.0), 0.0)
    strategy["close_notes"] = str(close_notes or "").strip()
    strategy["closed_profit_progress_pct"] = current_metrics.get("profit_progress_pct")

    for index, existing in enumerate(updated_strategies):
        if existing.get("id") == strategy_id:
            updated_strategies[index] = strategy
            break

    return updated_strategies


def reopen_strategy(strategies: list[dict], strategy_id: str) -> list[dict]:
    """Reopen a previously closed local strategy if the user closed it by mistake."""
    updated_strategies = deepcopy(strategies)
    strategy = get_strategy_by_id(updated_strategies, strategy_id)
    if not strategy:
        return strategies

    strategy = sanitize_strategy(strategy) or empty_strategy()
    strategy["status"] = "Open"
    strategy["closed_at_et"] = ""
    strategy["close_fees"] = 0.0
    strategy["close_notes"] = ""
    strategy["closed_profit_progress_pct"] = None
    for leg in strategy.get("legs", []):
        leg["close_premium"] = None
        leg["close_price_method"] = ""
    strategy["updated_at_et"] = now_et_string()

    for index, existing in enumerate(updated_strategies):
        if existing.get("id") == strategy_id:
            updated_strategies[index] = strategy
            break

    return updated_strategies


def get_strategy_by_id(strategies: list[dict], strategy_id: str) -> dict | None:
    for strategy in strategies:
        if strategy.get("id") == strategy_id:
            return strategy
    return None


def upsert_strategy(strategies: list[dict], strategy: dict) -> list[dict]:
    strategy = sanitize_strategy(strategy)
    if strategy is None:
        return strategies

    strategy["updated_at_et"] = now_et_string()
    updated = []
    found = False

    for existing in strategies:
        if existing.get("id") == strategy.get("id"):
            updated.append(strategy)
            found = True
        else:
            updated.append(existing)

    if not found:
        updated.append(strategy)

    return updated


def remove_strategy(strategies: list[dict], strategy_id: str) -> list[dict]:
    return [strategy for strategy in strategies if strategy.get("id") != strategy_id]


def update_strategy_leg_premiums(strategies: list[dict], strategy_id: str, current_premiums: list[float]) -> list[dict]:
    updated_strategies = deepcopy(strategies)
    strategy = get_strategy_by_id(updated_strategies, strategy_id)
    if not strategy:
        return strategies

    for index, leg in enumerate(strategy.get("legs", [])):
        if index < len(current_premiums):
            leg["current_premium"] = max(safe_float(current_premiums[index], leg.get("current_premium", 0.0)), 0.0)
            leg["option_price_method"] = "manual"
            leg["option_snapshot_status"] = leg.get("option_snapshot_status") or "manual"

    strategy["updated_at_et"] = now_et_string()
    return updated_strategies


def calculate_leg_metrics(leg: dict) -> dict:
    leg = sanitize_option_leg(leg)
    multiplier = 100.0
    contracts = safe_float(leg.get("contracts"), 0.0)
    entry_premium = safe_float(leg.get("entry_premium"), 0.0)
    current_premium = safe_float(leg.get("current_premium"), entry_premium)

    entry_value = entry_premium * multiplier * contracts
    current_value = current_premium * multiplier * contracts

    if leg.get("action") == "Sell":
        entry_cash_flow = entry_value
        current_close_cash_flow = -current_value
        unrealized_pl = entry_value - current_value
    else:
        entry_cash_flow = -entry_value
        current_close_cash_flow = current_value
        unrealized_pl = current_value - entry_value

    unrealized_pl_pct = unrealized_pl / entry_value * 100 if entry_value > 0 else None

    quality = classify_option_leg_data_quality(leg)

    return {
        **leg,
        **quality,
        "entry_value": entry_value,
        "current_value": current_value,
        "entry_cash_flow": entry_cash_flow,
        "current_close_cash_flow": current_close_cash_flow,
        "unrealized_pl": unrealized_pl,
        "unrealized_pl_pct": unrealized_pl_pct,
    }


def calculate_strategy_metrics(strategy: dict) -> dict:
    strategy = sanitize_strategy(strategy) or empty_strategy()
    leg_metrics = [calculate_leg_metrics(leg) for leg in strategy.get("legs", [])]

    entry_cash_flow = sum(leg.get("entry_cash_flow", 0.0) for leg in leg_metrics)
    current_close_cash_flow = sum(leg.get("current_close_cash_flow", 0.0) for leg in leg_metrics)
    unrealized_pl = sum(leg.get("unrealized_pl", 0.0) for leg in leg_metrics)

    if entry_cash_flow > 0:
        entry_type = "Credit"
        denominator = entry_cash_flow
        progress_label = "Profit captured"
    elif entry_cash_flow < 0:
        entry_type = "Debit"
        denominator = abs(entry_cash_flow)
        progress_label = "Return on debit"
    else:
        entry_type = "Even"
        denominator = None
        progress_label = "Profit progress"

    profit_progress_pct = unrealized_pl / denominator * 100 if denominator and denominator > 0 else None
    target_pct = safe_float(strategy.get("profit_target_pct"), DEFAULT_OPTIONS_PROFIT_TARGET_PCT)
    target_hit = profit_progress_pct is not None and profit_progress_pct >= target_pct

    risk_metrics = estimate_strategy_risk_metrics({**strategy, "legs": leg_metrics})

    return {
        **strategy,
        "legs": leg_metrics,
        "entry_cash_flow": entry_cash_flow,
        "current_close_cash_flow": current_close_cash_flow,
        "unrealized_pl": unrealized_pl,
        "entry_type": entry_type,
        "profit_progress_pct": profit_progress_pct,
        "progress_label": progress_label,
        "target_hit": target_hit,
        **risk_metrics,
    }



# ------------------------------------------------------------
# Strategy risk / expiration payoff helpers
# ------------------------------------------------------------
def _leg_expiration_pl_at_price(leg: dict, underlying_price: float) -> float:
    leg = sanitize_option_leg(leg)
    s = max(safe_float(underlying_price, 0.0), 0.0)
    strike = safe_float(leg.get("strike"), 0.0)
    contracts = safe_float(leg.get("contracts"), 0.0)
    entry_premium = safe_float(leg.get("entry_premium"), 0.0)
    multiplier = 100.0

    if leg.get("option_type") == "Call":
        intrinsic = max(s - strike, 0.0)
    else:
        intrinsic = max(strike - s, 0.0)

    intrinsic_value = intrinsic * contracts * multiplier
    entry_value = entry_premium * contracts * multiplier

    if leg.get("action") == "Sell":
        return entry_value - intrinsic_value
    return intrinsic_value - entry_value


def strategy_expiration_pl_at_price(strategy: dict, underlying_price: float) -> float:
    strategy = sanitize_strategy(strategy) or empty_strategy()
    return sum(_leg_expiration_pl_at_price(leg, underlying_price) for leg in strategy.get("legs", []))


def _high_price_call_slope(strategy: dict) -> float:
    """Return P/L slope at very high prices from call exposure only."""
    strategy = sanitize_strategy(strategy) or empty_strategy()
    slope = 0.0
    for leg in strategy.get("legs", []):
        leg = sanitize_option_leg(leg)
        if leg.get("option_type") != "Call":
            continue
        contracts = safe_float(leg.get("contracts"), 0.0)
        if leg.get("action") == "Buy":
            slope += contracts * 100.0
        else:
            slope -= contracts * 100.0
    return slope


def estimate_strategy_risk_metrics(strategy: dict) -> dict:
    """Estimate max profit/loss and break-even points from expiry payoff.

    This is a practical tracker estimate, not a broker margin engine. It handles
    common single-leg, vertical spread, iron condor, straddle, and custom legs.
    Call-side unlimited risk/profit is detected from high-price slope.
    """
    strategy = sanitize_strategy(strategy) or empty_strategy()
    strikes = sorted({safe_float(leg.get("strike"), 0.0) for leg in strategy.get("legs", []) if safe_float(leg.get("strike"), 0.0) > 0})
    if not strikes:
        return {
            "max_profit": None,
            "max_loss": None,
            "max_profit_label": "N/A",
            "max_loss_label": "N/A",
            "breakevens": [],
            "breakeven_label": "N/A",
            "risk_note": "No valid option strikes found.",
        }

    upper = max(max(strikes) * 2.0, max(strikes) + 100.0)
    points = sorted(set([0.0] + strikes + [upper]))

    values = [(point, strategy_expiration_pl_at_price(strategy, point)) for point in points]
    min_pl = min(value for _, value in values)
    max_pl = max(value for _, value in values)

    high_slope = _high_price_call_slope(strategy)
    unlimited_profit = high_slope > 0
    unlimited_loss = high_slope < 0

    breakevens = []
    # Search each interval with bisection for sign changes.
    for left, right in zip(points[:-1], points[1:]):
        pl_left = strategy_expiration_pl_at_price(strategy, left)
        pl_right = strategy_expiration_pl_at_price(strategy, right)
        if abs(pl_left) < 0.01:
            breakevens.append(left)
        if pl_left == 0 or pl_right == 0:
            if abs(pl_right) < 0.01:
                breakevens.append(right)
            continue
        if (pl_left < 0 < pl_right) or (pl_left > 0 > pl_right):
            lo, hi = left, right
            for _ in range(40):
                mid = (lo + hi) / 2
                pl_mid = strategy_expiration_pl_at_price(strategy, mid)
                if (pl_left < 0 < pl_mid) or (pl_left > 0 > pl_mid):
                    hi = mid
                    pl_right = pl_mid
                else:
                    lo = mid
                    pl_left = pl_mid
            breakevens.append((lo + hi) / 2)

    # Check beyond the final strike for single long/short call style break-evens.
    if high_slope != 0:
        last_point = points[-1]
        pl_last = strategy_expiration_pl_at_price(strategy, last_point)
        # Since the last segment is linear, root = x - y/slope.
        root = last_point - pl_last / high_slope
        if root >= max(strikes) and root <= upper * 5:
            breakevens.append(root)

    rounded_breakevens = []
    for breakeven in sorted(breakevens):
        rounded = round(float(breakeven), 2)
        if rounded not in rounded_breakevens:
            rounded_breakevens.append(rounded)

    if unlimited_profit:
        max_profit_label = "Unlimited"
    else:
        max_profit_label = max_pl

    if unlimited_loss:
        max_loss_label = "Unlimited"
    else:
        max_loss_label = min_pl

    risk_note = "Estimated from expiration payoff using entry premiums."
    if unlimited_profit or unlimited_loss:
        risk_note += " Unlimited call-side exposure detected."

    return {
        "max_profit": None if unlimited_profit else max_pl,
        "max_loss": None if unlimited_loss else min_pl,
        "max_profit_label": max_profit_label,
        "max_loss_label": max_loss_label,
        "breakevens": rounded_breakevens,
        "breakeven_label": ", ".join([f"{item:.2f}" for item in rounded_breakevens]) if rounded_breakevens else "N/A",
        "risk_note": risk_note,
    }


def choose_chain_contract_by_delta(chain: dict, *, option_type: str, target_delta: float, strike_side: str | None = None) -> dict | None:
    """Pick the chain contract whose delta is closest to target_delta.

    target_delta should be signed, e.g. -0.20 for puts and +0.20 for calls.
    If strike_side is provided, use it only as a loose descriptive field for future
    extension; v1.2 selects by closest delta from the supplied filtered chain.
    """
    option_type = str(option_type or "").strip().title()
    candidates = []
    for contract_symbol, snapshot in (chain or {}).items():
        if not isinstance(snapshot, dict):
            continue
        delta = nullable_float(snapshot.get("delta"))
        if delta is None:
            continue
        # Infer call/put from OCC symbol when possible.
        symbol = normalize_symbol(contract_symbol)
        if option_type == "Call" and "C" not in symbol[-9:]:
            # This heuristic is intentionally loose; chain filters should already handle type.
            pass
        candidates.append((abs(delta - target_delta), symbol, snapshot))
    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0])
    return {"contract_symbol": candidates[0][1], **candidates[0][2]}


def strategies_to_dataframe(strategies: list[dict]) -> pd.DataFrame:
    rows = []
    for strategy in strategies:
        metrics = calculate_strategy_display_metrics(strategy)
        strategy_status = metrics.get("status", "Open")
        snapshot_statuses = []
        for leg in metrics.get("legs", []):
            leg_snapshot_status = leg.get("option_snapshot_status")
            if leg_snapshot_status and leg_snapshot_status not in snapshot_statuses:
                snapshot_statuses.append(leg_snapshot_status)

        data_quality = summarize_strategy_data_quality(metrics.get("legs", []))

        rows.append(
            {
                "Name": metrics.get("name", ""),
                "Underlying": metrics.get("underlying", ""),
                "Status": strategy_status,
                "Type": metrics.get("strategy_type", ""),
                "Expiration": metrics.get("expiration", ""),
                "Legs": len(metrics.get("legs", [])),
                "Entry Type": metrics.get("entry_type", ""),
                "Entry Cash Flow": metrics.get("entry_cash_flow"),
                "Current Close Cash Flow": metrics.get("close_cash_flow") if strategy_status == "Closed" else metrics.get("current_close_cash_flow"),
                "Unrealized P/L": metrics.get("realized_pl") if strategy_status == "Closed" else metrics.get("unrealized_pl"),
                "Realized P/L": metrics.get("realized_pl") if strategy_status == "Closed" else None,
                "Profit Progress %": metrics.get("profit_progress_pct"),
                "Max Profit": metrics.get("max_profit_label"),
                "Max Loss": metrics.get("max_loss_label"),
                "Break-even(s)": metrics.get("breakeven_label"),
                "Target %": metrics.get("profit_target_pct"),
                "Data Quality": data_quality,
                "Snapshot Status": ", ".join(snapshot_statuses) if snapshot_statuses else "manual",
                "Alert": "Closed" if strategy_status == "Closed" else ("Target Hit" if metrics.get("target_hit") else "Watching"),
                "Closed At": metrics.get("closed_at_et", ""),
                "Updated": metrics.get("updated_at_et"),
                "id": metrics.get("id"),
            }
        )
    return pd.DataFrame(rows)


def get_strategy_contract_symbols(strategy: dict) -> list[str]:
    strategy = sanitize_strategy(strategy) or empty_strategy()
    underlying = strategy.get("underlying")
    expiration = strategy.get("expiration")
    symbols = []

    for leg in strategy.get("legs", []):
        contract_symbol = normalize_symbol(leg.get("contract_symbol", ""))
        if not contract_symbol:
            contract_symbol = build_option_contract_symbol(
                underlying=underlying,
                expiration=expiration,
                option_type=leg.get("option_type"),
                strike=leg.get("strike"),
            )
        if contract_symbol and contract_symbol not in symbols:
            symbols.append(contract_symbol)

    return symbols


def _first_valid_price(*values):
    for value in values:
        parsed = nullable_float(value)
        if parsed is not None and parsed > 0:
            return parsed
    return None


def select_close_premium_for_leg(leg: dict, snapshot: dict) -> tuple[float | None, str]:
    """Select a current premium for P/L.

    Conservative close logic:
    - Long option: closing means selling, so prefer bid.
    - Short option: closing means buying back, so prefer ask.
    Fallback to latest trade, then mid, then the opposite quote side.
    """
    leg = sanitize_option_leg(leg)
    snapshot = snapshot or {}
    bid = snapshot.get("bid")
    ask = snapshot.get("ask")
    last = snapshot.get("last")
    mid = snapshot.get("mid")

    if leg.get("action") == "Sell":
        premium = _first_valid_price(ask, last, mid, bid)
        if premium == _first_valid_price(ask):
            return premium, "short_ask_to_close"
        if premium == _first_valid_price(last):
            return premium, "short_last_trade_fallback"
        if premium == _first_valid_price(mid):
            return premium, "short_mid_fallback"
        if premium == _first_valid_price(bid):
            return premium, "short_bid_fallback"
        return None, "short_unavailable"

    premium = _first_valid_price(bid, last, mid, ask)
    if premium == _first_valid_price(bid):
        return premium, "long_bid_to_close"
    if premium == _first_valid_price(last):
        return premium, "long_last_trade_fallback"
    if premium == _first_valid_price(mid):
        return premium, "long_mid_fallback"
    if premium == _first_valid_price(ask):
        return premium, "long_ask_fallback"
    return None, "long_unavailable"



def _bid_ask_spread_pct(bid, ask, mid=None) -> float | None:
    bid = nullable_float(bid)
    ask = nullable_float(ask)
    mid = nullable_float(mid)
    if bid is None or ask is None or bid <= 0 or ask <= 0 or ask < bid:
        return None
    if mid is None or mid <= 0:
        mid = (bid + ask) / 2
    if mid <= 0:
        return None
    return (ask - bid) / mid * 100


def classify_option_leg_data_quality(leg: dict) -> dict:
    """Classify how reliable a leg's current premium estimate looks.

    Alpaca indicative options data can miss quotes/trades, especially for illiquid
    contracts. This classifier makes the tracker explicit about whether current
    P/L is based on bid/ask, last trade, a wide-spread quote, or a manual value.
    """
    leg = sanitize_option_leg(leg)
    method = str(leg.get("option_price_method", "") or "").lower()
    status = str(leg.get("option_snapshot_status", "") or "").lower()
    error = str(leg.get("option_error") or "").strip()
    bid = nullable_float(leg.get("bid"))
    ask = nullable_float(leg.get("ask"))
    last = nullable_float(leg.get("last"))
    mid = nullable_float(leg.get("mid"))
    current = nullable_float(leg.get("current_premium"))
    spread_pct = _bid_ask_spread_pct(bid, ask, mid)

    if method in {"manual", "manual_close"} or status == "manual":
        return {
            "data_quality": "Manual override",
            "data_quality_detail": "Current/close premium was entered manually. Treat this as user-controlled tracking data.",
            "bid_ask_spread_pct": spread_pct,
        }

    if current is None or current <= 0:
        detail = error or "No usable current premium is available. Enter a manual premium or refresh snapshots later."
        return {
            "data_quality": "No premium",
            "data_quality_detail": detail,
            "bid_ask_spread_pct": spread_pct,
        }

    if status in {"missing", "no_price", "error"}:
        return {
            "data_quality": "No live premium",
            "data_quality_detail": error or f"Snapshot status is {status}; using saved/manual fallback if present.",
            "bid_ask_spread_pct": spread_pct,
        }

    if spread_pct is not None and spread_pct >= 20:
        return {
            "data_quality": "Wide spread",
            "data_quality_detail": f"Bid/ask spread is about {spread_pct:.1f}% of mid; estimated P/L can be noisy.",
            "bid_ask_spread_pct": spread_pct,
        }

    if bid is not None and ask is not None and bid > 0 and ask > 0:
        return {
            "data_quality": "Bid/Ask available",
            "data_quality_detail": "Current premium is based on a quoted bid/ask side using conservative close logic.",
            "bid_ask_spread_pct": spread_pct,
        }

    if last is not None and last > 0:
        return {
            "data_quality": "Last trade only",
            "data_quality_detail": "No complete bid/ask quote was available; current premium uses latest trade fallback.",
            "bid_ask_spread_pct": spread_pct,
        }

    if mid is not None and mid > 0:
        return {
            "data_quality": "Mid only",
            "data_quality_detail": "Only mid/fallback pricing was available. Confirm with broker quote before acting.",
            "bid_ask_spread_pct": spread_pct,
        }

    return {
        "data_quality": "Estimated",
        "data_quality_detail": "Premium estimate is available, but quote details are limited.",
        "bid_ask_spread_pct": spread_pct,
    }


def summarize_strategy_data_quality(legs: list[dict]) -> str:
    qualities = [classify_option_leg_data_quality(leg).get("data_quality") for leg in (legs or [])]
    if not qualities:
        return "No legs"
    if any(item in {"No premium", "No live premium"} for item in qualities):
        return "Needs manual price"
    if any(item == "Wide spread" for item in qualities):
        return "Wide spread"
    if any(item == "Last trade only" for item in qualities):
        return "Last trade only"
    if all(item == "Manual override" for item in qualities):
        return "Manual override"
    if all(item in {"Bid/Ask available", "Manual override"} for item in qualities):
        return "OK"
    return ", ".join(dict.fromkeys(qualities))


def apply_option_snapshots_to_strategy(strategy: dict, snapshots: dict[str, dict]) -> dict:
    """Apply Alpaca option snapshots to a strategy's legs."""
    updated_strategy = sanitize_strategy(strategy) or empty_strategy()
    if is_strategy_closed(updated_strategy):
        return updated_strategy
    underlying = updated_strategy.get("underlying")
    expiration = updated_strategy.get("expiration")
    now_et = now_et_string()
    snapshots = snapshots or {}

    updated_legs = []
    for leg in updated_strategy.get("legs", []):
        leg = sanitize_option_leg(leg)
        contract_symbol = normalize_symbol(leg.get("contract_symbol", "")) or build_option_contract_symbol(
            underlying=underlying,
            expiration=expiration,
            option_type=leg.get("option_type"),
            strike=leg.get("strike"),
        )
        leg["contract_symbol"] = contract_symbol

        snapshot = snapshots.get(contract_symbol, {}) if contract_symbol else {}
        if snapshot:
            selected_premium, premium_method = select_close_premium_for_leg(leg, snapshot)

            if selected_premium is not None:
                leg["current_premium"] = selected_premium

            leg["bid"] = _sanitize_optional_float(snapshot.get("bid"))
            leg["ask"] = _sanitize_optional_float(snapshot.get("ask"))
            leg["mid"] = _sanitize_optional_float(snapshot.get("mid"))
            leg["last"] = _sanitize_optional_float(snapshot.get("last"))
            leg["implied_volatility"] = _sanitize_optional_float(snapshot.get("implied_volatility"))
            leg["delta"] = _sanitize_optional_float(snapshot.get("delta"))
            leg["gamma"] = _sanitize_optional_float(snapshot.get("gamma"))
            leg["theta"] = _sanitize_optional_float(snapshot.get("theta"))
            leg["vega"] = _sanitize_optional_float(snapshot.get("vega"))
            leg["rho"] = _sanitize_optional_float(snapshot.get("rho"))
            leg["option_price_method"] = premium_method
            leg["option_snapshot_status"] = snapshot.get("status") or ("ok" if selected_premium is not None else "no_price")
            leg["option_snapshot_source"] = snapshot.get("source") or "alpaca_option_snapshot"
            leg["option_snapshot_feed"] = snapshot.get("feed") or ""
            leg["option_quote_timestamp"] = snapshot.get("quote_timestamp")
            leg["option_trade_timestamp"] = snapshot.get("trade_timestamp")
            leg["option_snapshot_updated_at_et"] = now_et
            leg["option_error"] = snapshot.get("error")
        else:
            leg["option_snapshot_status"] = "missing"
            leg["option_error"] = "No snapshot returned for this contract symbol."
            leg["option_snapshot_updated_at_et"] = now_et

        updated_legs.append(leg)

    updated_strategy["legs"] = updated_legs
    updated_strategy["updated_at_et"] = now_et
    return updated_strategy


def update_strategy_from_option_snapshots(strategies: list[dict], strategy_id: str, snapshots: dict[str, dict]) -> list[dict]:
    updated_strategies = deepcopy(strategies)
    strategy = get_strategy_by_id(updated_strategies, strategy_id)
    if not strategy:
        return strategies

    updated_strategy = apply_option_snapshots_to_strategy(strategy, snapshots)

    for index, existing in enumerate(updated_strategies):
        if existing.get("id") == strategy_id:
            updated_strategies[index] = updated_strategy
            break

    return updated_strategies
