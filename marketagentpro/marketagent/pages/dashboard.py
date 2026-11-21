import streamlit as st
import time

from marketagent.ai_agent import (
    DASHBOARD_AI_PROMPT_VERSION,
    build_ai_prompt,
    build_no_ai_dashboard_summary,
    build_rule_based_summary,
    call_ai_model,
    call_ai_model_stream,
    get_dashboard_ai_capabilities,
    is_ai_enabled,
    is_weak_dashboard_ai_summary,
)
from marketagent.alerts import evaluate_custom_alerts
from marketagent.charts import (
    MONTHLY_CHART_STYLE_KEY,
    MONTHLY_CHART_STYLES,
    build_volume_context,
    get_visible_chart_data,
    render_price_chart,
)
from marketagent.config import (
    CHART_VIEW_CONFIG,
    DASHBOARD_CHART_CLOSE_MIN_DIFF_PCT,
    DASHBOARD_CHART_CLOSE_NEWER_THAN_QUOTE_SECONDS,
    DASHBOARD_USE_CHART_CLOSE_EXTENDED_HOURS_FALLBACK,
)
from marketagent.indicators import classify_rsi, classify_trend
from marketagent.market_data import (
    fetch_history,
    fetch_latest_quote,
    fetch_latest_quotes,
    fetch_signal_data,
    get_current_market_data_provider_name,
)
from marketagent.news import (
    analyze_news_sentiment,
    article_display_time_et,
    dashboard_stock_news_context,
    dashboard_news_overall_snapshot,
    fetch_google_news,
    format_dashboard_news_context_for_prompt,
    format_dashboard_news_overall_for_prompt,
)
from marketagent.portfolio import get_position
from marketagent.risk import build_chart_levels, evaluate_risk
from marketagent.ui.common import render_indicator_brackets
from marketagent.utils import (
    format_pct,
    format_price,
    format_refresh,
    format_signed_price,
    format_age,
    format_datetime_et,
    get_us_equity_market_status,
    is_extended_hours_et,
    now_et,
    normalize_symbol,
    nullable_float,
    parse_datetime_to_et,
)


def format_price_delta_with_pct(price_delta, reference_price) -> str | None:
    """Format st.metric delta as both dollar value and percentage change."""
    if price_delta is None or reference_price is None or reference_price == 0:
        return format_signed_price(price_delta)

    pct_delta = price_delta / reference_price * 100
    price_text = format_signed_price(price_delta)
    pct_text = format_pct(pct_delta)

    if price_text is None:
        return None

    return f"{price_text} ({pct_text})"



def _et_minutes(dt) -> int | None:
    dt = parse_datetime_to_et(dt)
    if dt is None:
        return None
    return dt.hour * 60 + dt.minute


def _regular_session_close_from_intraday_chart(chart_data, selected_time=None) -> dict:
    """Return the most recent completed regular-session close from intraday chart data.

    This is used as the Current Price delta baseline.  During regular hours and
    pre-market, the baseline is the previous completed market close.  During
    after-hours, the baseline is today's regular-session close when the chart has it.
    """
    if chart_data is None or chart_data.empty or "Close" not in chart_data.columns:
        return {}

    selected_dt = parse_datetime_to_et(selected_time) or now_et()
    selected_minutes = _et_minutes(selected_dt)
    regular_start = 9 * 60 + 30
    regular_end = 16 * 60

    regular_rows = []
    for idx, close_value in chart_data["Close"].dropna().items():
        et_dt = parse_datetime_to_et(idx)
        if et_dt is None or et_dt.weekday() >= 5:
            continue
        minutes = _et_minutes(et_dt)
        if minutes is None:
            continue
        if regular_start <= minutes <= regular_end:
            try:
                regular_rows.append((et_dt, float(close_value)))
            except Exception:
                continue

    if not regular_rows:
        return {}

    current_date = selected_dt.date()
    if selected_dt.weekday() < 5 and selected_minutes is not None and selected_minutes >= regular_end:
        eligible = [row for row in regular_rows if row[0].date() <= current_date]
    else:
        eligible = [row for row in regular_rows if row[0].date() < current_date]

    if not eligible:
        return {}

    target_date = max(row[0].date() for row in eligible)
    target_rows = [row for row in eligible if row[0].date() == target_date]
    close_time, close_price = target_rows[-1]

    return {
        "price": close_price,
        "time": close_time,
        "time_et": format_datetime_et(close_time),
        "source": "intraday regular-session close",
    }


def _regular_session_close_from_daily_history(symbol: str, selected_time=None) -> dict:
    """Fallback baseline from daily regular-session history."""
    selected_dt = parse_datetime_to_et(selected_time) or now_et()
    selected_minutes = _et_minutes(selected_dt)
    regular_end = 16 * 60

    try:
        daily_data = fetch_history(symbol=symbol, period="10d", interval="1d", prepost=False)
    except Exception:
        return {}

    if daily_data is None or daily_data.empty or "Close" not in daily_data.columns:
        return {}

    rows = []
    for idx, close_value in daily_data["Close"].dropna().items():
        et_dt = parse_datetime_to_et(idx)
        if et_dt is None:
            continue
        try:
            rows.append((et_dt.date(), float(close_value)))
        except Exception:
            continue

    if not rows:
        return {}

    current_date = selected_dt.date()
    if selected_dt.weekday() < 5 and selected_minutes is not None and selected_minutes >= regular_end:
        eligible = [row for row in rows if row[0] <= current_date]
    else:
        eligible = [row for row in rows if row[0] < current_date]

    if not eligible:
        eligible = rows

    target_date, close_price = sorted(eligible, key=lambda row: row[0])[-1]
    close_time_et = f"{target_date} 16:00:00 ET"

    return {
        "price": close_price,
        "time": close_time_et,
        "time_et": close_time_et,
        "source": "daily regular close",
    }


def get_recent_market_close_reference(symbol: str, chart_data, selected_time=None) -> dict:
    """Return the baseline used for Current Price delta.

    Standard quote UIs compare current/extended-hours price to the most recent
    completed regular-session close, not the previous chart tick.
    """
    reference = _regular_session_close_from_intraday_chart(chart_data, selected_time)
    if reference.get("price") is not None:
        return reference

    reference = _regular_session_close_from_daily_history(symbol, selected_time)
    if reference.get("price") is not None:
        return reference

    return {"price": None, "time": None, "time_et": "N/A", "source": "unavailable"}



def price_method_label(price_method: str | None, source: str | None = None) -> str:
    """Return a concise human-readable label for the selected current price."""
    method = (price_method or "").strip().lower()

    labels = {
        "alpaca_last_trade": "Alpaca last trade",
        "yfinance_close": "yfinance close",
        "alpaca_quote_mid": "Alpaca bid/ask mid",
        "alpaca_quote_mid_newer_than_trade": "Alpaca quote mid (newer)",
        "alpaca_quote_mid_wide_spread": "Alpaca quote mid (wide spread)",
        "yfinance_chart_close_extended_hours": "yfinance chart close (extended-hours fallback)",
        "unavailable": "Unavailable",
    }

    if method in labels:
        return labels[method]

    source_text = (source or "").lower()
    if "latest_trade" in source_text:
        return "Alpaca last trade"
    if "yfinance" in source_text:
        return "yfinance close"
    if "quote_mid" in source_text:
        return "Alpaca bid/ask fallback"

    return source or "Unknown"




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


def apply_extended_hours_chart_price_fallback(
    latest_quote: dict | None,
    chart_data,
    chart_view: str,
    chart_config: dict,
) -> dict:
    """Dashboard-only fallback to make Current Price follow the visible chart.

    This intentionally avoids changing the global provider or Portfolio/Options
    pricing. It only applies to Today/2 Days charts using pre/post-market data.
    If the visible yfinance chart has a newer extended-hours candle than Alpaca
    selected/trade time, and the price has actually moved, Dashboard Current
    Price uses the latest chart close.
    """
    quote = (latest_quote or {}).copy()
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
        "Dashboard used the latest yfinance chart close because the visible extended-hours candle "
        "is newer than the selected provider price. This fallback only affects Dashboard Today/2 Days "
        "and does not change Portfolio or Options pricing."
    )
    return quote

