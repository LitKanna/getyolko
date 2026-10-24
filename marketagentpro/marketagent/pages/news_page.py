from __future__ import annotations

from datetime import datetime

import pandas as pd
import streamlit as st

from marketagent.config import MARKET_TZ, NEWS_HISTORY_FILE
from marketagent.ai_agent import ai_provider_label, get_ai_model_name, is_ai_enabled
from marketagent.market_data import fetch_dashboard_current_quote
from marketagent.news import (
    compact_news_history,
    delete_news_record,
    enrich_article_with_llm,
    article_display_time_et,
    fetch_market_news_items,
    fetch_stock_news_items,
    format_news_time_et,
    _article_sort_timestamp,
    is_key_event_article,
    load_news_history,
    merge_with_history,
    news_quality_stats,
    process_new_articles,
    rule_classify_article,
    sort_articles_latest,
    upsert_news_records,
)
from marketagent.utils import format_age, format_price, normalize_symbol


try:
    import yfinance as yf
    HAS_YFINANCE = True
except Exception:
    yf = None
    HAS_YFINANCE = False


IMPACT_ORDER = ["Bullish", "Slightly Bullish", "Neutral", "Mixed", "Slightly Bearish", "Bearish", "Unclear"]
IMPORTANT_TAGS = {"Earnings", "Guidance", "M&A", "Analyst Rating", "Regulation", "Partnership", "Product"}
EVENT_TIME_RANGES = {
    "All": None,
    "Last 1 Month": 30,
    "Last 3 Months": 90,
    "Last 6 Months": 180,
    "Last 1 Year": 365,
}
EVENT_IMPORTANCE_LEVELS = ["High", "Medium", "Low"]


def _watchlist_symbols(watchlist: list[str] | None) -> list[str]:
    """Return current displayed stock symbols, preserving the Dashboard order.

    The Stock News selector intentionally follows Dashboard Display Stocks instead
    of the full Watchlist, so the News workflow stays focused on the stocks the
    user is actively viewing.  If Display Stocks is empty, it falls back to the
    full Watchlist.
    """
    source_symbols = getattr(st.session_state, "display_symbols", []) or watchlist or []
    cleaned: list[str] = []
    for symbol in source_symbols:
        normalized = normalize_symbol(symbol)
        if normalized and normalized not in cleaned:
            cleaned.append(normalized)
    return cleaned


def _reset_selectbox_if_value_not_allowed(key: str, allowed: list[str]):
    """Prevent Streamlit from keeping an old selected value after Watchlist changes."""
    if key in st.session_state and st.session_state.get(key) not in allowed:
        try:
            del st.session_state[key]
        except Exception:
            pass


def _get_ai_settings(ai_settings: dict | None) -> dict:
    return ai_settings or st.session_state.get("ai_settings", {}) or {}


def _event_in_time_range(article: dict, range_label: str) -> bool:
    """Return True when an event article is within the selected ET-relative range."""
    days = EVENT_TIME_RANGES.get(range_label)
    if days is None:
        return True
    ts = _article_sort_timestamp(article)
    if not ts:
        return False
    cutoff_ts = datetime.now(MARKET_TZ).timestamp() - (int(days) * 24 * 60 * 60)
    return ts >= cutoff_ts


def _render_symbol_price_snapshot(symbol: str):
    """Render a compact current-price block beside the Stock News ticker selector."""
    symbol = normalize_symbol(symbol)
    if not symbol:
        return

    force_refresh = st.button("Refresh Price", key=f"news_price_refresh_{symbol}", use_container_width=True)
    quote = fetch_dashboard_current_quote(symbol, chart_view="Today", force_refresh=force_refresh)
    price = quote.get("price")
    st.metric(f"{symbol} Price", format_price(price))

    timestamp = quote.get("timestamp") or quote.get("trade_timestamp") or quote.get("quote_timestamp")
    time_text = format_news_time_et(timestamp, include_warning=False) if timestamp else "N/A"
    cache_age = None
    if quote.get("cache_updated_at_epoch") is not None:
        try:
            import time as _time
            cache_age = _time.time() - float(quote.get("cache_updated_at_epoch"))
        except Exception:
            cache_age = None

    details = []
    price_method = quote.get("price_method") or quote.get("source")
    if price_method:
        details.append(f"Source: {price_method}")
    if quote.get("original_price_method"):
        details.append(f"Provider: {quote.get('original_price_method')}")
    if time_text:
        details.append(f"Price time: {time_text}")
    if quote.get("chart_latest_time_et"):
        details.append(f"Chart time: {quote.get('chart_latest_time_et')}")
    if cache_age is not None:
        details.append(f"Cache: {format_age(cache_age)}")
    if quote.get("status") and quote.get("status") != "ok":
        details.append(f"Status: {quote.get('status')}")
    if quote.get("dashboard_price_error"):
        details.append("Dashboard fallback unavailable")
    st.caption(" · ".join(details) if details else "No quote details available.")
    if quote.get("fallback_reason"):
        st.caption(quote.get("fallback_reason"))


