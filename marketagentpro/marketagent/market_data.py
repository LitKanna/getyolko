import time

import pandas as pd
import streamlit as st

from marketagent.config import (
    CHART_VIEW_CONFIG,
    DASHBOARD_CHART_CLOSE_MIN_DIFF_PCT,
    DASHBOARD_CHART_CLOSE_NEWER_THAN_QUOTE_SECONDS,
    DASHBOARD_USE_CHART_CLOSE_EXTENDED_HOURS_FALLBACK,
    LATEST_QUOTE_CACHE_SECONDS,
    SIGNAL_CONFIG,
)
from marketagent.indicators import add_technical_indicators, get_latest_snapshot
from marketagent.providers import (
    get_market_data_provider,
    get_market_data_provider_health,
    get_market_data_provider_name,
)
from marketagent.utils import (
    format_datetime_et,
    is_extended_hours_et,
    normalize_symbol,
    now_et_string,
    nullable_float,
    parse_datetime_to_et,
)


QUOTE_CACHE_STATE_KEY = "latest_quote_cache"


@st.cache_data(ttl=20, show_spinner=False)
def fetch_history(symbol: str, period: str, interval: str, prepost: bool) -> pd.DataFrame:
    """Fetch OHLCV history through the selected market data provider."""
    provider = get_market_data_provider()
    return provider.fetch_history(
        symbol=symbol,
        period=period,
        interval=interval,
        prepost=prepost,
    )


def _normalize_symbols_for_cache(symbols) -> tuple[str, ...]:
    """Normalize symbols and return a stable tuple for quote cache keys."""
    normalized_symbols = []
    for symbol in symbols or []:
        normalized_symbol = normalize_symbol(symbol)
        if normalized_symbol and normalized_symbol not in normalized_symbols:
            normalized_symbols.append(normalized_symbol)
    return tuple(normalized_symbols)


def _ensure_quote_cache() -> dict:
    """Return the shared in-session quote cache used across Dashboard and Portfolio."""
    if QUOTE_CACHE_STATE_KEY not in st.session_state:
        st.session_state[QUOTE_CACHE_STATE_KEY] = {}
    return st.session_state[QUOTE_CACHE_STATE_KEY]


def clear_quote_cache():
    """Clear only the shared quote cache."""
    st.session_state[QUOTE_CACHE_STATE_KEY] = {}


def _quote_age_seconds(quote: dict, now_epoch: float | None = None):
    if not quote:
        return None

    cached_at_epoch = quote.get("cache_updated_at_epoch")
    if cached_at_epoch is None:
        return None

    if now_epoch is None:
        now_epoch = time.time()

    try:
        return max(now_epoch - float(cached_at_epoch), 0.0)
    except Exception:
        return None


def _store_quotes_in_cache(quotes: dict):
    """Merge newly fetched quotes into the shared quote cache with local cache metadata."""
    cache = _ensure_quote_cache()
    now_epoch = time.time()
    now_et = now_et_string()

    for raw_symbol, raw_quote in (quotes or {}).items():
        symbol = normalize_symbol(raw_symbol)
        if not symbol or not isinstance(raw_quote, dict):
            continue

        quote = raw_quote.copy()
        quote["symbol"] = symbol
        quote["cache_updated_at_epoch"] = now_epoch
        quote["cache_updated_at_et"] = now_et
        cache[symbol] = quote


def fetch_latest_quotes(
    symbols,
    *,
    force_refresh: bool = False,
    max_age_seconds: int | float | None = LATEST_QUOTE_CACHE_SECONDS,
) -> dict:
    """Fetch latest quote info for multiple symbols through a shared quote cache.

    - Dashboard calls this with the default small max_age_seconds, so quotes update
      on its auto-refresh cycle.
    - Portfolio can call this with max_age_seconds=None so it reads cached quotes
      and only requests missing symbols unless the user clicks Refresh Quotes.
    - force_refresh=True bypasses age checks and uses one provider batch request.
    """
    normalized_symbols = _normalize_symbols_for_cache(symbols)
    if not normalized_symbols:
        return {}

    cache = _ensure_quote_cache()
    now_epoch = time.time()

    symbols_to_fetch = []

    for symbol in normalized_symbols:
        cached_quote = cache.get(symbol)

        if force_refresh or not cached_quote:
            symbols_to_fetch.append(symbol)
            continue

        if max_age_seconds is not None:
            age = _quote_age_seconds(cached_quote, now_epoch)
            if age is None or age > float(max_age_seconds):
                symbols_to_fetch.append(symbol)

    if symbols_to_fetch:
        provider = get_market_data_provider()
        fetched_quotes = provider.fetch_latest_quotes(symbols_to_fetch)
        _store_quotes_in_cache(fetched_quotes)

    refreshed_cache = _ensure_quote_cache()
    return {
        symbol: refreshed_cache.get(symbol, {"symbol": symbol, "price": None, "status": "missing"})
        for symbol in normalized_symbols
    }