def render_price_diagnostics(latest_quote: dict | None):
    """Compact collapsed diagnostics for price-source troubleshooting."""
    latest_quote = latest_quote or {}

    with st.expander("Price Diagnostics", expanded=False):
        st.caption("Selected price priority: Alpaca latest trade → reasonable Alpaca quote mid → Dashboard yfinance chart-close fallback in extended hours → yfinance fallback.")

        method = price_method_label(
            latest_quote.get("price_method"),
            latest_quote.get("source"),
        )

        bid = latest_quote.get("bid")
        ask = latest_quote.get("ask")
        spread = None
        spread_pct = None

        if bid is not None and ask is not None and bid > 0 and ask > 0:
            spread = ask - bid
            spread_pct = spread / bid * 100 if bid else None

        d_col_1, d_col_2, d_col_3 = st.columns(3)

        with d_col_1:
            st.metric("Selected", format_price(latest_quote.get("price")))
            st.caption(method)

        with d_col_2:
            st.metric("Last Trade", format_price(latest_quote.get("last")))
            st.caption(format_datetime_et(latest_quote.get("trade_timestamp")) if latest_quote.get("trade_timestamp") else "Trade time: N/A")

        with d_col_3:
            st.metric("Chart Close", format_price(latest_quote.get("chart_latest_close")))
            st.caption(latest_quote.get("chart_latest_time_et") or "Chart time: N/A")

        q_col_1, q_col_2, q_col_3 = st.columns(3)

        with q_col_1:
            st.write(f"Bid: {format_price(bid)}")

        with q_col_2:
            st.write(f"Ask: {format_price(ask)}")

        with q_col_3:
            spread_text = "N/A"
            if spread is not None:
                spread_text = f"{format_signed_price(spread)} ({format_pct(spread_pct)})"
            st.write(f"Spread: {spread_text}")

        details = []
        if latest_quote.get("quote_timestamp"):
            details.append(f"Quote time ET: {format_datetime_et(latest_quote.get('quote_timestamp'))}")
        if latest_quote.get("feed"):
            details.append(f"Feed: {latest_quote.get('feed')}")
        spread_pct = latest_quote.get("quote_mid_spread_pct")
        try:
            if spread_pct is not None:
                details.append(f"Spread: {float(spread_pct):.2f}%")
        except Exception:
            pass
        quote_minus_trade_seconds = latest_quote.get("quote_minus_trade_seconds")
        try:
            if quote_minus_trade_seconds is not None:
                details.append(f"Quote - Trade: {float(quote_minus_trade_seconds):.0f}s")
        except Exception:
            pass
        chart_minus_selected_seconds = latest_quote.get("chart_minus_selected_price_seconds")
        try:
            if chart_minus_selected_seconds is not None:
                details.append(f"Chart - selected: {float(chart_minus_selected_seconds):.0f}s")
        except Exception:
            pass
        chart_diff_pct = latest_quote.get("chart_vs_selected_price_diff_pct")
        try:
            if chart_diff_pct is not None:
                details.append(f"Chart vs selected diff: {float(chart_diff_pct):.2f}%")
        except Exception:
            pass
        if latest_quote.get("source"):
            details.append(f"Raw source: {latest_quote.get('source')}")

        if details:
            st.caption(" · ".join(details))

        if latest_quote.get("fallback_reason"):
            st.caption(latest_quote.get("fallback_reason"))

        if latest_quote.get("error"):
            st.caption(f"Error: {latest_quote.get('error')}")




def _selected_price_time(latest_quote: dict | None):
    """Return the timestamp that represents the selected current price."""
    latest_quote = latest_quote or {}
    return (
        latest_quote.get("timestamp")
        or latest_quote.get("chart_latest_time_et")
        or latest_quote.get("trade_timestamp")
        or latest_quote.get("quote_timestamp")
    )


def assess_selected_price_freshness(latest_quote: dict | None, market_status: dict | None) -> dict:
    """Classify selected price freshness relative to the current market session."""
    latest_quote = latest_quote or {}
    market_status = market_status or get_us_equity_market_status()
    selected_time = _selected_price_time(latest_quote)
    selected_dt = parse_datetime_to_et(selected_time)

    if selected_dt is None:
        return {
            "status": "unknown",
            "label": "Price time unavailable",
            "caption": "Selected price timestamp is missing, so freshness cannot be assessed.",
            "age_seconds": None,
        }

    current_dt = now_et()
    age_seconds = max((current_dt - selected_dt).total_seconds(), 0)
    age_text = format_age(age_seconds)

    if market_status.get("is_closed"):
        return {
            "status": "closed_ok",
            "label": "Market closed",
            "caption": f"Selected price time: {format_datetime_et(selected_dt)} ({age_text}). Stale quotes are normal while the market is closed.",
            "age_seconds": age_seconds,
        }

    threshold = market_status.get("stale_threshold_seconds") or 300
    if age_seconds > threshold:
        return {
            "status": "stale_warning",
            "label": "Possible stale price",
            "caption": f"Selected price time: {format_datetime_et(selected_dt)} ({age_text}). This is older than the {format_refresh(int(threshold))} threshold for {market_status.get('label')}.",
            "age_seconds": age_seconds,
        }

    return {
        "status": "fresh",
        "label": "Price fresh",
        "caption": f"Selected price time: {format_datetime_et(selected_dt)} ({age_text}).",
        "age_seconds": age_seconds,
    }


def render_market_status_banner(market_status: dict):
    """Render a compact dashboard-wide US equity session banner."""
    label = market_status.get("label", "Unknown")
    description = market_status.get("description", "")
    next_label = market_status.get("next_session_label")
    next_time = market_status.get("next_session_time_et")
    next_in = market_status.get("next_session_in")

    message = f"**Market Status: {label}**"
    if next_label and next_time:
        message += f" · {next_label}: {format_datetime_et(next_time)}"
        if next_in:
            message += f" · in {next_in}"
    if description:
        message += f"\n\n{description}"

    if market_status.get("is_regular"):
        st.success(message)
    elif market_status.get("is_extended"):
        st.info(message)
    else:
        st.warning(message)


def render_symbol_price_freshness(latest_quote: dict | None, market_status: dict | None):
    freshness = assess_selected_price_freshness(latest_quote, market_status)
    status = freshness.get("status")
    caption = freshness.get("caption")

    if not caption:
        return

    if status == "stale_warning":
        st.warning(caption)
    else:
        st.caption(caption)



def _stock_articles_to_dashboard_news_items(articles: list[dict]) -> list[dict]:
    """Convert normalized Stock News articles into the lightweight Dashboard news item shape."""
    items = []
    for article in articles or []:
        items.append(
            {
                "title": article.get("original_title") or article.get("translated_title_zh") or "",
                "source": article.get("publisher") or article.get("source") or "Stock News",
                "link": article.get("original_link") or "",
                "pub_date": article.get("published_at") or "",
                "description": article.get("description") or article.get("summary_zh") or "",
            }
        )
    return items


def _short_text(value, max_chars: int = 260) -> str:
    text = str(value or "").strip()
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 1].rstrip() + "..."