@st.cache_data(ttl=3600, show_spinner=False)
def fetch_yfinance_key_events(symbol: str) -> dict:
    """Best-effort key event lookup.

    yfinance calendar output varies by version/source. This function keeps the UI
    stable even when Yahoo does not return calendar data.
    """
    symbol = normalize_symbol(symbol)
    if not symbol or not HAS_YFINANCE:
        return {}

    try:
        ticker = yf.Ticker(symbol)
        data = {}

        calendar = None
        try:
            calendar = ticker.calendar
        except Exception:
            calendar = None

        if isinstance(calendar, pd.DataFrame) and not calendar.empty:
            for idx, row in calendar.iterrows():
                key = str(idx)
                value = row.iloc[0] if len(row) else None
                data[key] = str(value)
        elif isinstance(calendar, dict):
            data.update({str(k): str(v) for k, v in calendar.items()})

        try:
            info = ticker.get_info()
            if isinstance(info, dict):
                for key in ["earningsDate", "exDividendDate", "dividendDate", "nextFiscalYearEnd"]:
                    if info.get(key):
                        data[key] = str(info.get(key))
        except Exception:
            pass

        return data
    except Exception:
        return {}


def _source_tuple(selected_sources: list[str]) -> tuple[str, ...]:
    return tuple(selected_sources or ["Google News"])




def _auto_refresh_market_news_once(max_per_query: int, sources: tuple[str, ...]):
    """Fetch market headlines once per app session without running the LLM."""
    key = "market_news_auto_refreshed_once_v2"
    if st.session_state.get(key) or st.session_state.get("market_news_articles"):
        return
    st.session_state[key] = True
    try:
        with st.spinner("Auto-refreshing latest market news headlines..."):
            fetched = fetch_market_news_items(max_items_per_query=int(max_per_query), sources=sources)
            st.session_state.market_news_articles = merge_with_history(fetched)
        st.caption("Market news auto-refreshed once. New items are not translated until you click Translate New Market Articles.")
    except Exception as exc:
        st.warning(f"Market news auto-refresh failed: {exc}")


def _auto_refresh_stock_news_once(symbol: str, max_per_source: int, sources: tuple[str, ...]):
    """Fetch one ticker's latest headlines once per app session without running the LLM."""
    symbol = normalize_symbol(symbol)
    if not symbol:
        return
    state_key = f"stock_news_articles_{symbol}"
    auto_key = f"stock_news_auto_refreshed_once_v2_{symbol}"
    if st.session_state.get(auto_key) or st.session_state.get(state_key):
        return
    st.session_state[auto_key] = True
    try:
        with st.spinner(f"Auto-refreshing latest {symbol} news headlines..."):
            fetched = fetch_stock_news_items(symbol, max_items_per_source=int(max_per_source), sources=sources)
            st.session_state[state_key] = merge_with_history(fetched)
        st.caption(f"{symbol} news auto-refreshed once. New items are not translated until you click Translate New {symbol} Articles or Dashboard AI refresh.")
    except Exception as exc:
        st.warning(f"{symbol} news auto-refresh failed: {exc}")

def _history_stats(articles: list[dict]) -> dict:
    return news_quality_stats(articles)


def _render_news_metrics(articles: list[dict]):
    stats = _history_stats(articles)
    col1, col2, col3, col4, col5 = st.columns(5)
    col1.metric("Raw est.", stats["raw_estimate"])
    col2.metric("Unique", stats["unique"])
    col3.metric("Cached", stats["cached"])
    col4.metric("New", stats["new"])
    col5.metric("Duplicates", stats["duplicate_items"])