def refresh_latest_quotes(symbols) -> dict:
    """Force-refresh latest quotes for a symbol list using one provider batch request."""
    return fetch_latest_quotes(symbols, force_refresh=True, max_age_seconds=0)


def fetch_latest_quote(
    symbol: str,
    *,
    force_refresh: bool = False,
    max_age_seconds: int | float | None = LATEST_QUOTE_CACHE_SECONDS,
) -> dict:
    """Fetch latest quote info through the selected provider."""
    normalized_symbol = normalize_symbol(symbol)
    if not normalized_symbol:
        return {}
    return fetch_latest_quotes(
        (normalized_symbol,),
        force_refresh=force_refresh,
        max_age_seconds=max_age_seconds,
    ).get(normalized_symbol, {})


def _latest_chart_close_payload(chart_data) -> dict:
    """Return latest chart close/time details from displayed chart data."""
    if chart_data is None or chart_data.empty or "Close" not in chart_data.columns:
        return {"price": None, "time": None, "time_et": "N/A"}

    chart_price = nullable_float(chart_data["Close"].iloc[-1])
    chart_time = None
    chart_time_et = "N/A"

    try:
        chart_time = chart_data.index[-1]
        chart_time_et = format_datetime_et(chart_time)
    except Exception:
        chart_time = None
        chart_time_et = "N/A"

    return {"price": chart_price, "time": chart_time, "time_et": chart_time_et}


def apply_extended_hours_chart_price_fallback_to_quote(
    latest_quote: dict | None,
    chart_data,
    chart_view: str = "Today",
    chart_config: dict | None = None,
) -> dict:
    """Dashboard/News current-price fallback for extended-hours display.

    This keeps normal provider pricing as the default, but when a Today/2 Days
    pre/post-market chart has a newer yfinance candle than the provider-selected
    price, it can use the latest chart close as the display price.  This is meant
    for UI display only; it does not change the global quote cache, Portfolio, or
    Options pricing.
    """
    quote = (latest_quote or {}).copy()
    chart_config = chart_config or CHART_VIEW_CONFIG.get(chart_view, {})
    chart_payload = _latest_chart_close_payload(chart_data)
    chart_price = chart_payload.get("price")
    chart_time = chart_payload.get("time")
    chart_time_et = chart_payload.get("time_et")

    quote["chart_latest_close"] = chart_price
    quote["chart_latest_time_et"] = chart_time_et

    if not DASHBOARD_USE_CHART_CLOSE_EXTENDED_HOURS_FALLBACK:
        return quote

    if chart_view not in {"Today", "2 Days"}:
        return quote

    if not bool(chart_config.get("prepost")):
        return quote

    if chart_price is None or chart_time is None:
        return quote

    if not is_extended_hours_et(chart_time):
        return quote

    selected_price = nullable_float(quote.get("price"))
    if selected_price is None or selected_price <= 0:
        return quote

    selected_time_raw = quote.get("timestamp") or quote.get("trade_timestamp")
    selected_dt = parse_datetime_to_et(selected_time_raw)
    chart_dt = parse_datetime_to_et(chart_time)

    if selected_dt is None or chart_dt is None:
        return quote

    try:
        chart_minus_selected_seconds = (chart_dt - selected_dt).total_seconds()
    except Exception:
        return quote

    try:
        chart_price_diff_pct = abs(chart_price - selected_price) / selected_price * 100
    except Exception:
        chart_price_diff_pct = 0.0

    quote["chart_minus_selected_price_seconds"] = chart_minus_selected_seconds
    quote["chart_vs_selected_price_diff_pct"] = chart_price_diff_pct

    if chart_minus_selected_seconds < DASHBOARD_CHART_CLOSE_NEWER_THAN_QUOTE_SECONDS:
        return quote

    if chart_price_diff_pct < DASHBOARD_CHART_CLOSE_MIN_DIFF_PCT:
        return quote

    quote["original_provider_price"] = selected_price
    quote["original_provider_timestamp"] = quote.get("timestamp")
    quote["original_price_method"] = quote.get("price_method")
    quote["original_source"] = quote.get("source")
    quote["price"] = chart_price
    quote["timestamp"] = chart_time_et
    quote["price_method"] = "yfinance_chart_close_extended_hours"
    quote["selected_price_source"] = "yfinance_chart"
    quote["source"] = "dashboard_yfinance_chart_close_extended_hours"
    quote["fallback_reason"] = (
        "Used the latest yfinance chart close because the visible extended-hours candle "
        "is newer than the selected provider price. This affects the UI display only."
    )
    return quote