def _format_cached_news_context_compact(articles: list[dict]) -> str:
    """Compact cached news evidence so local Ollama calls stay responsive."""
    lines = []
    for idx, article in enumerate(articles or [], start=1):
        title = article.get("translated_title_zh") or article.get("original_title") or "Untitled"
        published = article_display_time_et(article, "published_at") or "N/A"
        event_type = article.get("event_type") or "General"
        impact = article.get("impact") or "Unclear"
        importance = article.get("importance") or "N/A"
        summary = (
            article.get("summary_zh")
            or article.get("impact_reason_zh")
            or article.get("impact_analysis_zh")
            or article.get("description")
            or ""
        )
        lines.append(
            "\n".join(
                [
                    f"[{idx}] {_short_text(title, 180)}",
                    f"- Published: {published}; Event: {event_type}; Importance: {importance}; Impact: {impact}",
                    f"- Cached summary: {_short_text(summary, 360) or 'No cached summary text.'}",
                ]
            )
        )
    return "\n\n".join(lines) if lines else "- No cached stock-specific news context found."


def _build_compact_dashboard_ai_prompt(
    symbol: str,
    current_price,
    chart_view: str,
    signal_data: dict,
    risk_analysis: dict,
    alerts: dict,
    volume_context: dict | None,
    stock_news_context_text: str,
    stock_news_overall_text: str,
    language_mode: str,
    output_length: str,
) -> str:
    hourly = signal_data.get("1H", {}).get("snapshot", {})
    daily = signal_data.get("Daily", {}).get("snapshot", {})
    volume_summary = (volume_context or {}).get("summary", "N/A")
    if language_mode == "english_only":
        language_note = (
            "Answer in English only. Section headers, bullets, and conclusions "
            "must all be written in English."
        )
        length_note = {
            "short": "Keep it very concise: 4 sections, 1-2 bullets each.",
            "medium": "Keep it concise: 4 sections, 2 bullets each.",
            "long": "Use moderate detail, but avoid long background explanations.",
        }.get(output_length, "Keep it concise.")
        section_contract = """Return Markdown with exactly these sections:
## 1. One-line conclusion
- Setup direction and confidence. Mention the key cached news citation like [1].
## 2. Cached news impact
- Synthesize the cached news. Cite [1], [2] when available.
## 3. Technical verification
- Compare news direction with 1H/Daily EMA and RSI.
## 4. Watch next
- Give 3 watch items: price/technical, news/event, risk."""
    else:
        language_note = {
            "chinese": "请用中文回答，保留 ticker、RSI、EMA20、EMA50 等英文术语。",
            "bilingual": "请用中文为主、英文术语为辅回答。",
        }.get(language_mode, "请用中文回答。")
        length_note = {
            "short": "控制在 4 个 section、每个 1-2 个 bullet，非常简洁。",
            "medium": "保持简洁：4 个 section、每个 2 个 bullet。",
            "long": "使用适度细节，但避免冗长背景说明。",
        }.get(output_length, "保持简洁。")
        section_contract = """Return Markdown with exactly these sections:
## 1. 一句话结论
- Setup 方向和置信度。提及关键缓存新闻引用，如 [1]。
## 2. 缓存新闻影响
- 综合缓存新闻。有可用时引用 [1], [2]。
## 3. 技术面验证
- 对比新闻方向与 1H/Daily EMA 和 RSI。
## 4. 接下来关注
- 给出 3 个关注项：价格/技术、新闻/事件、风险。"""

    return f"""
You are MarketAgentPro's Dashboard analyst for {symbol}. Use ONLY the cached news evidence below.
{language_note}
{length_note}

Price / chart:
- Current price: {format_price(current_price)}
- Chart view: {chart_view}
- 1H: close {format_price(hourly.get("close"))}, EMA20 {format_price(hourly.get("ema20"))}, EMA50 {format_price(hourly.get("ema50"))}, RSI {hourly.get("rsi")} ({classify_rsi(hourly.get("rsi"))}), trend {classify_trend(current_price or hourly.get("close"), hourly.get("ema20"), hourly.get("ema50"))}
- Daily: close {format_price(daily.get("close"))}, EMA20 {format_price(daily.get("ema20"))}, EMA50 {format_price(daily.get("ema50"))}, RSI {daily.get("rsi")} ({classify_rsi(daily.get("rsi"))}), trend {classify_trend(current_price or daily.get("close"), daily.get("ema20"), daily.get("ema50"))}
- Volume: {volume_summary}
- Risk: {risk_analysis.get("risk_level")} ({risk_analysis.get("risk_points")} pts); reasons: {risk_analysis.get("reasons")}
- Alerts: triggered {alerts.get("triggered")}; watching {alerts.get("watching")}

Cached news snapshot:
{stock_news_overall_text}

Cached numbered news:
{stock_news_context_text}

{section_contract}
""".strip()


def _dashboard_ai_is_running() -> bool:
    return any(
        str(key).endswith("_dashboard_ai_run_lock") and bool(value)
        for key, value in st.session_state.items()
    )


def render_dashboard_page(
    auto_refresh: bool,
    auto_ai_on_risk_change: bool,
    ollama_model: str | None = None,
    ai_settings: dict | None = None,
    has_autorefresh: bool = False,
    st_autorefresh_func=None,
):
    ai_settings = ai_settings or {}
    ollama_model = ollama_model or ai_settings.get("ollama_model") or "qwen2.5:14b"
    ollama_num_ctx = int(ai_settings.get("ollama_num_ctx", 16384))
    ollama_temperature = float(ai_settings.get("ollama_temperature", 0.3))

    st.title("📈 MarketAgentPro")

    market_status = get_us_equity_market_status()
    render_market_status_banner(market_status)

    chart_view = st.radio(
        "Chart View",
        options=["Today", "2 Days", "Month", "52 Weeks"],
        horizontal=True,
        index=0,
    )

    chart_config = CHART_VIEW_CONFIG[chart_view]

    page_refresh_seconds = min(
        chart_config["refresh_seconds"],
        chart_config.get("live_quote_refresh_seconds", chart_config["refresh_seconds"]),
    )

    # When the user clicked an AI run button in THIS run, the run lock is not
    # set yet (it is set later in the per-symbol AI panel). If we armed the
    # auto-refresh timer here, it could fire mid-generation and Streamlit would
    # abort the AI run (showing "interrupted" with no summary). Detect the
    # button click from widget state and skip arming the timer in that run.
    ai_run_clicked_in_run = any(
        str(key).endswith("_run_ai_button") and bool(value)
        for key, value in st.session_state.items()
    )

    if (
        auto_refresh
        and has_autorefresh
        and st_autorefresh_func is not None
        and not _dashboard_ai_is_running()
        and not ai_run_clicked_in_run
    ):
        st_autorefresh_func(
            interval=page_refresh_seconds * 1000,
            key=f"refresh_{chart_view}",
        )
    elif auto_refresh and (_dashboard_ai_is_running() or ai_run_clicked_in_run):
        st.caption("Dashboard auto-refresh is paused while AI Summary is running.")

    top_col_1, top_col_2, top_col_3, top_col_4, top_col_5 = st.columns(5)

    with top_col_1:
        st.metric("Displayed Stocks", len(st.session_state.display_symbols))

    with top_col_2:
        st.metric("Chart Interval", chart_config["interval"])

    with top_col_3:
        st.metric("Page Refresh", format_refresh(page_refresh_seconds))

    with top_col_4:
        st.metric("Signals", "1H + Daily")

    with top_col_5:
        st.metric("Data Provider", get_current_market_data_provider_name())

    st.caption(
        f"Chart: {chart_view} · "
        f"{chart_config['interval']} · "
        f"chart refresh {format_refresh(chart_config['refresh_seconds'])} · "
        f"quote refresh {format_refresh(chart_config.get('live_quote_refresh_seconds', chart_config['refresh_seconds']))} · "
        f"{chart_config['session_label']} | "
        f"Signals: 1H + Daily"
    )

    st.caption(chart_config["description"])

    control_col_1, control_col_2, control_col_3, control_col_4 = st.columns([1, 1.2, 1.8, 4.0])

    with control_col_1:
        if st.button("Refresh Now", use_container_width=True):
            st.cache_data.clear()
            st.rerun()

    with control_col_2:
        show_volume = st.checkbox("Show Volume", value=True, key="dashboard_show_volume")

    with control_col_3:
        chart_style = "Line"
        if chart_view in ["Month", "52 Weeks"]:
            chart_style = st.radio(
                "Chart Style",
                options=MONTHLY_CHART_STYLES,
                horizontal=True,
                key=MONTHLY_CHART_STYLE_KEY,
                index=0,
            )
        else:
            st.caption("Chart Style: Line")

    with control_col_4:
        st.caption(
            "Use the left sidebar to add/delete symbols and choose multiple stocks to display."
        )

    render_indicator_brackets()

    display_symbols = [
        normalize_symbol(symbol)
        for symbol in st.session_state.display_symbols
        if normalize_symbol(symbol)
    ]

    if not display_symbols:
        st.warning("Please select at least one stock to display from the left sidebar.")
        st.stop()

    latest_quotes = fetch_latest_quotes(tuple(display_symbols))

    for display_symbol in display_symbols:
        render_symbol_dashboard(
            symbol=display_symbol,
            chart_view=chart_view,
            chart_config=chart_config,
            latest_quote=latest_quotes.get(display_symbol),
            market_status=market_status,
            auto_ai_on_risk_change=auto_ai_on_risk_change,
            ollama_model=ollama_model,
            ollama_num_ctx=ollama_num_ctx,
            ollama_temperature=ollama_temperature,
            ai_settings=ai_settings,
            show_volume=show_volume,
            chart_style=chart_style,
        )