def _render_duplicate_diagnostics(articles: list[dict], key_prefix: str):
    duplicate_articles = [article for article in articles or [] if int(article.get("duplicate_count") or 0) > 0]
    if not duplicate_articles:
        return
    with st.expander("Source quality / duplicate diagnostics", expanded=False):
        st.caption(
            "Duplicates are merged before display and before LLM translation. "
            "A duplicate can be the same story from Google/Yahoo, a Google redirect plus publisher URL, "
            "or a matching normalized title."
        )
        rows = []
        for article in duplicate_articles:
            rows.append(
                {
                    "Published ET": article_display_time_et(article, "published_at"),
                    "Duplicate Count": int(article.get("duplicate_count") or 0),
                    "Sources": ", ".join(article.get("duplicate_sources") or []),
                    "Publishers": ", ".join(article.get("duplicate_publishers") or []),
                    "Primary Title": article.get("translated_title_zh") or article.get("original_title", ""),
                    "Reason": article.get("dedupe_reason", ""),
                }
            )
        df = pd.DataFrame(rows)
        if not df.empty:
            st.dataframe(df, use_container_width=True, hide_index=True)

        sample = duplicate_articles[:5]
        for idx, article in enumerate(sample):
            titles = article.get("duplicate_titles") or []
            links = article.get("duplicate_links") or []
            with st.expander(f"Merged story {idx + 1}: {article.get('original_title', '')[:100]}", expanded=False):
                st.write("**Titles merged**")
                for title in titles[:8]:
                    st.write(f"- {title}")
                if links:
                    st.write("**Links merged**")
                    for link in links[:8]:
                        st.write(f"- {link}")


def _article_to_row(article: dict) -> dict:
    return {
        "Status": article.get("cache_status", "History"),
        "Scope": article.get("scope", ""),
        "Symbol": article.get("symbol", "") or "Market",
        "Published ET": article_display_time_et(article, "published_at"),
        "Fetched ET": article_display_time_et(article, "fetched_at"),
        "Translated ET": article_display_time_et(article, "translated_at"),
        "Source": article.get("source", ""),
        "Publisher": article.get("publisher", ""),
        "Event Type": article.get("event_type", ""),
        "Event Confidence": int(article.get("event_confidence") or 0),
        "Event Reason": article.get("event_reason", ""),
        "Impact": article.get("impact", ""),
        "Importance": article.get("importance", ""),
        "Tags": ", ".join(article.get("tags", []) if isinstance(article.get("tags"), list) else []),
        "Duplicate Count": int(article.get("duplicate_count") or 0),
        "Duplicate Sources": ", ".join(article.get("duplicate_sources") or []),
        "Chinese Title": article.get("translated_title_zh", ""),
        "Original Title": article.get("original_title", ""),
        "Summary": article.get("summary_zh", ""),
        "Impact Analysis": article.get("impact_analysis_zh", ""),
        "Risk Notes": article.get("risk_notes_zh", ""),
        "Link": article.get("original_link", ""),
    }


def _render_article_card(article: dict, ai_settings: dict, watchlist: list[str], key_prefix: str):
    article_id = article.get("article_id", "")
    cached = article.get("cache_status") == "Cached" or bool(article.get("translated_at"))
    ai_on = is_ai_enabled(ai_settings)
    title = article.get("translated_title_zh") or article.get("original_title") or "Untitled"
    original_title = article.get("original_title") or ""
    impact = article.get("impact") or rule_classify_article(article, watchlist=watchlist).get("impact")
    importance = article.get("importance") or rule_classify_article(article, watchlist=watchlist).get("importance")
    tags = article.get("tags") or rule_classify_article(article, watchlist=watchlist).get("tags", [])
    published_et = article_display_time_et(article, "published_at")
    fetched_et = article_display_time_et(article, "fetched_at")
    translated_et = article_display_time_et(article, "translated_at")
    source_line = " · ".join(
        [
            value
            for value in [
                article.get("source"),
                article.get("publisher"),
                f"Published {published_et}" if published_et else "",
                "Cached" if cached else "New",
            ]
            if value
        ]
    )

    with st.container(border=True):
        st.markdown(f"**{title}**")
        if title != original_title and original_title:
            st.caption(original_title)
        st.caption(source_line)

        badge_col1, badge_col2, badge_col3, badge_col4, badge_col5 = st.columns([1, 1, 1, 1, 4])
        badge_col1.write(f"Impact: `{impact or 'N/A'}`")
        badge_col2.write(f"Importance: `{importance or 'N/A'}`")
        badge_col3.write(f"Event: `{article.get('event_type') or 'General'}`")
        confidence = int(article.get("event_confidence") or rule_classify_article(article, watchlist=watchlist).get("event_confidence") or 0)
        badge_col4.write(f"Conf: `{confidence}`")
        badge_col5.write("Tags: " + (", ".join([f"`{tag}`" for tag in tags]) if tags else "N/A"))

        if fetched_et or translated_et:
            st.caption(" · ".join([part for part in [f"Fetched {fetched_et}" if fetched_et else "", f"Translated {translated_et}" if translated_et else ""] if part]))

        if article.get("summary_zh"):
            st.markdown(article.get("summary_zh"))
        elif article.get("description"):
            st.caption(article.get("description"))
            if not ai_on:
                st.caption("AI not connected. Showing English source snippet only; no translation was generated.")
        else:
            if ai_on:
                st.caption("No Chinese summary yet. Use Translate New Articles or Re-translate to process it with the selected AI provider.")
            else:
                st.caption("AI not connected. Showing English source news only.")

        # New structured fields are stored separately for filtering/export.
        # They are also usually included in summary_zh, but this fallback keeps older/partial records readable.
        if article.get("impact_analysis_zh") and "影响分析" not in (article.get("summary_zh") or ""):
            st.markdown("**影响分析**")
            st.markdown(f"- {article.get('impact_analysis_zh')}")
        if article.get("risk_notes_zh") and "风险提示" not in (article.get("summary_zh") or ""):
            st.markdown("**风险提示**")
            st.markdown(f"- {article.get('risk_notes_zh')}")
        if article.get("impact_reason_zh"):
            st.caption(f"Impact reason: {article.get('impact_reason_zh')}")

        link = article.get("original_link")
        link_col, action_col = st.columns([3, 1])
        with link_col:
            if link:
                st.markdown(f"[Open original news]({link})")

        with action_col:
            if st.button("Re-translate", key=f"{key_prefix}_retranslate_{article_id}", use_container_width=True, disabled=not ai_on):
                with st.spinner("Translating and summarizing with the selected AI provider..."):
                    enriched = enrich_article_with_llm(article, ai_settings=ai_settings, watchlist=watchlist)
                    upsert_news_records([enriched])
                st.success("Saved updated AI summary.")
                st.rerun()
            if not ai_on:
                st.caption("Enable AI in Settings to translate/summarize.")