def fetch_dashboard_current_quote(
    symbol: str,
    *,
    chart_view: str = "Today",
    force_refresh: bool = False,
    max_age_seconds: int | float | None = LATEST_QUOTE_CACHE_SECONDS,
) -> dict:
    """Fetch a Dashboard-consistent current quote for UI modules such as News.

    The News page uses this so the price beside a ticker matches Dashboard behavior,
    including the extended-hours yfinance chart-close fallback.
    """
    normalized_symbol = normalize_symbol(symbol)
    if not normalized_symbol:
        return {}

    quote = fetch_latest_quote(
        normalized_symbol,
        force_refresh=force_refresh,
        max_age_seconds=max_age_seconds,
    )

    chart_config = CHART_VIEW_CONFIG.get(chart_view) or CHART_VIEW_CONFIG.get("Today", {})
    try:
        chart_data = fetch_history(
            symbol=normalized_symbol,
            period=chart_config.get("period", "1d"),
            interval=chart_config.get("interval", "1m"),
            prepost=bool(chart_config.get("prepost", True)),
        )
        quote = apply_extended_hours_chart_price_fallback_to_quote(
            quote,
            chart_data,
            chart_view=chart_view,
            chart_config=chart_config,
        )
    except Exception as exc:
        quote = (quote or {}).copy()
        quote["dashboard_price_error"] = str(exc)

    quote["dashboard_price_view"] = chart_view
    return quote


def fetch_latest_prices(symbols, *, force_refresh: bool = False) -> dict:
    """Fetch latest prices for multiple symbols as {symbol: price}."""
    quotes = fetch_latest_quotes(symbols, force_refresh=force_refresh)
    return {symbol: quote.get("price") for symbol, quote in quotes.items()}


def fetch_latest_price(symbol: str, *, force_refresh: bool = False):
    """Fetch latest available price through the selected market data provider."""
    quote = fetch_latest_quote(symbol, force_refresh=force_refresh)
    return quote.get("price")


def get_quote_cache_status(symbols) -> dict:
    """Summarize shared quote cache status for UI display."""
    normalized_symbols = _normalize_symbols_for_cache(symbols)
    cache = _ensure_quote_cache()
    now_epoch = time.time()

    cached_symbols = []
    missing_symbols = []
    ages = []
    sources = []
    last_updated_values = []

    for symbol in normalized_symbols:
        quote = cache.get(symbol)
        if not quote:
            missing_symbols.append(symbol)
            continue

        cached_symbols.append(symbol)

        age = _quote_age_seconds(quote, now_epoch)
        if age is not None:
            ages.append(age)

        source = quote.get("source")
        if source and source not in sources:
            sources.append(source)

        cache_updated_at_et = quote.get("cache_updated_at_et")
        if cache_updated_at_et:
            last_updated_values.append(cache_updated_at_et)

    return {
        "requested_symbols": list(normalized_symbols),
        "cached_symbols": cached_symbols,
        "missing_symbols": missing_symbols,
        "cached_count": len(cached_symbols),
        "requested_count": len(normalized_symbols),
        "all_cached": len(cached_symbols) == len(normalized_symbols) and len(normalized_symbols) > 0,
        "oldest_age_seconds": max(ages) if ages else None,
        "newest_age_seconds": min(ages) if ages else None,
        "sources": sources,
        "source_summary": ", ".join(sources) if sources else "N/A",
        "last_updated_et": max(last_updated_values) if last_updated_values else None,
    }


@st.cache_data(ttl=120, show_spinner=False)
def fetch_signal_data(symbol: str) -> dict:
    """Fetch fixed 1H + Daily signal data for EMA / RSI analysis."""
    result = {}

    for timeframe, config in SIGNAL_CONFIG.items():
        data = fetch_history(
            symbol=symbol,
            period=config["period"],
            interval=config["interval"],
            prepost=config["prepost"],
        )

        data = add_technical_indicators(data)
        result[timeframe] = {"data": data, "snapshot": get_latest_snapshot(data)}

    return result