def render_symbol_dashboard(
    symbol: str,
    chart_view: str,
    chart_config: dict,
    latest_quote: dict | None,
    market_status: dict | None,
    auto_ai_on_risk_change: bool,
    ollama_model: str,
    ollama_num_ctx: int = 16384,
    ollama_temperature: float = 0.3,
    ai_settings: dict | None = None,
    show_volume: bool = True,
    chart_style: str = "Line",
):
    ai_settings = ai_settings or {}
    ai_capability = get_dashboard_ai_capabilities(ai_settings)
    dashboard_news_limit = int(ai_capability.get("dashboard_max_news_items") or 5)
    with st.container(border=True):
        st.subheader(f"{symbol}")

        with st.spinner(f"Loading {symbol} market data..."):
            chart_data = fetch_history(
                symbol=symbol,
                period=chart_config["period"],
                interval=chart_config["interval"],
                prepost=chart_config["prepost"],
            )

            if latest_quote is None:
                latest_quote = fetch_latest_quote(symbol)
            latest_quote = apply_extended_hours_chart_price_fallback(
                latest_quote,
                chart_data,
                chart_view,
                chart_config,
            )
            latest_price = latest_quote.get("price")
            signal_data = fetch_signal_data(symbol)
            news_items = fetch_google_news(symbol)
            news_sentiment = analyze_news_sentiment(news_items)
            stock_news_context = dashboard_stock_news_context(
                symbol,
                news_items=None,
                max_items=dashboard_news_limit,
                days=14,
                cached_only=True,
            )
            stock_news_context_text = format_dashboard_news_context_for_prompt(stock_news_context)

        if chart_data is None or chart_data.empty:
            st.error(f"No chart data found for {symbol}. Please check the symbol.")
            return

        chart_last_price = nullable_float(chart_data["Close"].iloc[-1])
        current_price = latest_price or chart_last_price

        selected_price_time = _selected_price_time(latest_quote)
        market_close_reference = get_recent_market_close_reference(symbol, chart_data, selected_time=selected_price_time)
        reference_price = nullable_float(market_close_reference.get("price"))

        price_delta = None
        price_delta_display = None

        if current_price is not None and reference_price is not None:
            price_delta = current_price - reference_price
            price_delta_display = format_price_delta_with_pct(price_delta, reference_price)

        visible_chart_data = get_visible_chart_data(chart_data, chart_view)
        if visible_chart_data is None or visible_chart_data.empty:
            visible_chart_data = chart_data

        effective_chart_style = chart_style if chart_view in ["Month", "52 Weeks"] else "Line"
        chart_levels = build_chart_levels(visible_chart_data, chart_style=effective_chart_style)
        volume_context = build_volume_context(visible_chart_data, chart_view=chart_view)
        position_data = get_position(symbol)

        chart_col, ai_col = st.columns([2.4, 1.1])

        with chart_col:
            price_metric_col, high_metric_col, low_metric_col = st.columns(3)

            with price_metric_col:
                st.metric(
                    "Current Price",
                    format_price(current_price),
                    delta=price_delta_display,
                )
                quote_source = price_method_label(
                    latest_quote.get("price_method"),
                    latest_quote.get("source"),
                )
                quote_time = format_datetime_et(latest_quote.get("timestamp")) if latest_quote.get("timestamp") else "N/A"
                st.caption(f"Price source: {quote_source} · {quote_time}")
                if reference_price is not None:
                    st.caption(
                        f"Change vs last market close: {format_price(reference_price)} · "
                        f"{market_close_reference.get('time_et', 'N/A')} · "
                        f"{market_close_reference.get('source', 'regular close')}"
                    )
                render_symbol_price_freshness(latest_quote, market_status)
                if latest_quote.get("status") == "fallback" and latest_quote.get("error"):
                    st.caption("Using fallback price because Alpaca quote/trade request failed.")

            with high_metric_col:
                st.metric(
                    "Displayed High",
                    format_price(chart_levels.get("range_high")),
                )

            with low_metric_col:
                st.metric(
                    "Displayed Low",
                    format_price(chart_levels.get("range_low")),
                )

            last_candle_time = "N/A"
            try:
                last_candle_time = visible_chart_data.index[-1].strftime("%Y-%m-%d %H:%M:%S ET")
            except Exception:
                pass
            st.caption(f"Last Displayed Candle Time: {last_candle_time}")
            render_price_diagnostics(latest_quote)

            render_price_chart(
                chart_data,
                symbol,
                chart_view,
                show_volume=show_volume,
                chart_style=effective_chart_style,
            )

        with ai_col:
            render_symbol_ai_panel(
                symbol=symbol,
                current_price=current_price,
                chart_view=chart_view,
                chart_config=chart_config,
                chart_levels=chart_levels,
                signal_data=signal_data,
                news_items=news_items,
                news_sentiment=news_sentiment,
                position_data=position_data,
                volume_context=volume_context,
                stock_news_context=stock_news_context,
                stock_news_context_text=stock_news_context_text,
                auto_ai_on_risk_change=auto_ai_on_risk_change,
                ollama_model=ollama_model,
                ollama_num_ctx=ollama_num_ctx,
                ollama_temperature=ollama_temperature,
                ai_settings=ai_settings,
            )

        render_recent_news(symbol, news_items)