def _render_article_list(articles: list[dict], ai_settings: dict, watchlist: list[str], key_prefix: str):
    if not articles:
        st.info("No news found yet. Try Refresh News.")
        return

    articles = sort_articles_latest(articles)
    _render_news_metrics(articles)
    _render_duplicate_diagnostics(articles, key_prefix=key_prefix)

    for idx, article in enumerate(articles):
        _render_article_card(article, ai_settings=ai_settings, watchlist=watchlist, key_prefix=f"{key_prefix}_{idx}")


def _event_priority(article: dict) -> int:
    rules = rule_classify_article(article)
    event_type = article.get("event_type") or rules.get("event_type") or "General"
    importance = article.get("importance") or rules.get("importance") or "Low"
    confidence = int(article.get("event_confidence") or rules.get("event_confidence") or 0)
    tags = set(article.get("tags") or rules.get("tags", []))

    type_score = {
        "Earnings": 80,
        "Guidance": 75,
        "M&A": 72,
        "Analyst Rating": 62,
        "Regulation": 60,
        "Partnership": 48,
        "Product": 42,
        "Management": 38,
        "Macro Impact": 30,
        "General": 0,
    }.get(event_type, 20)

    importance_score = {"High": 45, "Medium": 18, "Low": 0}.get(importance, 0)
    tag_score = 6 * len(tags.intersection(IMPORTANT_TAGS))
    return type_score + importance_score + confidence + tag_score


def _merge_rule_fields_for_event(article: dict, watchlist: list[str]) -> dict:
    rules = rule_classify_article(article, watchlist=watchlist)
    merged = dict(article or {})
    for key, value in rules.items():
        if key in ["tags", "related_symbols"]:
            existing = merged.get(key) if isinstance(merged.get(key), list) else []
            merged[key] = list(dict.fromkeys(existing + (value if isinstance(value, list) else [])))
        elif not merged.get(key):
            merged[key] = value
    return merged