def get_current_market_data_provider_name() -> str:
    """Return selected provider name for UI display/debugging."""
    return get_market_data_provider_name()


@st.cache_data(ttl=30, show_spinner=False)
def get_current_market_data_provider_health(test_symbol: str = "AAPL") -> dict:
    """Return selected provider health for sidebar diagnostics."""
    return get_market_data_provider_health(test_symbol=test_symbol)

# ------------------------------------------------------------
# Option snapshot cache
# ------------------------------------------------------------
OPTION_SNAPSHOT_CACHE_STATE_KEY = "option_snapshot_cache"


def _normalize_contract_symbols_for_cache(contract_symbols) -> tuple[str, ...]:
    normalized_symbols = []
    for symbol in contract_symbols or []:
        normalized_symbol = normalize_symbol(symbol)
        if normalized_symbol and normalized_symbol not in normalized_symbols:
            normalized_symbols.append(normalized_symbol)
    return tuple(normalized_symbols)


def _ensure_option_snapshot_cache() -> dict:
    if OPTION_SNAPSHOT_CACHE_STATE_KEY not in st.session_state:
        st.session_state[OPTION_SNAPSHOT_CACHE_STATE_KEY] = {}
    return st.session_state[OPTION_SNAPSHOT_CACHE_STATE_KEY]


def _store_option_snapshots_in_cache(snapshots: dict):
    cache = _ensure_option_snapshot_cache()
    now_epoch = time.time()
    now_et = now_et_string()

    for raw_symbol, raw_snapshot in (snapshots or {}).items():
        symbol = normalize_symbol(raw_symbol)
        if not symbol or not isinstance(raw_snapshot, dict):
            continue

        snapshot = raw_snapshot.copy()
        snapshot["contract_symbol"] = symbol
        snapshot["cache_updated_at_epoch"] = now_epoch
        snapshot["cache_updated_at_et"] = now_et
        cache[symbol] = snapshot


def fetch_option_snapshots(
    contract_symbols,
    *,
    force_refresh: bool = False,
    max_age_seconds: int | float | None = None,
) -> dict:
    """Fetch option snapshots through the selected provider with shared session cache."""
    from marketagent.config import OPTION_SNAPSHOT_CACHE_SECONDS

    if max_age_seconds is None and not force_refresh:
        max_age_seconds = OPTION_SNAPSHOT_CACHE_SECONDS

    normalized_symbols = _normalize_contract_symbols_for_cache(contract_symbols)
    if not normalized_symbols:
        return {}

    cache = _ensure_option_snapshot_cache()
    now_epoch = time.time()
    symbols_to_fetch = []

    for symbol in normalized_symbols:
        cached_snapshot = cache.get(symbol)
        if force_refresh or not cached_snapshot:
            symbols_to_fetch.append(symbol)
            continue

        if max_age_seconds is not None:
            age = _quote_age_seconds(cached_snapshot, now_epoch)
            if age is None or age > float(max_age_seconds):
                symbols_to_fetch.append(symbol)

    if symbols_to_fetch:
        provider = get_market_data_provider()
        fetched_snapshots = provider.fetch_option_snapshots(symbols_to_fetch)
        _store_option_snapshots_in_cache(fetched_snapshots)

    refreshed_cache = _ensure_option_snapshot_cache()
    return {
        symbol: refreshed_cache.get(
            symbol,
            {
                "contract_symbol": symbol,
                "status": "missing",
                "error": "No option snapshot cache entry found.",
            },
        )
        for symbol in normalized_symbols
    }


def refresh_option_snapshots(contract_symbols) -> dict:
    """Force-refresh option snapshots for one or more contract symbols."""
    return fetch_option_snapshots(contract_symbols, force_refresh=True, max_age_seconds=0)