def render_symbol_ai_panel(
    symbol: str,
    current_price,
    chart_view: str,
    chart_config: dict,
    chart_levels: dict,
    signal_data: dict,
    news_items: list,
    news_sentiment: dict,
    position_data: dict,
    volume_context: dict | None,
    stock_news_context: list[dict] | None,
    stock_news_context_text: str | None,
    auto_ai_on_risk_change: bool,
    ollama_model: str,
    ollama_num_ctx: int = 16384,
    ollama_temperature: float = 0.3,
    ai_settings: dict | None = None,
):
    st.markdown("### AI Analysis")
    stock_news_context = stock_news_context or []
    stock_news_context_text = stock_news_context_text or format_dashboard_news_context_for_prompt(stock_news_context)
    stock_news_overall_text = format_dashboard_news_overall_for_prompt(stock_news_context)

    shares = float(position_data.get("shares", 0.0))
    cost = float(position_data.get("cost", 0.0))
    alert_above = float(position_data.get("alert_above", 0.0))
    alert_below = float(position_data.get("alert_below", 0.0))
    pnl_warning_pct = float(position_data.get("pnl_warning_pct", 5.0))

    with st.expander("Portfolio Alerts", expanded=False):
        st.caption("Manage shares, average cost, and alert levels in Portfolio > Holdings.")

        if alert_above > 0:
            st.write(f"Break Above: {format_price(alert_above)}")
        else:
            st.write("Break Above: N/A")

        if alert_below > 0:
            st.write(f"Stop Breakdown: {format_price(alert_below)}")
        else:
            st.write("Stop Breakdown: N/A")

        st.write(f"P/L Warning: -{pnl_warning_pct:.2f}%")

        if shares > 0 and cost > 0:
            st.caption(f"Position detected: {shares:,.2f} shares @ {format_price(cost)} average cost.")
        else:
            st.caption("No active holding saved for this symbol.")

    risk_analysis = evaluate_risk(
        current_price=current_price,
        signal_data=signal_data,
        news_sentiment=news_sentiment,
        chart_levels=chart_levels,
        shares=shares,
        cost_price=cost,
    )

    alerts = evaluate_custom_alerts(
        current_price=current_price,
        risk_analysis=risk_analysis,
        alert_above=alert_above,
        alert_below=alert_below,
        pnl_warning_pct=pnl_warning_pct,
    )

    rule_based_summary = build_rule_based_summary(
        symbol=symbol,
        current_price=current_price,
        signal_data=signal_data,
        news_sentiment=news_sentiment,
        risk_analysis=risk_analysis,
        alerts=alerts,
    )

    risk_level = risk_analysis.get("risk_level", "Unknown")
    risk_points = risk_analysis.get("risk_points", 0)

    if risk_level in ["High", "Extreme"]:
        st.error(f"Risk Level: {risk_level}")
    elif risk_level == "Medium":
        st.warning(f"Risk Level: {risk_level}")
    elif risk_level == "Low":
        st.success(f"Risk Level: {risk_level}")
    else:
        st.info(f"Risk Level: {risk_level}")

    st.caption(
        f"Risk Points: {risk_points:.1f} | "
        "Signals use 1H + Daily, not chart interval."
    )

    st.markdown("#### Alert Status")

    if alerts.get("triggered"):
        for alert in alerts.get("triggered", []):
            st.error(alert)

    if alerts.get("watching"):
        for item in alerts.get("watching", []):
            st.info(item)

    st.markdown("#### Live Summary")
    st.write(rule_based_summary)


    render_technical_blocks(current_price, signal_data)
    render_news_impact(news_sentiment)
    render_dashboard_news_context(symbol, stock_news_context)
    render_risk_watch_sections(risk_analysis)
    render_ollama_summary(
        symbol=symbol,
        current_price=current_price,
        chart_view=chart_view,
        chart_config=chart_config,
        signal_data=signal_data,
        news_items=news_items,
        news_sentiment=news_sentiment,
        risk_analysis=risk_analysis,
        alerts=alerts,
        volume_context=volume_context,
        stock_news_context=stock_news_context,
        stock_news_context_text=stock_news_context_text,
        stock_news_overall_text=stock_news_overall_text,
        risk_level=risk_level,
        risk_points=risk_points,
        auto_ai_on_risk_change=auto_ai_on_risk_change,
        ollama_model=ollama_model,
        ollama_num_ctx=ollama_num_ctx,
        ollama_temperature=ollama_temperature,
        ai_settings=ai_settings,
    )


def _technical_status_summary(current_price, snapshot: dict) -> str:
    close = snapshot.get("close")
    ema20 = snapshot.get("ema20")
    ema50 = snapshot.get("ema50")
    rsi = snapshot.get("rsi")
    trend = classify_trend(current_price or close, ema20, ema50)
    rsi_text = f"RSI {rsi:.2f} · {classify_rsi(rsi)}" if rsi is not None else "RSI N/A"
    return f"Trend: {trend} · {rsi_text}"


def render_technical_blocks(current_price, signal_data: dict):
    hourly = signal_data.get("1H", {}).get("snapshot", {})
    daily = signal_data.get("Daily", {}).get("snapshot", {})

    st.caption(
        "Technicals are collapsed by default to keep the AI panel compact. "
        "Open each section for full 1H / Daily details."
    )

    with st.expander(f"1H Technicals · {_technical_status_summary(current_price, hourly)}", expanded=False):
        st.write(f"Close: {format_price(hourly.get('close'))}")
        st.write(f"EMA20: {format_price(hourly.get('ema20'))}")
        st.write(f"EMA50: {format_price(hourly.get('ema50'))}")

        if hourly.get("rsi") is not None:
            st.write(f"RSI: {hourly.get('rsi'):.2f} · {classify_rsi(hourly.get('rsi'))}")
        else:
            st.write("RSI: N/A")

        h_trend = classify_trend(
            current_price or hourly.get("close"),
            hourly.get("ema20"),
            hourly.get("ema50"),
        )
        st.write(f"Trend: {h_trend}")

    with st.expander(f"Daily Technicals · {_technical_status_summary(current_price, daily)}", expanded=False):
        st.write(f"Open Price: {format_price(daily.get('open'))}")
        st.write(f"Close Price: {format_price(daily.get('close'))}")
        st.write(f"EMA20: {format_price(daily.get('ema20'))}")
        st.write(f"EMA50: {format_price(daily.get('ema50'))}")

        if daily.get("rsi") is not None:
            st.write(f"RSI: {daily.get('rsi'):.2f} · {classify_rsi(daily.get('rsi'))}")
        else:
            st.write("RSI: N/A")

        d_trend = classify_trend(
            current_price or daily.get("close"),
            daily.get("ema20"),
            daily.get("ema50"),
        )
        st.write(f"Trend: {d_trend}")


def render_news_impact(news_sentiment: dict):
    label = news_sentiment.get("label") or "Neutral"
    summary = news_sentiment.get("summary") or "Lightweight headline keyword signal."
    st.markdown(f"**Tone:** {label}")
    st.caption(f"{summary} This is only a lightweight keyword signal; the full AI Summary below performs the detailed news analysis when an AI provider is connected.")


def render_risk_watch_sections(risk_analysis: dict):
    with st.expander("Risk Reasons", expanded=False):
        for reason in risk_analysis.get("reasons", []):
            st.write(f"- {reason}")

    with st.expander("Watch Items", expanded=False):
        for item in risk_analysis.get("watch_items", []):
            st.write(f"- {item}")


def jump_to_stock_news(symbol: str):
    """Switch sidebar page to News and preselect the Stock News view/ticker.

    We cannot safely mutate Streamlit widget keys such as main_page_selector
    after the sidebar radio has already been created in the same run. Instead
    we store a pending navigation request and let the sidebar apply it before
    widgets are instantiated on the next run.
    """
    st.session_state["_pending_main_page"] = "News"
    st.session_state["_pending_news_view"] = "Stock News"
    st.session_state["_pending_news_symbol"] = symbol
    st.rerun()