def _render_key_events(symbol: str, articles: list[dict], watchlist: list[str] | None = None):
    st.subheader("Key Events")
    st.caption("Event radar for earnings, guidance, M&A, analyst rating changes, regulation, partnerships, product launches, and management changes.")

    event_col1, event_col2 = st.columns([1, 2])
    with event_col1:
        st.caption("Calendar / earnings")
        events = fetch_yfinance_key_events(symbol)
        if events:
            for key, value in list(events.items())[:8]:
                st.write(f"**{key}:** {value}")
        else:
            st.write("No reliable calendar data returned by yfinance.")

    with event_col2:
        st.caption("Detected from latest/cached news")
        control_col1, control_col2, control_col3, control_col4 = st.columns([1, 1, 1, 1.4])
        with control_col1:
            min_confidence = st.slider(
                "Min event confidence",
                min_value=0,
                max_value=95,
                value=55,
                step=5,
                key=f"key_events_min_conf_{symbol}",
                help="Higher values show fewer but stronger event matches. Earnings, guidance, M&A and analyst events usually score high.",
            )
        with control_col2:
            include_cache = st.checkbox(
                "Include cached history",
                value=True,
                key=f"key_events_include_cache_{symbol}",
                help="Use previously translated/cached news too, so important older events do not disappear after refresh.",
            )
        with control_col3:
            event_range = st.selectbox(
                "Event time range",
                options=list(EVENT_TIME_RANGES.keys()),
                index=2,
                key=f"key_events_time_range_{symbol}",
                help="Filter detected events by Published ET / safe news timestamp.",
            )
        with control_col4:
            selected_importance = st.multiselect(
                "Importance",
                options=EVENT_IMPORTANCE_LEVELS,
                default=EVENT_IMPORTANCE_LEVELS,
                key=f"key_events_importance_{symbol}",
                help="Show only selected event importance levels.",
            )

        latest_articles = list(articles or [])
        latest_ids = {article.get("article_id") for article in latest_articles if article.get("article_id")}
        history_for_symbol = []
        if include_cache:
            history_for_symbol = [
                record for record in load_news_history()
                if normalize_symbol(record.get("symbol", "")) == normalize_symbol(symbol)
            ]

        combined = sort_articles_latest(latest_articles + history_for_symbol)
        seen = set()
        important = []
        for article in combined:
            article_id = article.get("article_id")
            if article_id and article_id in seen:
                continue
            if article_id:
                seen.add(article_id)

            candidate = _merge_rule_fields_for_event(article, watchlist or [])
            confidence = int(candidate.get("event_confidence") or 0)
            if not is_key_event_article(candidate, watchlist=watchlist) and confidence < min_confidence:
                continue
            if confidence < min_confidence and candidate.get("importance") != "High":
                continue
            if selected_importance and candidate.get("importance") not in selected_importance:
                continue
            if not _event_in_time_range(candidate, event_range):
                continue

            candidate["detected_from"] = "Latest" if article_id in latest_ids else "Cache"
            candidate["event_score"] = _event_priority(candidate)
            candidate["_sort_ts"] = _article_sort_timestamp(candidate)
            important.append(candidate)

        if not important:
            st.write("No event matched the current filters. Try widening the time range, selecting more importance levels, lowering Min event confidence, or refreshing Stock News.")
            return

        # Display Key Events in the same latest-first order as the rest of News.
        # Event score is still kept as a secondary tie-breaker, but Published ET
        # should be the primary ordering signal in the table.
        important = sorted(
            important,
            key=lambda item: (
                item.get("_sort_ts", 0),
                item.get("event_score", 0),
                int(item.get("event_confidence") or 0),
                item.get("article_id", ""),
            ),
            reverse=True,
        )

        metric_col1, metric_col2, metric_col3, metric_col4, metric_col5 = st.columns(5)
        metric_col1.metric("Events", len(important))
        metric_col2.metric("High", sum(1 for item in important if item.get("importance") == "High"))
        metric_col3.metric("Latest", sum(1 for item in important if item.get("detected_from") == "Latest"))
        metric_col4.metric("Cached", sum(1 for item in important if item.get("detected_from") == "Cache"))
        metric_col5.metric("Range", event_range.replace("Last ", ""))

        rows = []
        for article in important[:15]:
            tags = article.get("tags") or []
            rows.append(
                {
                    "Published ET": article_display_time_et(article, "published_at"),
                    "Detected From": article.get("detected_from", ""),
                    "Event Type": article.get("event_type") or "General",
                    "Confidence": int(article.get("event_confidence") or 0),
                    "Importance": article.get("importance", ""),
                    "Impact": article.get("impact", ""),
                    "Title": article.get("translated_title_zh") or article.get("original_title", ""),
                    "Reason": article.get("event_reason", ""),
                    "Source": article.get("publisher") or article.get("source", ""),
                    "Tags": ", ".join(tags[:5]),
                    "Link": article.get("original_link", ""),
                }
            )
        st.dataframe(pd.DataFrame(rows), use_container_width=True, hide_index=True)

        with st.expander("Open detected event cards", expanded=False):
            for idx, article in enumerate(important[:10]):
                _render_article_card(article, ai_settings=_get_ai_settings(None), watchlist=watchlist or [], key_prefix=f"key_event_{symbol}_{idx}")