def get_option_snapshot_cache_status(contract_symbols) -> dict:
    normalized_symbols = _normalize_contract_symbols_for_cache(contract_symbols)
    cache = _ensure_option_snapshot_cache()
    now_epoch = time.time()

    cached_symbols = []
    missing_symbols = []
    ages = []
    sources = []
    feeds = []
    last_updated_values = []

    for symbol in normalized_symbols:
        snapshot = cache.get(symbol)
        if not snapshot:
            missing_symbols.append(symbol)
            continue

        cached_symbols.append(symbol)
        age = _quote_age_seconds(snapshot, now_epoch)
        if age is not None:
            ages.append(age)

        source = snapshot.get("source")
        if source and source not in sources:
            sources.append(source)

        feed = snapshot.get("feed")
        if feed and feed not in feeds:
            feeds.append(feed)

        cache_updated_at_et = snapshot.get("cache_updated_at_et")
        if cache_updated_at_et:
            last_updated_values.append(cache_updated_at_et)

    return {
        "requested_symbols": list(normalized_symbols),
        "cached_symbols": cached_symbols,
        "missing_symbols": missing_symbols,
        "cached_count": len(cached_symbols),
        "requested_count": len(normalized_symbols),
        "oldest_age_seconds": max(ages) if ages else None,
        "newest_age_seconds": min(ages) if ages else None,
        "sources": sources,
        "source_summary": ", ".join(sources) if sources else "N/A",
        "feeds": feeds,
        "feed_summary": ", ".join(feeds) if feeds else "N/A",
        "last_updated_et": max(last_updated_values) if last_updated_values else None,
    }


# ------------------------------------------------------------
# Option contracts / chain helpers
# ------------------------------------------------------------

@st.cache_data(ttl=300, show_spinner=False)
def fetch_option_bars(
    contract_symbols,
    *,
    timeframe: str = "1Day",
    start: str | None = None,
    end: str | None = None,
    limit: int = 1000,
) -> dict:
    """Fetch option bar volume summaries through the selected provider.

    This is a lightweight reference helper for option volume. It is intentionally
    separate from option snapshots and does not affect P/L calculations.
    """
    provider = get_market_data_provider()
    normalized_symbols = _normalize_contract_symbols_for_cache(contract_symbols)
    if not normalized_symbols:
        return {}
    return provider.fetch_option_bars(
        list(normalized_symbols),
        timeframe=timeframe,
        start=start,
        end=end,
        limit=limit,
    )

@st.cache_data(ttl=300, show_spinner=False)
def fetch_option_contracts(
    underlying_symbol: str,
    *,
    expiration_date: str | None = None,
    expiration_date_gte: str | None = None,
    expiration_date_lte: str | None = None,
    option_type: str | None = None,
    strike_price_gte: float | None = None,
    strike_price_lte: float | None = None,
    limit: int = 1000,
) -> list[dict]:
    """Fetch active option contract metadata through the selected provider."""
    provider = get_market_data_provider()
    filters = {
        "expiration_date": expiration_date,
        "expiration_date_gte": expiration_date_gte,
        "expiration_date_lte": expiration_date_lte,
        "type": str(option_type).lower() if option_type else None,
        "strike_price_gte": strike_price_gte,
        "strike_price_lte": strike_price_lte,
        "limit": limit,
    }
    return provider.fetch_option_contracts(normalize_symbol(underlying_symbol), **filters)


@st.cache_data(ttl=300, show_spinner=False)
def fetch_option_expirations(
    underlying_symbol: str,
    *,
    expiration_date_gte: str | None = None,
    expiration_date_lte: str | None = None,
    limit: int = 1000,
) -> list[str]:
    """Return sorted expiration dates available from Alpaca contracts."""
    contracts = fetch_option_contracts(
        underlying_symbol,
        expiration_date_gte=expiration_date_gte,
        expiration_date_lte=expiration_date_lte,
        limit=limit,
    )
    expirations = []
    for contract in contracts or []:
        exp = str(contract.get("expiration_date") or "").strip()
        if exp and exp not in expirations:
            expirations.append(exp)
    return sorted(expirations)


@st.cache_data(ttl=60, show_spinner=False)
def fetch_option_chain(
    underlying_symbol: str,
    *,
    expiration_date: str | None = None,
    option_type: str | None = None,
    strike_price_gte: float | None = None,
    strike_price_lte: float | None = None,
    limit: int = 1000,
) -> dict:
    """Fetch option-chain snapshots through the selected provider."""
    provider = get_market_data_provider()
    filters = {
        "expiration_date": expiration_date,
        "type": str(option_type).lower() if option_type else None,
        "strike_price_gte": strike_price_gte,
        "strike_price_lte": strike_price_lte,
        "limit": limit,
    }
    return provider.fetch_option_chain(normalize_symbol(underlying_symbol), **filters)