def render_dashboard_news_context(symbol: str, stock_news_context: list[dict]):
    snapshot = dashboard_news_overall_snapshot(stock_news_context) if stock_news_context else {}
    count = snapshot.get("count", 0)
    combined_signal = snapshot.get("combined_signal", "N/A")
    confidence = snapshot.get("confidence", "N/A")

    col1, col2 = st.columns([1.4, 1])
    with col1:
        st.caption(
            f"News evidence is collapsed by default. "
            f"Current context: {count} article(s) · Signal: {combined_signal} · Confidence: {confidence}."
        )
    with col2:
        if st.button(f"Open {symbol} in News", use_container_width=True, key=f"open_news_{symbol}"):
            jump_to_stock_news(symbol)

    expander_title = f"News Evidence for AI · {symbol} · {count} article(s) · Signal: {combined_signal}"
    with st.expander(expander_title, expanded=False):
        st.caption(
            "This single block combines the former News Evidence for AI and News evidence details sections. "
            "It shows the evidence used by the AI Summary. When AI is Off, this remains source-only evidence; when Ollama is connected, it is sent to the model."
        )

        if not stock_news_context:
            st.info("No recent stock-specific news context found yet. Refresh AI Summary or open News to build the cache.")
            return

        impact_counts = snapshot.get("impact_counts", {})
        importance_counts = snapshot.get("importance_counts", {})
        top_events = snapshot.get("top_events", [])
        top_events_text = ", ".join([f"{name} x{count}" for name, count in top_events]) or "N/A"

        st.caption(
            f"Evidence: {snapshot.get('count', 0)} article(s) · "
            f"Signal: {snapshot.get('combined_signal', 'N/A')} · "
            f"Confidence: {snapshot.get('confidence', 'N/A')} · "
            f"Cached: {snapshot.get('cached_count', 0)} · "
            f"Headline-only: {snapshot.get('headline_only_count', 0)}"
        )
        st.caption(
            f"Impact mix: Bullish {impact_counts.get('Bullish', 0)} / "
            f"Bearish {impact_counts.get('Bearish', 0)} / "
            f"Neutral {impact_counts.get('Neutral', 0)} / "
            f"Mixed {impact_counts.get('Mixed', 0)} / "
            f"Unclear {impact_counts.get('Unclear', 0)} · "
            f"High importance: {importance_counts.get('High', 0)} · "
            f"Top events: {top_events_text}"
        )

        priority_items = snapshot.get("high_impact_items") or snapshot.get("latest_items") or []
        if priority_items:
            st.markdown("**Priority news evidence**")
            for item in priority_items[:3]:
                confidence_note = "headline-only" if item.get("headline_only") else "cached summary"
                st.write(
                    f"- [{item.get('idx')}] {item.get('title')} · "
                    f"{item.get('event_type')} · {item.get('importance')} · "
                    f"{item.get('impact')} · {confidence_note}"
                )

        st.markdown(f"**Detailed news evidence for {symbol}**")
        for idx, article in enumerate(stock_news_context[:6], start=1):
            title = article.get("translated_title_zh") or article.get("original_title") or "Untitled"
            link = article.get("original_link") or ""
            published = article_display_time_et(article, "published_at") or "N/A"
            impact = article.get("impact") or "Unclear"
            importance = article.get("importance") or "N/A"
            event_type = article.get("event_type") or "General"
            status = article.get("dashboard_context_status") or article.get("cache_status") or "News"

            if link:
                st.markdown(f"**[{idx}. {title}]({link})**")
            else:
                st.markdown(f"**{idx}. {title}**")
            st.caption(f"{published} · {status} · {event_type} · {importance} · {impact}")

            summary = article.get("summary_zh") or article.get("impact_analysis_zh") or article.get("description")
            if summary:
                st.write(summary)
            st.write("---")

        show_raw_payload = st.checkbox(
            "Show raw AI news payload",
            value=False,
            key=f"show_raw_news_payload_{symbol}",
            help="Only needed when checking whether the prompt received the right news evidence.",
        )
        if show_raw_payload:
            st.text(format_dashboard_news_context_for_prompt(stock_news_context))