def render_market_news_tab(ai_settings: dict, watchlist: list[str]):
    st.subheader("Market News")
    st.caption("General US market, macro, Nasdaq/S&P 500, AI, semiconductor, rates, and risk headlines.")
    ai_on = is_ai_enabled(ai_settings)
    if not ai_on:
        st.info(f"AI Provider is Off ({ai_provider_label(ai_settings)}). Market News will remain English/source-only; translation buttons are disabled.")

    control_col1, control_col2, control_col3 = st.columns([2, 1, 1])
    with control_col1:
        sources = st.multiselect(
            "Sources",
            options=["Google News", "Yahoo Finance"],
            default=["Google News", "Yahoo Finance"],
            key="market_news_sources",
        )
    with control_col2:
        max_per_query = st.number_input("Max/query", min_value=1, max_value=10, value=3, step=1, key="market_news_max")
    with control_col3:
        process_limit = st.number_input("Translate limit", min_value=1, max_value=20, value=8, step=1, key="market_news_process_limit")

    _auto_refresh_market_news_once(max_per_query=int(max_per_query), sources=_source_tuple(sources))

    btn_col1, btn_col2 = st.columns(2)
    if btn_col1.button("Refresh Market News", use_container_width=True, key="refresh_market_news"):
        with st.spinner("Fetching market news..."):
            fetched = fetch_market_news_items(max_items_per_query=int(max_per_query), sources=_source_tuple(sources))
            st.session_state.market_news_articles = merge_with_history(fetched)
        st.success("Market news refreshed.")

    if btn_col2.button("Translate New Market Articles", use_container_width=True, key="translate_market_news", disabled=not ai_on):
        fetched = st.session_state.get("market_news_articles")
        if not fetched:
            fetched = fetch_market_news_items(max_items_per_query=int(max_per_query), sources=_source_tuple(sources))
        raw_articles = sort_articles_latest([{k: v for k, v in article.items() if k != "cache_status"} for article in fetched])
        with st.spinner("Translating new market articles with the selected AI provider..."):
            result = process_new_articles(raw_articles, ai_settings=ai_settings, watchlist=watchlist, limit=int(process_limit))
            st.session_state.market_news_articles = merge_with_history(raw_articles)
        st.success(f"Processed {result['processed']} newest new articles. Cached skipped: {result['skipped_existing']}.")
    if not ai_on:
        st.caption("Connect an AI provider in AI Settings to enable Chinese translation and AI summaries.")

    articles = st.session_state.get("market_news_articles", [])
    _render_article_list(articles, ai_settings=ai_settings, watchlist=watchlist, key_prefix="market_news")


def render_stock_news_tab(ai_settings: dict, watchlist: list[str]):
    st.subheader("Stock News")
    st.caption("Company-specific headlines, earnings/guidance, analyst rating changes, M&A, partnerships, and other events.")
    ai_on = is_ai_enabled(ai_settings)
    if not ai_on:
        st.info(f"AI Provider is Off ({ai_provider_label(ai_settings)}). Stock News will remain English/source-only; Dashboard can still use headlines/rule tags.")
    with st.expander("What is Analyst Rating?", expanded=False):
        st.write(
            "Analyst Rating means Wall Street analyst actions such as upgrade, downgrade, "
            "initiates coverage, reiterates rating, raises/cuts price target, overweight/outperform, "
            "neutral, underperform, or sell rating. These only appear when the news source returns such headlines."
        )

    symbols = _watchlist_symbols(watchlist) or ["MU"]
    focus_symbol = normalize_symbol(st.session_state.get("news_focus_symbol", ""))
    if focus_symbol and focus_symbol in symbols:
        st.session_state.stock_news_symbol = focus_symbol
        st.session_state.news_focus_symbol = ""
    _reset_selectbox_if_value_not_allowed("stock_news_symbol", symbols)

    symbol_col, price_col = st.columns([1, 1.4])
    with symbol_col:
        symbol = st.selectbox("Symbol", options=symbols, index=0, key="stock_news_symbol")
        st.caption("Source: current Dashboard Display Stocks order. Use the sidebar Display checkboxes to control this list.")
    with price_col:
        _render_symbol_price_snapshot(symbol)

    control_col2, control_col3, control_col4 = st.columns([2, 1, 1])
    with control_col2:
        sources = st.multiselect(
            "Sources",
            options=["Google News", "Yahoo Finance"],
            default=["Google News", "Yahoo Finance"],
            key="stock_news_sources",
        )
    with control_col3:
        max_per_source = st.number_input("Max/source", min_value=1, max_value=15, value=6, step=1, key="stock_news_max")
    with control_col4:
        process_limit = st.number_input("Translate limit", min_value=1, max_value=20, value=8, step=1, key="stock_news_process_limit")

    state_key = f"stock_news_articles_{symbol}"
    _auto_refresh_stock_news_once(symbol, max_per_source=int(max_per_source), sources=_source_tuple(sources))

    btn_col1, btn_col2 = st.columns(2)
    if btn_col1.button(f"Refresh {symbol} News", use_container_width=True, key="refresh_stock_news"):
        with st.spinner(f"Fetching {symbol} news..."):
            fetched = fetch_stock_news_items(symbol, max_items_per_source=int(max_per_source), sources=_source_tuple(sources))
            st.session_state[state_key] = merge_with_history(fetched)
        st.success(f"{symbol} news refreshed.")

    if btn_col2.button(f"Translate New {symbol} Articles", use_container_width=True, key="translate_stock_news", disabled=not ai_on):
        fetched = st.session_state.get(state_key)
        if not fetched:
            fetched = fetch_stock_news_items(symbol, max_items_per_source=int(max_per_source), sources=_source_tuple(sources))
        raw_articles = sort_articles_latest([{k: v for k, v in article.items() if k != "cache_status"} for article in fetched])
        with st.spinner(f"Translating new {symbol} articles with the selected AI provider..."):
            result = process_new_articles(raw_articles, ai_settings=ai_settings, watchlist=watchlist, limit=int(process_limit))
            st.session_state[state_key] = merge_with_history(raw_articles)
        st.success(f"Processed {result['processed']} newest new articles. Cached skipped: {result['skipped_existing']}.")
    if not ai_on:
        st.caption("Connect an AI provider in AI Settings to enable Chinese translation and AI summaries.")

    articles = st.session_state.get(state_key, [])
    _render_key_events(symbol, articles, watchlist=watchlist)
    st.subheader(f"Latest {symbol} Articles")
    _render_article_list(articles, ai_settings=ai_settings, watchlist=watchlist, key_prefix=f"stock_news_{symbol}")


def render_news_history_tab(ai_settings: dict, watchlist: list[str]):
    st.subheader("News History")
    st.caption("Cached translations/summaries are stored locally, sorted latest first, so old headlines do not need to be reprocessed by the LLM.")

    history = load_news_history()
    if not history:
        st.info("No cached news history yet. Fetch and translate new articles first.")
        st.caption(f"History file: `{NEWS_HISTORY_FILE}`")
        return

    current_watchlist_symbols = _watchlist_symbols(watchlist)
    all_symbols = sorted(list(dict.fromkeys([record.get("symbol") or "Market" for record in history])))
    current_scope_symbols = ["Market"] + [symbol for symbol in current_watchlist_symbols if symbol in all_symbols]

    only_current_watchlist = st.checkbox(
        "History filters: only show Market + current displayed symbols",
        value=True,
        key="history_only_current_watchlist",
        help="Turn this off to search older cached news for tickers that are no longer in your sidebar Watchlist.",
    )
    symbol_filter_options = ["All"] + (current_scope_symbols if only_current_watchlist else all_symbols)
    _reset_selectbox_if_value_not_allowed("history_symbol_filter", symbol_filter_options)

    all_impacts = sorted(list(dict.fromkeys([record.get("impact") for record in history if record.get("impact")])) )
    all_tags = sorted(list(dict.fromkeys([tag for record in history for tag in (record.get("tags") or [])])))

    filter_col1, filter_col2, filter_col3 = st.columns(3)
    with filter_col1:
        selected_symbol = st.selectbox("Scope/Symbol from cache", options=symbol_filter_options, index=0, key="history_symbol_filter")
    with filter_col2:
        selected_impact = st.selectbox("Impact", options=["All"] + all_impacts, index=0, key="history_impact_filter")
    with filter_col3:
        selected_tag = st.selectbox("Tag", options=["All"] + all_tags, index=0, key="history_tag_filter")

    search_text = st.text_input("Search title / summary / publisher", value="", key="history_search")
    filtered = []
    search_lower = search_text.lower().strip()
    allowed_history_symbols = set(current_scope_symbols) if only_current_watchlist else None
    for record in history:
        symbol_label = record.get("symbol") or "Market"
        if allowed_history_symbols is not None and symbol_label not in allowed_history_symbols:
            continue
        if selected_symbol != "All" and symbol_label != selected_symbol:
            continue
        if selected_impact != "All" and record.get("impact") != selected_impact:
            continue
        if selected_tag != "All" and selected_tag not in (record.get("tags") or []):
            continue
        if search_lower:
            haystack = " ".join(
                [
                    record.get("original_title", ""),
                    record.get("translated_title_zh", ""),
                    record.get("summary_zh", ""),
                    record.get("publisher", ""),
                ]
            ).lower()
            if search_lower not in haystack:
                continue
        filtered.append(record)

    filtered = sort_articles_latest(filtered)

    if only_current_watchlist:
        st.caption("History is filtered to Market + current displayed symbols. Disable the checkbox above to view cached news for hidden/old tickers.")
    st.write(f"Showing {len(filtered)} of {len(history)} cached articles. Sorted latest first.")

    df = pd.DataFrame([_article_to_row(record) for record in filtered])
    if not df.empty:
        st.dataframe(df, use_container_width=True, hide_index=True)

    with st.expander("Open cached article cards", expanded=False):
        for idx, article in enumerate(filtered[:30]):
            _render_article_card(article, ai_settings=ai_settings, watchlist=watchlist, key_prefix=f"history_{idx}")
        if len(filtered) > 30:
            st.caption("Only first 30 cards are shown here. Use the table filters above to narrow results.")

    with st.expander("Delete one cached news item", expanded=False):
        options = [
            f"{record.get('article_id')} | {record.get('symbol') or 'Market'} | {record.get('translated_title_zh') or record.get('original_title')}"
            for record in filtered
        ]
        if options:
            selected = st.selectbox("Cached item", options=options, key="delete_news_history_select")
            selected_id = selected.split(" | ")[0]
            confirm = st.checkbox("I understand this removes the cached translation/summary only.", key="delete_news_history_confirm")
            if st.button("Delete Cached News Item", type="secondary", disabled=not confirm, key="delete_news_history_button"):
                if delete_news_record(selected_id):
                    st.success("Deleted cached item.")
                    st.rerun()
                else:
                    st.warning("No matching cached item was deleted.")
        else:
            st.caption("No filtered item available to delete.")