def render_ollama_summary(
    symbol: str,
    current_price,
    chart_view: str,
    chart_config: dict,
    signal_data: dict,
    news_items: list,
    news_sentiment: dict,
    risk_analysis: dict,
    alerts: dict,
    volume_context: dict | None,
    stock_news_context: list[dict],
    stock_news_context_text: str,
    stock_news_overall_text: str,
    risk_level: str,
    risk_points: float,
    auto_ai_on_risk_change: bool,
    ollama_model: str,
    ollama_num_ctx: int = 16384,
    ollama_temperature: float = 0.3,
    ai_settings: dict | None = None,
):
    """Render the Dashboard AI analyst panel (collapsed by default).

    Generation is manual unless Auto AI is enabled. Auto AI only triggers when the
    symbol's risk level / risk-point bucket changes — not on news refresh, chart
    auto-refresh, or settings noise — so the panel does not keep re-running.
    """
    ai_settings = ai_settings or {}
    stock_news_context = stock_news_context or []
    stock_news_context_text = stock_news_context_text or format_dashboard_news_context_for_prompt(stock_news_context)
    stock_news_overall_text = stock_news_overall_text or format_dashboard_news_overall_for_prompt(stock_news_context)

    ai_provider = str(ai_settings.get("provider") or "off").strip().lower()
    ai_language_mode = str(ai_settings.get("language_mode") or "english_only").strip().lower()
    ai_enabled = is_ai_enabled(ai_settings)
    ai_capability = get_dashboard_ai_capabilities(ai_settings)
    dashboard_ai_mode = ai_capability.get("dashboard_ai_mode", "balanced")
    dashboard_news_limit = int(ai_capability.get("dashboard_max_news_items") or 5)
    dashboard_output_length = ai_capability.get("dashboard_output_length", "medium")
    use_streaming = bool(ai_capability.get("use_streaming"))

    if "ai_summary_by_symbol" not in st.session_state:
        st.session_state.ai_summary_by_symbol = {}
    if "ai_summary_meta_by_symbol" not in st.session_state:
        st.session_state.ai_summary_meta_by_symbol = {}
    if "last_ai_risk_key_by_symbol" not in st.session_state:
        st.session_state.last_ai_risk_key_by_symbol = {}

    if symbol not in st.session_state.ai_summary_by_symbol:
        st.session_state.ai_summary_by_symbol[symbol] = ""

    # Prompt/settings contract for cache invalidation only (does not auto-run AI).
    version_key = f"{symbol}_dashboard_ai_prompt_version"
    version_value = (
        f"{DASHBOARD_AI_PROMPT_VERSION}_{ai_provider}_{ai_language_mode}_"
        f"{ollama_model}_{ollama_num_ctx}_{ollama_temperature}_"
        f"{dashboard_ai_mode}_{ai_capability.get('ai_streaming')}_{dashboard_news_limit}_{dashboard_output_length}"
    )
    if st.session_state.get(version_key) != version_value:
        st.session_state.ai_summary_by_symbol[symbol] = ""
        st.session_state.ai_summary_meta_by_symbol.pop(symbol, None)
        st.session_state[version_key] = version_value

    # Auto-run key: risk only. Do NOT include news_sig / model / streaming flags —
    # those change on chart auto-refresh and were causing repeated long Ollama runs.
    auto_risk_key = f"{symbol}_{risk_level}_{int(round(float(risk_points or 0)))}"
    if symbol not in st.session_state.last_ai_risk_key_by_symbol:
        st.session_state.last_ai_risk_key_by_symbol[symbol] = None

    ai_run_request_key = f"{symbol}_dashboard_ai_run_requested"
    ai_run_click_key = f"{symbol}_dashboard_ai_last_click_et"
    ai_run_status_key = f"{symbol}_dashboard_ai_run_status"
    ai_run_lock_key = f"{symbol}_dashboard_ai_run_lock"
    ai_run_started_key = f"{symbol}_dashboard_ai_run_started_ts"
    ai_run_timeout_seconds = 330

    if st.session_state.get(ai_run_lock_key):
        started_ts = float(st.session_state.get(ai_run_started_key) or 0)
        status = "timeout" if started_ts and time.time() - started_ts > ai_run_timeout_seconds else "interrupted"
        previous_meta = st.session_state.ai_summary_meta_by_symbol.get(symbol, {}) or {}
        # If the previous run was aborted by a page refresh / auto-refresh rerun,
        # re-queue ONE automatic retry. The retry run no longer arms the
        # auto-refresh timer (the lock is still held at the top of that run), so
        # it can finish instead of being interrupted again.
        should_auto_retry = status == "interrupted" and not previous_meta.get("interrupt_retried")
        st.session_state[ai_run_lock_key] = False
        st.session_state[ai_run_request_key] = bool(should_auto_retry)
        st.session_state[ai_run_status_key] = status
        st.session_state[ai_run_started_key] = 0
        st.session_state.ai_summary_meta_by_symbol[symbol] = {
            **previous_meta,
            "status": status,
            "message": (
                "Previous AI run was interrupted by a page refresh. One automatic retry was queued."
                if should_auto_retry
                else "Previous AI run was interrupted by a page refresh. The run lock was released."
            ),
            "interrupt_retried": bool(previous_meta.get("interrupt_retried") or should_auto_retry),
            "generated_at_et": format_datetime_et(now_et()),
        }
    dashboard_ai_ctx = min(max(int(ollama_num_ctx or 4096), 2048), 6144)

    current_summary = st.session_state.ai_summary_by_symbol.get(symbol, "")
    current_meta = st.session_state.ai_summary_meta_by_symbol.get(symbol, {}) or {}
    status_label = current_meta.get("status") or ("ready" if current_summary else "idle")
    expander_title = f"AI Summary · {symbol} · {status_label}"

    with st.expander(expander_title, expanded=False):
        if ai_enabled:
            st.caption(
                f"Provider: `Ollama Local` · language `{ai_language_mode}` · "
                f"model `{ollama_model}` · dashboard ctx `{dashboard_ai_ctx}` (setting `{ollama_num_ctx}`) · temp `{ollama_temperature:.2f}` · "
                f"mode `{ai_capability.get('dashboard_ai_mode_label')}` · "
                f"stream `{ai_capability.get('ai_streaming')}` → active `{use_streaming}` · "
                f"news `{dashboard_news_limit}` · output `{dashboard_output_length}` · "
                f"prompt `{DASHBOARD_AI_PROMPT_VERSION}`"
            )
        else:
            st.caption("Provider: `Off / No AI` · source-only English news · rule-based fallback summary")

        run_button_clicked = st.button(
            f"Run / Refresh Detailed AI Analyst Summary for {symbol}",
            use_container_width=True,
            key=f"{symbol}_run_ai_button",
            disabled=bool(st.session_state.get(ai_run_lock_key)),
            help="Uses cached News translations only. Does not pull live headlines. Progress bar tracks the single Ollama call.",
        )

        if run_button_clicked:
            st.session_state[ai_run_request_key] = False
            st.session_state[ai_run_click_key] = format_datetime_et(now_et())
            st.session_state[ai_run_status_key] = "starting"

        if st.session_state.get(ai_run_lock_key):
            elapsed = int(time.time() - float(st.session_state.get(ai_run_started_key) or time.time()))
            st.caption(f"AI run status: running for ~{elapsed}s. Dashboard auto-refresh is paused.")
            if st.button("Unlock Stuck AI Run", key=f"{symbol}_unlock_ai_run", use_container_width=True):
                st.session_state[ai_run_lock_key] = False
                st.session_state[ai_run_request_key] = False
                st.session_state[ai_run_status_key] = "cancelled"
                st.session_state[ai_run_started_key] = 0
                st.rerun()

        run_ai_requested = bool(run_button_clicked)
        last_auto_key = st.session_state.last_ai_risk_key_by_symbol.get(symbol)
        should_auto_run_ai = (
            auto_ai_on_risk_change
            and ai_enabled
            and not st.session_state.get(ai_run_lock_key)
            and last_auto_key is not None  # never auto-fire on first visit; user must click once or risk must change after a prior run
            and last_auto_key != auto_risk_key
        )

        if run_ai_requested:
            clicked_at = st.session_state.get(ai_run_click_key, "just now")
            st.caption(
                f"AI run requested at {clicked_at}. Uses cached News-page translations only "
                "(no live headline pull). One analyst call — no automatic retry."
            )

        if auto_ai_on_risk_change and last_auto_key is None and not current_summary:
            st.caption("Auto AI is on, but waiting for a first manual run (or a later risk-level change after one).")

        st.markdown("##### AI Analyst Brief")

        def _store_summary(summary_text: str, status: str = "ok", message: str = "", news_count: int | None = None):
            st.session_state.ai_summary_by_symbol[symbol] = summary_text or ""
            st.session_state[ai_run_request_key] = False
            st.session_state[ai_run_lock_key] = False
            st.session_state[ai_run_status_key] = status
            st.session_state[ai_run_started_key] = 0
            st.session_state.ai_summary_meta_by_symbol[symbol] = {
                "status": status,
                "message": message,
                "provider": ai_provider,
                "language_mode": ai_language_mode,
                "model": ollama_model,
                "prompt_version": DASHBOARD_AI_PROMPT_VERSION,
                "generated_at_et": format_datetime_et(now_et()),
                "news_count": int(news_count if news_count is not None else len(stock_news_context or [])),
                "news_source": "cached_only",
                "dashboard_ai_mode": dashboard_ai_mode,
                "streaming": use_streaming,
                "ctx": dashboard_ai_ctx,
                "max_news_items": dashboard_news_limit,
                "output_length": dashboard_output_length,
                "auto_risk_key": auto_risk_key,
            }
            # Always record the risk bucket we just evaluated so auto AI cannot loop.
            st.session_state.last_ai_risk_key_by_symbol[symbol] = auto_risk_key

        if run_ai_requested or should_auto_run_ai or st.session_state.get(ai_run_request_key):
            # Claim the lock + clear the request immediately so chart auto-refresh /
            # Streamlit re-entry cannot start a second overlapping Ollama call.
            st.session_state[ai_run_lock_key] = True
            st.session_state[ai_run_request_key] = False
            st.session_state[ai_run_status_key] = "running"
            st.session_state[ai_run_started_key] = time.time()
            st.session_state.last_ai_risk_key_by_symbol[symbol] = auto_risk_key

            ai_settings_for_news = {
                **ai_settings,
                "ollama_model": ollama_model,
                "ollama_num_ctx": dashboard_ai_ctx,
                "ollama_temperature": ollama_temperature,
            }
            num_predict = int(ai_capability.get("num_predict") or 900)
            # Rough character budget so the bar can move while tokens stream in.
            expected_chars = max(int(num_predict) * 2, 400)

            try:
                progress_bar = st.progress(0, text="Starting AI summary…")
            except TypeError:
                progress_bar = st.progress(0)
            progress_status = st.empty()
            stream_box = st.empty()

            def _set_progress(pct: int, message: str):
                clamped = min(max(int(pct), 0), 100)
                try:
                    progress_bar.progress(clamped, text=message)
                except TypeError:
                    # Older Streamlit builds do not accept the text= kwarg.
                    progress_bar.progress(clamped)
                progress_status.caption(message)

            try:
                _set_progress(10, f"Loading cached news for {symbol} (no live pull)…")
                stock_news_context = dashboard_stock_news_context(
                    symbol,
                    news_items=None,
                    max_items=dashboard_news_limit,
                    days=14,
                    cached_only=True,
                )
                news_items = _stock_articles_to_dashboard_news_items(stock_news_context)
                stock_news_context_text = _format_cached_news_context_compact(stock_news_context)
                stock_news_overall_text = format_dashboard_news_overall_for_prompt(stock_news_context)
                cached_count = len(stock_news_context)
                _set_progress(
                    25,
                    f"Using {cached_count} cached article(s) (limit {dashboard_news_limit}).",
                )
                if cached_count == 0:
                    st.warning(
                        f"No cached AI news found for {symbol}. "
                        "Open News → translate articles first, then rerun AI Summary."
                    )

                if not ai_enabled:
                    _set_progress(70, "Building source-only fallback summary…")
                    _store_summary(
                        build_no_ai_dashboard_summary(
                            symbol=symbol,
                            current_price=current_price,
                            signal_data=signal_data,
                            news_sentiment=news_sentiment,
                            risk_analysis=risk_analysis,
                            alerts=alerts,
                            stock_news_context=stock_news_context,
                        ),
                        status="source_only",
                        message="AI Provider is Off. Source-only fallback summary generated from cached news.",
                        news_count=cached_count,
                    )
                    _set_progress(100, "Done (source-only fallback).")
                else:
                    _set_progress(35, "Building analyst prompt…")
                    if dashboard_ai_mode == "detailed":
                        ai_prompt = build_ai_prompt(
                            symbol=symbol,
                            current_price=current_price,
                            chart_view=chart_view,
                            chart_config=chart_config,
                            signal_data=signal_data,
                            news_items=news_items,
                            news_sentiment=news_sentiment,
                            risk_analysis=risk_analysis,
                            alerts=alerts,
                            volume_context=volume_context,
                            stock_news_context_text=stock_news_context_text,
                            stock_news_overall_text=stock_news_overall_text,
                            language_mode=ai_language_mode,
                            dashboard_ai_mode=dashboard_ai_mode,
                            output_length=dashboard_output_length,
                        )
                    else:
                        ai_prompt = _build_compact_dashboard_ai_prompt(
                            symbol=symbol,
                            current_price=current_price,
                            chart_view=chart_view,
                            signal_data=signal_data,
                            risk_analysis=risk_analysis,
                            alerts=alerts,
                            volume_context=volume_context,
                            stock_news_context_text=stock_news_context_text,
                            stock_news_overall_text=stock_news_overall_text,
                            language_mode=ai_language_mode,
                            output_length=dashboard_output_length,
                        )

                    _set_progress(
                        45,
                        f"Calling Ollama ({ai_capability.get('dashboard_ai_mode_label')}, "
                        f"stream={use_streaming}, cached news={cached_count})…",
                    )

                    if use_streaming:
                        chunks: list[str] = []
                        last_render_len = 0
                        last_progress_pct = 45
                        for chunk in call_ai_model_stream(
                            prompt=ai_prompt,
                            ai_settings=ai_settings_for_news,
                        ):
                            chunks.append(str(chunk))
                            current_text = "".join(chunks).strip()
                            gen_pct = 45 + int(50 * min(1.0, len(current_text) / float(expected_chars)))
                            if gen_pct > last_progress_pct:
                                last_progress_pct = gen_pct
                                _set_progress(
                                    min(gen_pct, 95),
                                    f"Generating… {len(current_text)} / ~{expected_chars} chars",
                                )
                            if len(current_text) - last_render_len >= 80 or current_text.startswith(
                                "Ollama AI summary failed:"
                            ):
                                stream_box.markdown(current_text or "_")
                                last_render_len = len(current_text)
                        ai_response = "".join(chunks).strip()
                        if ai_response:
                            stream_box.markdown(ai_response)
                    else:
                        _set_progress(55, "Waiting for non-streaming Ollama response…")
                        ai_response = call_ai_model(
                            prompt=ai_prompt,
                            ai_settings=ai_settings_for_news,
                        ).strip()
                        if ai_response:
                            stream_box.markdown(ai_response)

                    # The transient streaming box has served its purpose; the
                    # saved summary is rendered once below. Clearing it prevents
                    # the same text from appearing twice in this run.
                    stream_box.empty()
                    _set_progress(97, "Saving AI summary…")

                    weak_response = (
                        dashboard_ai_mode != "fast"
                        and is_weak_dashboard_ai_summary(ai_response or "")
                        and bool(stock_news_context)
                    )
                    if weak_response and ai_response and not str(ai_response).startswith("Ollama AI summary failed:"):
                        st.warning(
                            "AI response may still be generic, but it was saved. "
                            "No second retry was started."
                        )

                    if not ai_response or not str(ai_response).strip():
                        ai_response = (
                            "**AI Summary failed: empty Ollama response**\n\n"
                            "Ollama returned an empty response. Try Test AI in the sidebar, reduce Context Length, "
                            "or retry after confirming the selected model is loaded."
                        )
                        _store_summary(
                            ai_response,
                            status="empty",
                            message="Ollama returned an empty response.",
                            news_count=cached_count,
                        )
                    elif str(ai_response).startswith("Ollama AI summary failed:"):
                        _store_summary(
                            str(ai_response),
                            status="error",
                            message=str(ai_response),
                            news_count=cached_count,
                        )
                    else:
                        _store_summary(
                            str(ai_response),
                            status="weak_saved" if weak_response else "ok",
                            message=(
                                "Generated, but detected as possibly generic."
                                if weak_response
                                else "Generated successfully from cached news."
                            ),
                            news_count=cached_count,
                        )
                    _set_progress(100, f"Done · {cached_count} cached article(s) used.")
            except Exception as exc:
                error_text = (
                    "**AI Summary failed before completion**\n\n"
                    f"Error: `{exc}`\n\n"
                    "This was caught by the Dashboard panel, so the app can continue running."
                )
                _store_summary(error_text, status="error", message=str(exc))
                stream_box.empty()
                _set_progress(100, f"Failed: {exc}")

        current_summary = st.session_state.ai_summary_by_symbol.get(symbol, "")
        current_meta = st.session_state.ai_summary_meta_by_symbol.get(symbol, {}) or {}

        if current_summary:
            status = current_meta.get("status", "ok")
            if status in {"error", "empty"} or str(current_summary).startswith("Ollama AI summary failed:"):
                st.error(current_summary)
            elif status == "source_only":
                st.info(current_summary)
            else:
                st.markdown(current_summary)

            generated_at = current_meta.get("generated_at_et")
            if generated_at:
                st.caption(
                    f"Last AI run: {generated_at} · provider `{current_meta.get('provider')}` · "
                    f"language `{current_meta.get('language_mode')}` · model `{current_meta.get('model')}` · "
                    f"mode `{current_meta.get('dashboard_ai_mode')}` · stream `{current_meta.get('streaming')}` · "
                    f"cached news `{current_meta.get('news_count')}` · source `{current_meta.get('news_source', 'cached_only')}` · "
                    f"status `{current_meta.get('status')}`"
                )
                if current_meta.get("status") == "weak_saved":
                    st.warning(
                        "This AI brief was generated but detected as possibly generic. "
                        "It is still shown so the app does not appear stuck; rerun manually if needed."
                    )

            if st.button("Clear AI Summary", key=f"{symbol}_clear_ai_summary", use_container_width=True):
                st.session_state.ai_summary_by_symbol[symbol] = ""
                st.session_state.ai_summary_meta_by_symbol.pop(symbol, None)
                st.session_state[ai_run_request_key] = False
                st.session_state[ai_run_lock_key] = False
                st.session_state[ai_run_status_key] = "idle"
                # Keep last_ai_risk_key so Auto AI does not immediately regenerate.
        else:
            run_status = st.session_state.get(ai_run_status_key)
            if run_status in {"queued", "running"} or st.session_state.get(ai_run_lock_key):
                st.warning(
                    f"AI run status: {run_status or 'running'}. Wait for the current call to finish. "
                    "It will not auto-retry."
                )
            elif ai_enabled:
                st.info(
                    "No AI Analyst Brief yet. Expand this section and click the button above. "
                    "It uses cached News translations only (no live pull) and shows a progress bar while generating."
                )
            else:
                st.info(
                    "AI Provider is Off. Click the button for a source-only fallback summary, "
                    "or connect Ollama Local in AI Settings."
                )

def render_recent_news(symbol: str, news_items: list):
    with st.expander(f"{symbol} Recent News", expanded=False):
        if news_items:
            for item in news_items:
                title = item.get("title", "Untitled")
                source = item.get("source", "")
                pub_date = item.get("pub_date", "")
                link = item.get("link", "")

                if link:
                    st.markdown(f"**[{title}]({link})**")
                else:
                    st.markdown(f"**{title}**")

                meta_parts = []

                if source:
                    meta_parts.append(source)

                if pub_date:
                    meta_parts.append(pub_date)

                if meta_parts:
                    st.caption(" · ".join(meta_parts))

                st.write("---")
        else:
            st.info("No recent news found.")