def render_news_settings_tab():
    st.subheader("News Settings / Notes")
    st.write(f"History cache file: `{NEWS_HISTORY_FILE}`")

    with st.expander("Cache maintenance", expanded=False):
        history = load_news_history()
        stats = news_quality_stats(history)
        c1, c2, c3 = st.columns(3)
        c1.metric("Cached records", len(history))
        c2.metric("Duplicate groups", stats["duplicate_groups"])
        c3.metric("Duplicate items", stats["duplicate_items"])
        st.caption("Compact History merges duplicate cached stories using normalized URL/title matching while preserving existing Chinese summaries when possible.")
        if st.button("Compact / dedupe News History", type="secondary", key="compact_news_history_button"):
            result = compact_news_history()
            st.success(f"History compacted: {result['before']} → {result['after']} records. Removed {result['removed']} duplicate cached items.")
            st.rerun()

    st.write("Current v1 sources: `Google News RSS` and `Yahoo Finance RSS / Yahoo Finance via Google News`.")
    st.write("Apple News is not included in v1 because it does not provide a simple stable public RSS/search feed for this use case.")
    st.write("News v1 summarizes headline/snippet metadata. It keeps the original article link for reading the full source.")
    st.write("All displayed news times are converted to ET / New York time, matching US market time.")
    st.write("If an RSS provider returns a future-looking timestamp, the UI marks it with `⚠ source time` and sorting falls back to safer timestamps.")
    st.write("Chinese summaries now use a structured format: bullet-point 中文总结 + 影响分析 + 风险提示.")
    st.write("Event detection has been strengthened for earnings dates, earnings results, guidance, analyst ratings, M&A, partnerships, regulatory events, product launches, and management changes.")
    st.write("Key Events now uses event confidence scoring, can combine latest fetched articles with cached history, and supports time-range / importance filters.")
    st.write("Only new articles are sent to the selected Ollama model. Cached articles are reused from local history.")
    st.write("Stock News symbol dropdown mirrors the current Dashboard Display Stocks order, and the selected ticker header shows the Dashboard-consistent current price/quote source. News History can optionally show older cached tickers that are no longer displayed.")


def render_news_page(ai_settings: dict | None = None):
    ai_settings = _get_ai_settings(ai_settings)
    watchlist = getattr(st.session_state, "watchlist", []) or []

    st.title("News")
    st.caption(
        "Market news + stock-specific news with Chinese translation, impact tags, and local history cache. "
        "This is for research/reference only, not financial advice."
    )

    model = get_ai_model_name(ai_settings)
    num_ctx = ai_settings.get("ollama_num_ctx", "N/A")
    temperature = ai_settings.get("ollama_temperature", "N/A")
    st.info(f"Active local model: `{model}` · context `{num_ctx}` · temperature `{temperature}`")

    news_views = ["Market News", "Stock News", "News History", "Settings / Notes"]
    requested_view = st.session_state.get("news_view_selector", "Market News")
    if requested_view not in news_views:
        requested_view = "Market News"
        st.session_state.news_view_selector = requested_view

    selected_view = st.radio(
        "News View",
        options=news_views,
        horizontal=True,
        key="news_view_selector",
    )

    if selected_view == "Market News":
        render_market_news_tab(ai_settings=ai_settings, watchlist=watchlist)
    elif selected_view == "Stock News":
        render_stock_news_tab(ai_settings=ai_settings, watchlist=watchlist)
    elif selected_view == "News History":
        render_news_history_tab(ai_settings=ai_settings, watchlist=watchlist)
    else:
        render_news_settings_tab()
