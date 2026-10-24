from __future__ import annotations

import hashlib
import json
import re
import xml.etree.ElementTree as XmlET
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import quote_plus, urlparse, parse_qs, unquote, urlunparse, urlencode

import requests
import streamlit as st

from marketagent.ai_agent import call_ai_model, get_ai_model_name, is_ai_enabled
from marketagent.config import MARKET_TZ, NEGATIVE_NEWS_WORDS, NEWS_HISTORY_FILE, POSITIVE_NEWS_WORDS
from marketagent.utils import ensure_data_dir, normalize_symbol, now_et_string


DEFAULT_MARKET_QUERIES = [
    "US stock market today",
    "Nasdaq S&P 500 Dow Jones stock market today",
    "Federal Reserve interest rates CPI PPI jobs stocks",
    "AI stocks semiconductor stocks Nvidia Micron AMD",
    "market volatility Treasury yields tech stocks",
]

MARKET_TAG_KEYWORDS = {
    "Fed": ["fed", "federal reserve", "powell", "fomc"],
    "Rates": ["rate", "rates", "yield", "treasury", "bond yields", "rate cut", "rate hike"],
    "Inflation": ["inflation", "cpi", "ppi", "core pce"],
    "Jobs": ["jobs", "payroll", "unemployment", "labor market", "jobless claims"],
    "Nasdaq": ["nasdaq", "qqq"],
    "S&P 500": ["s&p", "sp 500", "s&p 500", "spy"],
    "AI": ["ai", "artificial intelligence", "data center", "datacenter"],
    "Semiconductor": ["semiconductor", "chip", "chips", "nvidia", "micron", "amd", "broadcom", "tsmc"],
    "Tech": ["tech", "technology", "megacap", "magnificent seven"],
    "Earnings": ["earnings", "results", "quarter", "guidance", "outlook"],
    "M&A": ["merger", "acquisition", "buyout", "takeover", "deal"],
}

STOCK_TAG_KEYWORDS = {
    "Earnings": ["earnings", "earnings date", "earnings call", "reports earnings", "results", "quarter", "quarterly", "revenue", "profit", "eps"],
    "Guidance": ["guidance", "forecast", "outlook", "raises forecast", "cuts forecast", "preannounce", "preannounces"],
    "Analyst Rating": ["upgrade", "downgrade", "price target", "rating", "analyst", "outperform", "underperform", "initiates", "maintains"],
    "M&A": ["acquire", "acquires", "acquired", "acquisition", "merger", "merge", "buyout", "takeover", "take-private", "deal"],
    "Product": ["launch", "product", "chip", "gpu", "memory", "server", "ai", "data center", "hbm", "product roadmap"],
    "Partnership": ["partnership", "partner", "collaboration", "contract", "customer", "supplier", "joint venture"],
    "Regulation": ["regulator", "regulatory", "lawsuit", "probe", "investigation", "antitrust", "sec", "export controls", "ban"],
    "Management": ["ceo", "cfo", "executive", "management", "resigns", "appoints", "steps down"],
    "Macro Impact": ["fed", "rates", "inflation", "tariff", "china", "export", "dollar", "sanctions"],
}

EVENT_TYPE_PRIORITY = [
    "Earnings",
    "Guidance",
    "M&A",
    "Analyst Rating",
    "Regulation",
    "Partnership",
    "Product",
    "Management",
    "Macro Impact",
]

HIGH_IMPORTANCE_EVENT_KEYWORDS = [
    "earnings date", "earnings call", "reports earnings", "guidance", "forecast", "outlook",
    "upgrade", "downgrade", "price target", "analyst", "acquisition", "acquires", "merger",
    "buyout", "takeover", "partnership", "contract", "customer", "sec", "lawsuit", "probe",
    "investigation", "antitrust", "export controls", "ceo", "cfo", "resigns", "appoints",
]


# Higher-signal event rules used by the Key Events radar.  These are intentionally
# more precise than broad news tags so that earnings / guidance / M&A / analyst
# moves do not get buried in generic company headlines.
EVENT_SIGNAL_RULES = {
    "Earnings Date": {
        "event_type": "Earnings",
        "keywords": [
            "earnings date", "earnings calendar", "announces earnings date",
            "sets earnings date", "to report earnings", "will report earnings",
            "earnings call", "conference call", "quarterly results date",
        ],
        "confidence": 95,
        "importance": "High",
    },
    "Earnings Results": {
        "event_type": "Earnings",
        "keywords": [
            "reports earnings", "reported earnings", "quarterly results", "q1 results", "q2 results",
            "q3 results", "q4 results", "eps", "revenue beats", "misses estimates",
            "beats estimates", "earnings beat", "earnings miss",
        ],
        "confidence": 92,
        "importance": "High",
    },
    "Guidance": {
        "event_type": "Guidance",
        "keywords": [
            "guidance", "raises forecast", "cuts forecast", "raises outlook", "cuts outlook",
            "full-year outlook", "revenue outlook", "profit outlook", "sales forecast",
            "preannounces", "preannounce", "warns", "warning", "lowers guidance",
        ],
        "confidence": 92,
        "importance": "High",
    },
    "M&A": {
        "event_type": "M&A",
        "keywords": [
            "acquisition", "acquires", "acquire", "merger", "merge", "buyout", "takeover",
            "take-private", "deal to buy", "to buy", "strategic alternatives", "sale process",
        ],
        "confidence": 90,
        "importance": "High",
    },
    "Analyst Rating": {
        "event_type": "Analyst Rating",
        "keywords": [
            "upgrade", "downgrade", "price target", "raises target", "cuts target",
            "initiates coverage", "reiterates", "maintains buy", "maintains sell",
            "outperform", "underperform", "neutral rating", "buy rating", "sell rating",
        ],
        "confidence": 85,
        "importance": "High",
    },
    "Regulation": {
        "event_type": "Regulation",
        "keywords": [
            "lawsuit", "sues", "sued", "probe", "investigation", "sec", "doj", "ftc",
            "antitrust", "regulator", "export controls", "ban", "sanctions", "settlement",
        ],
        "confidence": 82,
        "importance": "High",
    },
    "Partnership": {
        "event_type": "Partnership",
        "keywords": [
            "partnership", "partners with", "collaboration", "joint venture", "contract",
            "customer win", "supply agreement", "multi-year deal", "strategic agreement",
        ],
        "confidence": 75,
        "importance": "Medium",
    },
    "Product": {
        "event_type": "Product",
        "keywords": [
            "launches", "unveils", "new product", "product launch", "roadmap", "chip launch",
            "gpu", "hbm", "data center", "server", "ai chip", "memory chip",
        ],
        "confidence": 68,
        "importance": "Medium",
    },
    "Management": {
        "event_type": "Management",
        "keywords": [
            "ceo", "cfo", "appoints", "appointed", "resigns", "steps down", "succession",
            "new chief", "management change", "board of directors",
        ],
        "confidence": 72,
        "importance": "Medium",
    },
}

KEY_EVENT_TYPES = {rule["event_type"] for rule in EVENT_SIGNAL_RULES.values()}

TRACKING_QUERY_PARAMS = {
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
    "gclid", "fbclid", "mc_cid", "mc_eid", "ocid", "cmpid", "guccounter",
    "ref", "ref_src", "source", "smid", "mod", "ito", "cid",
}

TRANSLATION_CACHE_FIELDS = [
    "translated_title_zh",
    "summary_zh",
    "key_points_zh",
    "impact_analysis_zh",
    "risk_notes_zh",
    "impact",
    "importance",
    "event_type",
    "event_confidence",
    "event_reason",
    "impact_reason_zh",
    "tags",
    "related_symbols",
    "model",
    "translated_at",
    "llm_raw_response",
]


# -----------------------------------------------------------------------------
# Basic RSS fetching
# -----------------------------------------------------------------------------


def _parse_rss_datetime(value: str | None) -> str:
    if not value:
        return ""
    try:
        dt = parsedate_to_datetime(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat()
    except Exception:
        return value or ""




def _parse_news_datetime(value: str | None) -> datetime | None:
    """Parse news timestamps from RSS/ISO/ET strings into an aware datetime.

    Internal RSS timestamps are usually stored as UTC ISO strings. Local cache
    timestamps such as fetched_at / translated_at use the app's ET display format.
    """
    if not value:
        return None
    raw = str(value).strip()
    if not raw:
        return None

    try:
        normalized = raw.replace("Z", "+00:00")
        dt = datetime.fromisoformat(normalized)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        pass

    for fmt in ["%Y-%m-%d %H:%M:%S ET", "%Y-%m-%d %H:%M ET", "%Y-%m-%d"]:
        try:
            dt = datetime.strptime(raw, fmt)
            return dt.replace(tzinfo=MARKET_TZ)
        except Exception:
            pass

    try:
        dt = parsedate_to_datetime(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def _is_future_source_time(dt: datetime | None, tolerance_minutes: int = 10) -> bool:
    if dt is None:
        return False
    now_utc = datetime.now(timezone.utc)
    return dt.astimezone(timezone.utc) > now_utc + timedelta(minutes=tolerance_minutes)


def format_news_time_et(value: str | None, include_warning: bool = True) -> str:
    """Format any stored news timestamp for display in ET / New York time."""
    dt = _parse_news_datetime(value)
    if dt is None:
        return ""
    suffix = ""
    if include_warning and _is_future_source_time(dt):
        suffix = " ⚠ source time"
    return dt.astimezone(MARKET_TZ).strftime("%Y-%m-%d %H:%M ET") + suffix


def article_display_time_et(article: dict, field: str = "published_at") -> str:
    return format_news_time_et((article or {}).get(field), include_warning=(field == "published_at"))


def _strip_html(text: str | None) -> str:
    if not text:
        return ""
    text = re.sub(r"<[^>]+>", " ", str(text))
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _unwrap_google_news_link(link: str) -> str:
    """Best-effort unwrap for Google News redirect links.

    Google RSS links may be direct article URLs or Google News redirect URLs.
    We keep the original link if it cannot be safely unwrapped.
    """
    if not link:
        return ""
    try:
        parsed = urlparse(link)
        query = parse_qs(parsed.query)
        for key in ["url", "u"]:
            values = query.get(key)
            if values:
                return unquote(values[0])
        return link
    except Exception:
        return link


@st.cache_data(ttl=900, show_spinner=False)
def fetch_rss_items(url: str, source_name: str, scope: str, symbol: str | None = None, max_items: int = 10) -> list[dict]:
    """Fetch a small RSS feed into normalized news article dictionaries."""
    try:
        response = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=12)
        response.raise_for_status()
        root = XmlET.fromstring(response.content)

        items = []
        for item in root.findall(".//item")[: max_items * 2]:
            source_node = item.find("source")
            title = _strip_html(item.findtext("title"))
            link = item.findtext("link") or ""
            if source_name == "Google News":
                link = _unwrap_google_news_link(link)
            description = _strip_html(item.findtext("description"))
            publisher = source_node.text if source_node is not None and source_node.text else source_name
            published_at = _parse_rss_datetime(item.findtext("pubDate"))
            article = normalize_article(
                {
                    "scope": scope,
                    "symbol": normalize_symbol(symbol) if symbol else "",
                    "source": source_name,
                    "publisher": publisher,
                    "original_title": title,
                    "original_link": link,
                    "description": description,
                    "published_at": published_at,
                    "fetched_at": now_et_string(),
                }
            )
            if article.get("original_title") and article.get("original_link"):
                items.append(article)
            if len(items) >= max_items:
                break
        return items
    except Exception:
        return []


def build_google_news_url(query: str) -> str:
    encoded = quote_plus(query)
    return f"https://news.google.com/rss/search?q={encoded}&hl=en-US&gl=US&ceid=US:en"


def build_yahoo_symbol_url(symbol: str) -> str:
    symbol = normalize_symbol(symbol)
    return f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={quote_plus(symbol)}&region=US&lang=en-US"


def fetch_google_news(symbol: str, max_items: int = 6) -> list:
    """Backward-compatible headline fetch used by Dashboard."""
    query = f"{normalize_symbol(symbol)} stock when:7d"
    articles = fetch_rss_items(build_google_news_url(query), "Google News", "stock", symbol, max_items=max_items)
    return [
        {
            "title": article.get("original_title", ""),
            "link": article.get("original_link", ""),
            "pub_date": article.get("published_at", ""),
            "source": article.get("publisher") or article.get("source", ""),
        }
        for article in articles
    ]


@st.cache_data(ttl=900, show_spinner=False)
def fetch_market_news_items(max_items_per_query: int = 4, sources: tuple[str, ...] = ("Google News",)) -> list[dict]:
    articles = []
    if "Google News" in sources:
        for query in DEFAULT_MARKET_QUERIES:
            articles.extend(
                fetch_rss_items(
                    build_google_news_url(f"{query} when:7d"),
                    "Google News",
                    "market",
                    symbol=None,
                    max_items=max_items_per_query,
                )
            )
    if "Yahoo Finance" in sources:
        # Yahoo general market RSS can be inconsistent. This Google query pulls Yahoo Finance-published market articles.
        articles.extend(
            fetch_rss_items(
                build_google_news_url("site:finance.yahoo.com US stock market when:7d"),
                "Yahoo Finance",
                "market",
                symbol=None,
                max_items=max_items_per_query,
            )
        )
    return sort_articles_latest(dedupe_articles(articles))


@st.cache_data(ttl=900, show_spinner=False)
def fetch_stock_news_items(symbol: str, max_items_per_source: int = 8, sources: tuple[str, ...] = ("Google News", "Yahoo Finance")) -> list[dict]:
    symbol = normalize_symbol(symbol)
    articles = []
    if not symbol:
        return []

    if "Google News" in sources:
        # Use a blend of broad company queries and event-focused queries so
        # important items such as earnings dates, guidance, ratings, M&A and
        # regulatory events are less likely to be missed.
        queries = [
            f"{symbol} stock latest news when:14d",
            f"{symbol} earnings date OR earnings calendar OR earnings call when:90d",
            f"{symbol} reports earnings OR quarterly results OR EPS OR revenue when:45d",
            f"{symbol} guidance OR forecast OR outlook OR preannounce when:60d",
            f"{symbol} analyst upgrade OR downgrade OR price target OR rating when:45d",
            f"{symbol} acquisition OR merger OR buyout OR takeover OR strategic alternatives when:180d",
            f"{symbol} partnership OR contract OR customer win OR supply agreement when:90d",
            f"{symbol} lawsuit OR investigation OR antitrust OR SEC OR export controls when:120d",
            f"{symbol} CEO OR CFO OR management change OR resigns OR appoints when:120d",
        ]
        for query in queries:
            articles.extend(
                fetch_rss_items(
                    build_google_news_url(query),
                    "Google News",
                    "stock",
                    symbol=symbol,
                    max_items=max(2, max_items_per_source // 2),
                )
            )

    if "Yahoo Finance" in sources:
        articles.extend(
            fetch_rss_items(
                build_yahoo_symbol_url(symbol),
                "Yahoo Finance",
                "stock",
                symbol=symbol,
                max_items=max_items_per_source,
            )
        )

    return sort_articles_latest(dedupe_articles(articles))


# -----------------------------------------------------------------------------
# News identity, cache, and storage
# -----------------------------------------------------------------------------


def _normalize_url_for_key(link: str | None) -> str:
    """Normalize article URLs so tracking params and small source differences do not break cache hits."""
    if not link:
        return ""
    link = _unwrap_google_news_link(str(link).strip())
    if not link:
        return ""
    try:
        parsed = urlparse(link)
        if not parsed.netloc:
            return link.strip().lower()

        scheme = (parsed.scheme or "https").lower()
        netloc = parsed.netloc.lower()
        if netloc.startswith("www."):
            netloc = netloc[4:]

        # Keep meaningful query params, remove common tracking noise, and sort for deterministic identity.
        query_pairs = []
        for key, values in parse_qs(parsed.query, keep_blank_values=False).items():
            key_lower = key.lower()
            if key_lower in TRACKING_QUERY_PARAMS or key_lower.startswith("utm_"):
                continue
            for value in values:
                if value:
                    query_pairs.append((key, value))
        query_pairs = sorted(query_pairs)
        query = urlencode(query_pairs, doseq=True)

        path = re.sub(r"/+$", "", parsed.path or "")
        normalized = urlunparse((scheme, netloc, path, "", query, ""))
        return normalized.lower()
    except Exception:
        return re.sub(r"\s+", "", link.lower())


def _normalize_title_for_key(title: str | None, publisher: str | None = None) -> str:
    title = _strip_html(title or "").lower()
    publisher = _strip_html(publisher or "").lower()
    # Google News titles often look like "Headline - Publisher". Remove the trailing publisher suffix when it matches.
    if publisher and title.endswith(f" - {publisher}"):
        title = title[: -len(f" - {publisher}")]
    title = re.sub(r"\([^)]*\)", " ", title)
    title = re.sub(r"[^a-z0-9]+", " ", title)
    stop_words = {"the", "a", "an", "to", "of", "for", "and", "or", "on", "in", "with", "from", "by"}
    tokens = [token for token in title.split() if token not in stop_words]
    return " ".join(tokens[:24]).strip()


def _article_identity_keys(article: dict) -> list[str]:
    """Return stable identity keys used for dedupe and cache lookup.

    We use multiple keys because news feeds often expose the same story through
    different URLs: a Google News redirect, a publisher URL with tracking params,
    and a Yahoo/Google syndicated headline can all describe the same item.
    """
    article = normalize_article(article) if not article.get("article_id") else dict(article)
    scope = article.get("scope") or "stock"
    symbol = normalize_symbol(article.get("symbol", "")) if article.get("symbol") else "market"
    publisher = (article.get("publisher") or article.get("source") or "").strip().lower()
    normalized_url = _normalize_url_for_key(article.get("original_link"))
    normalized_title = _normalize_title_for_key(article.get("original_title"), publisher=publisher)

    keys = []
    if article.get("article_id"):
        keys.append(f"id:{article.get('article_id')}")
    if normalized_url:
        keys.append(f"url:{normalized_url}")
    if normalized_title:
        # Scope/symbol keeps unrelated market and single-stock stories from merging too aggressively.
        keys.append(f"title:{scope}:{symbol}:{normalized_title}")
        # Publisher-title catches old cached records where symbol/scope may differ slightly.
        if publisher:
            keys.append(f"publisher_title:{publisher}:{normalized_title}")
    return list(dict.fromkeys(keys))


def canonical_article_key(article: dict) -> str:
    normalized_url = _normalize_url_for_key(article.get("original_link") or article.get("link"))
    if normalized_url:
        return normalized_url
    publisher = article.get("publisher") or article.get("source") or ""
    normalized_title = _normalize_title_for_key(article.get("original_title") or article.get("title"), publisher=publisher)
    scope = article.get("scope") or "stock"
    symbol = normalize_symbol(article.get("symbol", "")) if article.get("symbol") else "market"
    return f"{scope}|{symbol}|{normalized_title}"


def build_article_id(article: dict) -> str:
    raw_key = canonical_article_key(article)
    return hashlib.sha1(raw_key.encode("utf-8", errors="ignore")).hexdigest()[:16]


def normalize_article(article: dict) -> dict:
    article = dict(article or {})
    article["scope"] = article.get("scope") or "stock"
    article["symbol"] = normalize_symbol(article.get("symbol", "")) if article.get("symbol") else ""
    article["source"] = article.get("source") or "Unknown"
    article["publisher"] = article.get("publisher") or article.get("source") or "Unknown"
    article["original_title"] = _strip_html(article.get("original_title") or article.get("title") or "")
    article["original_link"] = _unwrap_google_news_link(article.get("original_link") or article.get("link") or "")
    article["description"] = _strip_html(article.get("description") or article.get("summary") or "")
    article["published_at"] = article.get("published_at") or article.get("pub_date") or ""
    article["fetched_at"] = article.get("fetched_at") or now_et_string()
    article["article_id"] = article.get("article_id") or build_article_id(article)
    article["normalized_url"] = article.get("normalized_url") or _normalize_url_for_key(article.get("original_link"))
    article["normalized_title"] = article.get("normalized_title") or _normalize_title_for_key(article.get("original_title"), article.get("publisher"))
    article.setdefault("translated_title_zh", "")
    article.setdefault("summary_zh", "")
    article.setdefault("key_points_zh", [])
    article.setdefault("impact_analysis_zh", "")
    article.setdefault("risk_notes_zh", "")
    article.setdefault("impact", "")
    article.setdefault("importance", "")
    article.setdefault("event_type", "")
    article.setdefault("event_confidence", 0)
    article.setdefault("event_reason", "")
    article.setdefault("impact_reason_zh", "")
    article.setdefault("tags", [])
    article.setdefault("related_symbols", [])
    article.setdefault("model", "")
    article.setdefault("translated_at", "")
    article["duplicate_count"] = int(article.get("duplicate_count") or 0)
    article["duplicate_sources"] = article.get("duplicate_sources") if isinstance(article.get("duplicate_sources"), list) else []
    article["duplicate_publishers"] = article.get("duplicate_publishers") if isinstance(article.get("duplicate_publishers"), list) else []
    article["duplicate_titles"] = article.get("duplicate_titles") if isinstance(article.get("duplicate_titles"), list) else []
    article["duplicate_links"] = article.get("duplicate_links") if isinstance(article.get("duplicate_links"), list) else []
    article["dedupe_reason"] = article.get("dedupe_reason") or ""
    return article



def _article_sort_timestamp(article: dict) -> float:
    """Return a sortable timestamp for latest-first news ordering.

    We prefer published_at, but some RSS providers occasionally return source
    times that appear in the future because of timezone/feed quirks. Those are
    skipped for sorting so they do not incorrectly jump ahead of true latest news.
    """
    for field in ["published_at", "fetched_at", "translated_at"]:
        dt = _parse_news_datetime((article or {}).get(field))
        if dt is None:
            continue
        if field == "published_at" and _is_future_source_time(dt):
            # Keep the raw timestamp for display with a warning, but don't let it
            # dominate latest-first ordering.
            continue
        return dt.timestamp()
    return 0.0


def sort_articles_latest(articles: list[dict]) -> list[dict]:
    """Sort normalized or raw article dictionaries from newest to oldest."""
    normalized = [normalize_article(article) for article in articles or []]
    return sorted(normalized, key=lambda item: (_article_sort_timestamp(item), item.get("article_id", "")), reverse=True)


def _list_union(*values) -> list[str]:
    output = []
    for value in values:
        if isinstance(value, list):
            items = value
        elif value:
            items = [value]
        else:
            items = []
        for item in items:
            text = str(item).strip()
            if text and text not in output:
                output.append(text)
    return output


def _choose_primary_article(existing: dict, incoming: dict) -> tuple[dict, dict]:
    """Choose the better visible article from a duplicate group."""
    existing_ts = _article_sort_timestamp(existing)
    incoming_ts = _article_sort_timestamp(incoming)
    # Prefer the newer article unless the difference is tiny and existing already has translation/cache fields.
    if incoming_ts > existing_ts + 60:
        return incoming, existing
    if existing.get("translated_at") or existing.get("summary_zh"):
        return existing, incoming
    if incoming.get("description") and not existing.get("description"):
        return incoming, existing
    return existing, incoming


def _merge_duplicate_article(existing: dict, incoming: dict, match_key: str = "") -> dict:
    existing = normalize_article(existing)
    incoming = normalize_article(incoming)
    primary, secondary = _choose_primary_article(existing, incoming)
    merged = {**secondary, **primary}

    # Preserve any cached LLM fields from either record.
    for field in TRANSLATION_CACHE_FIELDS:
        if existing.get(field):
            merged[field] = existing.get(field)
        if incoming.get(field) and not merged.get(field):
            merged[field] = incoming.get(field)

    merged["duplicate_count"] = int(existing.get("duplicate_count") or 0) + int(incoming.get("duplicate_count") or 0) + 1
    merged["duplicate_sources"] = _list_union(existing.get("duplicate_sources"), incoming.get("duplicate_sources"), existing.get("source"), incoming.get("source"))
    merged["duplicate_publishers"] = _list_union(existing.get("duplicate_publishers"), incoming.get("duplicate_publishers"), existing.get("publisher"), incoming.get("publisher"))
    merged["duplicate_titles"] = _list_union(existing.get("duplicate_titles"), incoming.get("duplicate_titles"), existing.get("original_title"), incoming.get("original_title"))
    merged["duplicate_links"] = _list_union(existing.get("duplicate_links"), incoming.get("duplicate_links"), existing.get("original_link"), incoming.get("original_link"))
    merged["dedupe_reason"] = existing.get("dedupe_reason") or incoming.get("dedupe_reason") or match_key.replace("url:", "URL match").replace("title:", "Title match")[:120]
    return normalize_article(merged)


def dedupe_articles(articles: list[dict]) -> list[dict]:
    key_to_index: dict[str, int] = {}
    unique: list[dict] = []
    for raw_article in articles or []:
        article = normalize_article(raw_article)
        keys = _article_identity_keys(article)
        match_key = next((key for key in keys if key in key_to_index), "")
        if not match_key:
            unique.append(article)
            idx = len(unique) - 1
            for key in keys:
                key_to_index[key] = idx
            continue

        idx = key_to_index[match_key]
        unique[idx] = _merge_duplicate_article(unique[idx], article, match_key=match_key)
        # Register all aliases from the merged record so later duplicates hit the same group.
        for key in _article_identity_keys(unique[idx]):
            key_to_index[key] = idx
    return unique


def news_quality_stats(articles: list[dict]) -> dict:
    articles = [normalize_article(article) for article in articles or []]
    duplicate_items = sum(int(article.get("duplicate_count") or 0) for article in articles)
    duplicate_groups = sum(1 for article in articles if int(article.get("duplicate_count") or 0) > 0)
    cached = sum(1 for article in articles if article.get("cache_status") == "Cached")
    new = sum(1 for article in articles if article.get("cache_status") == "New")
    raw_estimate = len(articles) + duplicate_items
    return {
        "unique": len(articles),
        "raw_estimate": raw_estimate,
        "duplicate_items": duplicate_items,
        "duplicate_groups": duplicate_groups,
        "cached": cached,
        "new": new,
    }


def load_news_history() -> list[dict]:
    if not NEWS_HISTORY_FILE.exists():
        return []
    try:
        with open(NEWS_HISTORY_FILE, "r", encoding="utf-8") as file:
            data = json.load(file)
        if not isinstance(data, list):
            return []
        return sort_articles_latest([normalize_article(item) for item in data if isinstance(item, dict)])
    except Exception:
        return []


def save_news_history(records: list[dict]):
    ensure_data_dir()
    cleaned = sort_articles_latest([normalize_article(record) for record in records or [] if isinstance(record, dict)])
    with open(NEWS_HISTORY_FILE, "w", encoding="utf-8") as file:
        json.dump(cleaned, file, indent=2, ensure_ascii=False)


def get_news_history_index() -> dict[str, dict]:
    index: dict[str, dict] = {}
    for record in load_news_history():
        if record.get("article_id"):
            index.setdefault(record.get("article_id"), record)
            index.setdefault(f"id:{record.get('article_id')}", record)
        for key in _article_identity_keys(record):
            index.setdefault(key, record)
    return index


def find_cached_article(article: dict, history_index: dict[str, dict] | None = None) -> dict | None:
    history_index = history_index if history_index is not None else get_news_history_index()
    article = normalize_article(article)
    candidates = []
    if article.get("article_id"):
        candidates.extend([article.get("article_id"), f"id:{article.get('article_id')}"])
    candidates.extend(_article_identity_keys(article))
    for key in candidates:
        cached = history_index.get(key)
        if cached:
            return cached
    return None


def merge_with_history(fetched_articles: list[dict], history_index: dict[str, dict] | None = None) -> list[dict]:
    history_index = history_index if history_index is not None else get_news_history_index()
    merged = []
    for article in sort_articles_latest(dedupe_articles(fetched_articles)):
        cached = find_cached_article(article, history_index=history_index)
        if cached:
            # Keep fresh source/published metadata from the latest fetch but reuse cached LLM fields.
            record = {**cached, **article, "cache_status": "Cached"}
            for field in TRANSLATION_CACHE_FIELDS:
                if cached.get(field):
                    record[field] = cached.get(field)
        else:
            record = {**article, "cache_status": "New"}
        merged.append(normalize_article(record))
    return sort_articles_latest(merged)


def upsert_news_records(records: list[dict]) -> int:
    history = load_news_history()
    index = get_news_history_index()
    changed = 0
    for raw_record in records or []:
        record = normalize_article(raw_record)
        if not record.get("article_id"):
            continue
        cached = find_cached_article(record, history_index=index)
        if cached:
            target_id = cached.get("article_id")
            for i, existing in enumerate(history):
                if existing.get("article_id") == target_id:
                    history[i] = _merge_duplicate_article(existing, record, match_key="cache upsert")
                    # Explicitly keep the original cached article_id so existing UI/delete references stay stable.
                    history[i]["article_id"] = target_id
                    break
        else:
            history.append(record)
        changed += 1
        index = get_news_history_index() if changed % 25 == 0 else index
    if changed:
        save_news_history(dedupe_articles(history))
    return changed


def delete_news_record(article_id: str) -> bool:
    article_id = (article_id or "").strip()
    if not article_id:
        return False
    history = load_news_history()
    new_history = [record for record in history if record.get("article_id") != article_id]
    if len(new_history) == len(history):
        return False
    save_news_history(new_history)
    return True


def compact_news_history() -> dict:
    """Deduplicate existing local history and keep the richest cached record per story."""
    history = load_news_history()
    before = len(history)
    compacted = sort_articles_latest(dedupe_articles(history))
    after = len(compacted)
    if after != before:
        save_news_history(compacted)
    return {"before": before, "after": after, "removed": before - after}


# -----------------------------------------------------------------------------
# Lightweight rule classification + LLM enrichment
# -----------------------------------------------------------------------------


def _keyword_tags(text: str, tag_keywords: dict[str, list[str]]) -> list[str]:
    text = (text or "").lower()
    tags = []
    for tag, keywords in tag_keywords.items():
        if any(keyword.lower() in text for keyword in keywords):
            tags.append(tag)
    return tags


def _event_signal_details(text: str) -> dict:
    """Return the strongest event signal found in the headline/snippet.

    The regular tag classifier is intentionally broad.  This helper is stricter
    and produces a confidence score/reason for the Key Events table.
    """
    lower_text = (text or "").lower()
    best = {
        "event_type": "General",
        "event_confidence": 0,
        "event_reason": "No high-signal event keyword detected.",
        "importance": "Low",
        "matched_keywords": [],
    }

    for signal_name, rule in EVENT_SIGNAL_RULES.items():
        hits = [kw for kw in rule.get("keywords", []) if kw.lower() in lower_text]
        if not hits:
            continue
        confidence = int(rule.get("confidence", 60)) + min(len(hits) - 1, 3) * 3
        if confidence > int(best.get("event_confidence") or 0):
            best = {
                "event_type": rule.get("event_type", signal_name),
                "event_confidence": min(confidence, 99),
                "event_reason": f"Matched {signal_name} keyword(s): " + ", ".join(hits[:4]),
                "importance": rule.get("importance", "Medium"),
                "matched_keywords": hits[:6],
            }
    return best


def is_key_event_article(article: dict, watchlist: list[str] | None = None) -> bool:
    """True when an article should appear in the Stock News Key Events radar."""
    article = normalize_article(article)
    rules = rule_classify_article(article, watchlist=watchlist)
    event_type = article.get("event_type") or rules.get("event_type") or "General"
    confidence = int(article.get("event_confidence") or rules.get("event_confidence") or 0)
    importance = article.get("importance") or rules.get("importance") or "Low"
    tags = set(article.get("tags") or rules.get("tags") or [])
    return (
        confidence >= 65
        or importance == "High"
        or event_type in KEY_EVENT_TYPES
        or bool(tags.intersection(KEY_EVENT_TYPES))
    )


def rule_classify_article(article: dict, watchlist: list[str] | None = None) -> dict:
    text = " ".join([
        article.get("original_title", ""),
        article.get("description", ""),
        article.get("publisher", ""),
    ])
    lower_text = text.lower()
    positive_hits = sum(1 for word in POSITIVE_NEWS_WORDS if word in lower_text)
    negative_hits = sum(1 for word in NEGATIVE_NEWS_WORDS if word in lower_text)
    score = positive_hits - negative_hits

    if score >= 2:
        impact = "Bullish"
    elif score <= -2:
        impact = "Bearish"
    elif score == 1:
        impact = "Slightly Bullish"
    elif score == -1:
        impact = "Slightly Bearish"
    else:
        impact = "Neutral"

    scope = article.get("scope") or "stock"
    tags = _keyword_tags(text, MARKET_TAG_KEYWORDS if scope == "market" else STOCK_TAG_KEYWORDS)
    event_signal = _event_signal_details(text)
    signal_event_type = event_signal.get("event_type") or "General"
    if signal_event_type != "General" and signal_event_type not in tags:
        tags.append(signal_event_type)
    if not tags:
        tags = ["General"]

    importance = "Medium" if tags and tags != ["General"] else "Low"
    high_tags = {"Earnings", "Guidance", "M&A", "Fed", "Rates", "Inflation", "Analyst Rating", "Regulation"}
    if any(tag in high_tags for tag in tags) or any(keyword in lower_text for keyword in HIGH_IMPORTANCE_EVENT_KEYWORDS):
        importance = "High"
    if event_signal.get("importance") == "High" or int(event_signal.get("event_confidence") or 0) >= 85:
        importance = "High"
    elif importance == "Low" and int(event_signal.get("event_confidence") or 0) >= 65:
        importance = "Medium"

    event_type = "General"
    if signal_event_type != "General":
        event_type = signal_event_type
    else:
        for candidate in EVENT_TYPE_PRIORITY:
            if candidate in tags:
                event_type = candidate
                break
    if scope == "market" and event_type == "General":
        for candidate in ["Fed", "Rates", "Inflation", "Jobs", "Semiconductor", "AI", "Tech", "M&A"]:
            if candidate in tags:
                event_type = candidate
                break

    related_symbols = []
    for symbol in watchlist or []:
        symbol = normalize_symbol(symbol)
        if symbol and symbol.lower() in lower_text:
            related_symbols.append(symbol)

    return {
        "impact": impact,
        "importance": importance,
        "event_type": event_type,
        "event_confidence": int(event_signal.get("event_confidence") or 0),
        "event_reason": event_signal.get("event_reason") or "Rule-based event scan.",
        "tags": tags,
        "related_symbols": sorted(list(dict.fromkeys(related_symbols))),
        "impact_reason_zh": "Rule-based preliminary classification from headline/event keywords.",
    }




def article_has_ai_summary(article: dict) -> bool:
    """True when a cached article already has an AI-generated translation/summary."""
    article = article or {}
    if str(article.get("ai_status") or "").lower() == "source_only":
        return False
    return bool(article.get("translated_at") and (article.get("summary_zh") or article.get("translated_title_zh")))


def build_source_only_article(article: dict, watchlist: list[str] | None = None) -> dict:
    """Store/display a news record without translation when AI Provider is Off."""
    article = normalize_article(article)
    rules = rule_classify_article(article, watchlist=watchlist)
    return normalize_article(
        {
            **article,
            **rules,
            "ai_status": "source_only",
            "model": "AI off",
            "translated_at": "",
            "translated_title_zh": "",
            "summary_zh": "",
            "key_points_zh": [],
            "impact_analysis_zh": "",
            "risk_notes_zh": "",
            "llm_raw_response": "",
        }
    )

def build_news_llm_prompt(article: dict, watchlist: list[str] | None = None) -> str:
    scope = article.get("scope") or "stock"
    symbol_text = article.get("symbol") or "Market / General"
    watchlist_text = ", ".join(watchlist or [])

    return f"""
You are MarketAgentPro's news analyst.

Task:
Translate and summarize one financial news item for a Chinese-speaking investor.
Be factual and cautious. Do not invent facts that are not present in the headline/description.
If the source text is only a headline/snippet, clearly say the summary is based on limited headline/snippet information.

Return ONLY valid JSON with these keys:
- translated_title_zh: Chinese title translation
- key_points_zh: array of 3-6 Chinese bullet points. Each bullet should be one complete sentence and should cover what happened, key company/market context, and why investors may care.
- impact_analysis_zh: 2-4 Chinese sentences. Explain the possible market/stock impact, whether the impact is direct or indirect, and why the impact classification was chosen.
- risk_notes_zh: 2-4 Chinese sentences or short bullet-style sentences. Highlight uncertainty, missing information, headline/snippet limitations, and what investors should verify before acting.
- summary_zh: a Markdown-formatted Chinese section using this exact structure:
  **中文总结**
  - bullet point 1
  - bullet point 2
  - bullet point 3

  **影响分析**
  - bullet point 1
  - bullet point 2

  **风险提示**
  - bullet point 1
  - bullet point 2
- impact: one of Bullish, Bearish, Neutral, Mixed, Unclear
- importance: one of High, Medium, Low
- event_type: one short event category such as Earnings, Guidance, Analyst Rating, M&A, Product, Partnership, Regulation, Macro, Fed, Rates, Market, General
- tags: array of short tags, such as Earnings, Guidance, Analyst Rating, M&A, Product, Partnership, Regulation, Macro, AI, Semiconductor, Fed, Rates, Market
- impact_reason_zh: 2-3 Chinese sentences explaining the impact classification and any uncertainty. This can overlap with impact_analysis_zh but should be concise.
- related_symbols: array of symbols from this watchlist if clearly related: {watchlist_text}

Style requirements:
- Use bullet points, not one dense paragraph.
- Be more detailed than a headline translation, but do not invent facts beyond the title/snippet.
- If only a headline/snippet is available, clearly state that the conclusion is based on limited information.
- For stock-specific news, focus on earnings, guidance, analyst rating, M&A, products, partnerships, regulation, and important company events when relevant.
- For market news, focus on macro, rates, Fed, inflation, Nasdaq/S&P 500, tech/AI/semiconductor sentiment when relevant.

Scope: {scope}
Symbol: {symbol_text}
Source: {article.get('source')}
Publisher: {article.get('publisher')}
Published ET: {format_news_time_et(article.get('published_at'))}
Published raw: {article.get('published_at')}
Original title: {article.get('original_title')}
Description/snippet: {article.get('description')}
Original link: {article.get('original_link')}
""".strip()


def _extract_json_object(text: str) -> dict:
    if not text:
        return {}
    text = text.strip()
    try:
        return json.loads(text)
    except Exception:
        pass

    match = re.search(r"\{.*\}", text, flags=re.S)
    if match:
        try:
            return json.loads(match.group(0))
        except Exception:
            return {}
    return {}


def enrich_article_with_llm(article: dict, ai_settings: dict, watchlist: list[str] | None = None) -> dict:
    article = normalize_article(article)
    if not is_ai_enabled(ai_settings):
        return build_source_only_article(article, watchlist=watchlist)

    rules = rule_classify_article(article, watchlist=watchlist)
    prompt = build_news_llm_prompt(article, watchlist=watchlist)

    model = get_ai_model_name(ai_settings)
    raw_response = call_ai_model(prompt, ai_settings=ai_settings)
    parsed = _extract_json_object(raw_response)

    enriched = {
        **article,
        **rules,
        "ai_status": "ai_enriched",
        "model": model,
        "translated_at": now_et_string(),
        "llm_raw_response": raw_response[:2000] if raw_response else "",
    }

    if parsed:
        enriched["translated_title_zh"] = str(parsed.get("translated_title_zh") or article.get("original_title") or "")

        key_points = parsed.get("key_points_zh") if isinstance(parsed.get("key_points_zh"), list) else []
        enriched["key_points_zh"] = [str(point).strip() for point in key_points if str(point).strip()]
        enriched["impact_analysis_zh"] = str(parsed.get("impact_analysis_zh") or "").strip()
        enriched["risk_notes_zh"] = str(parsed.get("risk_notes_zh") or "").strip()

        summary = str(parsed.get("summary_zh") or "").strip()
        if not summary:
            summary_sections = []
            if enriched["key_points_zh"]:
                summary_sections.append("**中文总结**\n" + "\n".join([f"- {point}" for point in enriched["key_points_zh"]]))
            if enriched["impact_analysis_zh"]:
                summary_sections.append("**影响分析**\n" + "\n".join([f"- {line.strip()}" for line in re.split(r"(?<=[。！？])\s*", enriched["impact_analysis_zh"]) if line.strip()]))
            if enriched["risk_notes_zh"]:
                summary_sections.append("**风险提示**\n" + "\n".join([f"- {line.strip()}" for line in re.split(r"(?<=[。！？])\s*", enriched["risk_notes_zh"]) if line.strip()]))
            summary = "\n\n".join(summary_sections)
        enriched["summary_zh"] = summary

        enriched["impact"] = str(parsed.get("impact") or rules.get("impact") or "Neutral")
        enriched["importance"] = str(parsed.get("importance") or rules.get("importance") or "Low")
        enriched["event_type"] = str(parsed.get("event_type") or rules.get("event_type") or "General")
        tags = parsed.get("tags") if isinstance(parsed.get("tags"), list) else rules.get("tags", [])
        enriched["tags"] = [str(tag) for tag in tags if str(tag).strip()] or rules.get("tags", [])
        enriched["impact_reason_zh"] = str(parsed.get("impact_reason_zh") or rules.get("impact_reason_zh") or "")
        related_symbols = parsed.get("related_symbols") if isinstance(parsed.get("related_symbols"), list) else rules.get("related_symbols", [])
        enriched["related_symbols"] = [normalize_symbol(symbol) for symbol in related_symbols if normalize_symbol(symbol)]
    else:
        enriched["translated_title_zh"] = article.get("original_title") or ""
        enriched["summary_zh"] = "AI did not return valid JSON. This cached item uses rule-based classification only."

    return normalize_article(enriched)


def process_new_articles(
    articles: list[dict],
    ai_settings: dict,
    watchlist: list[str] | None = None,
    limit: int = 10,
) -> dict:
    history_index = get_news_history_index()
    deduped = sort_articles_latest(dedupe_articles(articles))
    ai_on = is_ai_enabled(ai_settings)

    if not ai_on:
        # Publish/BYOK-safe behavior: preserve source-only news and rule/event
        # classification, but do not translate or call an LLM.
        source_only = [build_source_only_article(article, watchlist=watchlist) for article in deduped]
        saved = upsert_news_records(source_only)
        return {
            "fetched": len(articles or []),
            "new": len([article for article in deduped if not find_cached_article(article, history_index=history_index)]),
            "processed": 0,
            "saved": saved,
            "skipped_existing": max(len(articles or []) - saved, 0),
            "errors": [],
            "ai_enabled": False,
            "message": "AI Provider is Off. Saved source-only English news and rule-based event classification; no translation was generated.",
        }

    # With AI enabled, process stories that are brand-new OR cached only as
    # source-only records from a previous no-AI session.
    targets = []
    skipped_existing = 0
    for article in deduped:
        cached = find_cached_article(article, history_index=history_index)
        if cached and article_has_ai_summary(cached):
            skipped_existing += 1
            continue
        targets.append(article)

    to_process = targets[: max(int(limit or 0), 0)]
    processed = []
    errors = []

    for article in to_process:
        try:
            processed.append(enrich_article_with_llm(article, ai_settings=ai_settings, watchlist=watchlist))
        except Exception as e:
            fallback = build_source_only_article(article, watchlist=watchlist)
            fallback["summary_zh"] = f"AI translation failed: {e}"
            fallback["translated_at"] = now_et_string()
            processed.append(fallback)
            errors.append(str(e))

    saved = upsert_news_records(processed)
    return {
        "fetched": len(articles or []),
        "new": len(targets),
        "processed": len(processed),
        "saved": saved,
        "skipped_existing": skipped_existing,
        "errors": errors,
        "ai_enabled": True,
    }


# -----------------------------------------------------------------------------
# Dashboard news context helpers
# -----------------------------------------------------------------------------


def _article_age_within_days(article: dict, days: int | None) -> bool:
    if days is None:
        return True
    ts = _article_sort_timestamp(article)
    if not ts:
        return False
    cutoff = datetime.now(MARKET_TZ).timestamp() - int(days) * 24 * 60 * 60
    return ts >= cutoff


def dashboard_stock_news_context(
    symbol: str,
    news_items: list | None = None,
    max_items: int = 6,
    days: int = 14,
    cached_only: bool = False,
) -> list[dict]:
    """Build a compact recent-news context for Dashboard AI analysis.

    By default it combines cached translated Stock News records with lightweight
    Google headlines. When ``cached_only`` is True, only News-history items that
    already have an AI/cached translation are included — no live headline fetch
    is merged in.
    """
    symbol = normalize_symbol(symbol)
    if not symbol:
        return []

    candidates: list[dict] = []

    for record in load_news_history():
        if normalize_symbol(record.get("symbol", "")) != symbol:
            continue
        if not _article_age_within_days(record, days):
            continue
        if cached_only and not article_has_ai_summary(record):
            continue
        candidates.append({**record, "dashboard_context_status": "Cached summary"})

    if not cached_only:
        for item in news_items or []:
            article = normalize_article(
                {
                    "scope": "stock",
                    "symbol": symbol,
                    "source": item.get("source") or "Google News",
                    "publisher": item.get("source") or "Google News",
                    "original_title": item.get("title", ""),
                    "original_link": item.get("link", ""),
                    "published_at": item.get("pub_date", ""),
                    "fetched_at": now_et_string(),
                }
            )
            article["dashboard_context_status"] = "Latest headline"
            cached = find_cached_article(article)
            if cached:
                merged = {**cached, **article, "dashboard_context_status": "Cached summary"}
                for field in TRANSLATION_CACHE_FIELDS:
                    if cached.get(field):
                        merged[field] = cached.get(field)
                article = normalize_article(merged)
            candidates.append(article)

    cleaned = sort_articles_latest(dedupe_articles(candidates))
    limit = max(0 if cached_only else 1, int(max_items or 6))
    return cleaned[:limit]


def news_context_signature(articles: list[dict]) -> str:
    parts = []
    for article in articles or []:
        parts.append(
            "|".join(
                [
                    article.get("article_id", ""),
                    article.get("translated_at", ""),
                    article.get("published_at", ""),
                    article.get("impact", ""),
                    article.get("event_type", ""),
                ]
            )
        )
    raw = "||".join(parts)
    return hashlib.sha1(raw.encode("utf-8", errors="ignore")).hexdigest()[:10] if raw else "no-news"


def _format_list_for_prompt(value, max_items: int = 4) -> str:
    if isinstance(value, list):
        items = [str(item).strip() for item in value if str(item).strip()]
        return "; ".join(items[:max_items])
    if value:
        return str(value).strip()
    return ""


def format_dashboard_news_context_for_prompt(articles: list[dict]) -> str:
    """Format recent stock news for a specific Dashboard analyst prompt.

    The model should receive enough concrete evidence to discuss the *actual*
    news instead of reverting to a generic tone label. Each article includes
    original title, translated/cached summary when available, source, event
    classification, impact, and snippet-level warnings.
    """
    lines = []
    for idx, article in enumerate(articles or [], start=1):
        title = article.get("translated_title_zh") or article.get("original_title") or "Untitled"
        original_title = article.get("original_title") or title
        source = article.get("source") or article.get("publisher") or "Unknown source"
        publisher = article.get("publisher") or article.get("source") or "Unknown publisher"
        published = article_display_time_et(article, "published_at") or "N/A"
        impact = article.get("impact") or "Unclear"
        importance = article.get("importance") or "N/A"
        event_type = article.get("event_type") or "General"
        confidence = article.get("event_confidence") or 0
        reason = article.get("event_reason") or ""
        status = article.get("dashboard_context_status") or article.get("cache_status") or "News"
        description = str(article.get("description") or "").strip()
        summary = article.get("summary_zh") or ""
        key_points = _format_list_for_prompt(article.get("key_points_zh"), max_items=5)
        impact_analysis = article.get("impact_analysis_zh") or article.get("impact_reason_zh") or ""
        risk_notes = article.get("risk_notes_zh") or ""
        tags = article.get("tags") or []
        tag_text = ", ".join(tags[:8]) if isinstance(tags, list) else str(tags)
        link = article.get("original_link") or ""

        evidence_quality = "cached translated summary" if (summary or impact_analysis or key_points) else "headline/snippet only"
        if not summary and not impact_analysis and not key_points:
            summary = "No translated summary yet. Only title/snippet evidence is available; treat this item as lower confidence."

        article_lines = [
            f"[{idx}] {title}",
            f"- Original title: {original_title}",
            f"- Source: {source} | Publisher: {publisher}",
            f"- Published ET: {published}",
            f"- Evidence quality: {evidence_quality} | Status: {status}",
            f"- Event type: {event_type} | Event confidence: {confidence} | Event reason: {reason}",
            f"- Importance: {importance} | Impact: {impact} | Tags: {tag_text}",
            f"- Summary: {summary}",
        ]

        if description and description not in summary:
            article_lines.append(f"- Source snippet: {description[:700]}")
        if key_points:
            article_lines.append(f"- Key points: {key_points}")
        if impact_analysis:
            article_lines.append(f"- Impact analysis: {impact_analysis}")
        if risk_notes:
            article_lines.append(f"- Risk notes: {risk_notes}")
        if link:
            article_lines.append(f"- Link available: yes")

        lines.append("\n".join(article_lines))

    return "\n\n".join(lines) if lines else "- No recent stock-specific news context found."


def _normalize_news_impact_label(value) -> str:
    text = str(value or "").strip().lower()
    if not text:
        return "Unclear"
    if any(token in text for token in ["bullish", "positive", "利好", "upside"]):
        return "Bullish"
    if any(token in text for token in ["bearish", "negative", "利空", "downside"]):
        return "Bearish"
    if any(token in text for token in ["mixed", "混合"]):
        return "Mixed"
    if any(token in text for token in ["neutral", "中性"]):
        return "Neutral"
    return str(value).strip() or "Unclear"


def _normalize_importance_label(value) -> str:
    text = str(value or "").strip().lower()
    if "high" in text or "高" in text:
        return "High"
    if "medium" in text or "med" in text or "中" in text:
        return "Medium"
    if "low" in text or "低" in text:
        return "Low"
    return str(value).strip() or "N/A"


def dashboard_news_overall_snapshot(articles: list[dict]) -> dict:
    """Return a compact aggregate view of recent news for Dashboard UI and prompts."""
    articles = list(articles or [])
    impact_counts = {"Bullish": 0, "Bearish": 0, "Neutral": 0, "Mixed": 0, "Unclear": 0}
    importance_counts = {"High": 0, "Medium": 0, "Low": 0, "N/A": 0}
    event_counts: dict[str, int] = {}
    cached_count = 0
    headline_only_count = 0
    high_impact_items = []
    latest_items = []

    for idx, article in enumerate(articles, start=1):
        impact = _normalize_news_impact_label(article.get("impact"))
        importance = _normalize_importance_label(article.get("importance"))
        event_type = article.get("event_type") or "General"
        status = article.get("dashboard_context_status") or article.get("cache_status") or "News"
        has_summary = bool(article.get("summary_zh") or article.get("impact_analysis_zh") or article.get("key_points_zh"))
        title = article.get("translated_title_zh") or article.get("original_title") or "Untitled"
        published = article_display_time_et(article, "published_at") or "N/A"

        impact_counts[impact] = impact_counts.get(impact, 0) + 1
        importance_counts[importance] = importance_counts.get(importance, 0) + 1
        event_counts[event_type] = event_counts.get(event_type, 0) + 1
        if has_summary or "cached" in str(status).lower():
            cached_count += 1
        if not has_summary:
            headline_only_count += 1

        item = {
            "idx": idx,
            "title": title,
            "published": published,
            "impact": impact,
            "importance": importance,
            "event_type": event_type,
            "status": status,
            "headline_only": not has_summary,
        }
        latest_items.append(item)
        if importance == "High" or impact in {"Bullish", "Bearish", "Mixed"}:
            high_impact_items.append(item)

    directional = impact_counts.get("Bullish", 0) + impact_counts.get("Bearish", 0) + impact_counts.get("Mixed", 0)
    if not articles:
        combined = "No recent stock-specific news"
        confidence = "Low"
    elif impact_counts.get("Bullish", 0) > impact_counts.get("Bearish", 0) and impact_counts.get("Bullish", 0) >= 2:
        combined = "Mostly Bullish"
        confidence = "Medium" if cached_count else "Low"
    elif impact_counts.get("Bearish", 0) > impact_counts.get("Bullish", 0) and impact_counts.get("Bearish", 0) >= 2:
        combined = "Mostly Bearish"
        confidence = "Medium" if cached_count else "Low"
    elif directional:
        combined = "Mixed / Event-driven"
        confidence = "Medium" if cached_count else "Low"
    else:
        combined = "Mostly Neutral / Unclear"
        confidence = "Low"

    top_events = sorted(event_counts.items(), key=lambda x: (-x[1], x[0]))[:4]

    return {
        "count": len(articles),
        "cached_count": cached_count,
        "headline_only_count": headline_only_count,
        "impact_counts": impact_counts,
        "importance_counts": importance_counts,
        "event_counts": event_counts,
        "top_events": top_events,
        "combined_signal": combined,
        "confidence": confidence,
        "latest_items": latest_items[:6],
        "high_impact_items": high_impact_items[:4],
    }


def format_dashboard_news_overall_for_prompt(articles: list[dict]) -> str:
    """Format an aggregate news snapshot so the model synthesizes all items, not just one tone label."""
    snapshot = dashboard_news_overall_snapshot(articles)
    if snapshot["count"] == 0:
        return "- No recent stock-specific news context found. Explain that the news signal is unavailable and rely more on technicals."

    impact_counts = snapshot["impact_counts"]
    importance_counts = snapshot["importance_counts"]
    top_events = ", ".join([f"{name} x{count}" for name, count in snapshot["top_events"]]) or "N/A"

    lines = [
        f"- Article count: {snapshot['count']} recent item(s). Cached/translated: {snapshot['cached_count']}. Headline-only: {snapshot['headline_only_count']}.",
        f"- Aggregate news signal: {snapshot['combined_signal']} | Confidence: {snapshot['confidence']}.",
        f"- Impact mix: Bullish {impact_counts.get('Bullish', 0)}, Bearish {impact_counts.get('Bearish', 0)}, Neutral {impact_counts.get('Neutral', 0)}, Mixed {impact_counts.get('Mixed', 0)}, Unclear {impact_counts.get('Unclear', 0)}.",
        f"- Importance mix: High {importance_counts.get('High', 0)}, Medium {importance_counts.get('Medium', 0)}, Low {importance_counts.get('Low', 0)}, N/A {importance_counts.get('N/A', 0)}.",
        f"- Top event types: {top_events}.",
    ]

    if snapshot["high_impact_items"]:
        lines.append("- Highest-priority items to synthesize:")
        for item in snapshot["high_impact_items"][:4]:
            confidence_note = "headline-only" if item.get("headline_only") else "cached summary"
            lines.append(
                f"  [{item['idx']}] {item['title']} | {item['published']} | "
                f"{item['event_type']} | {item['importance']} | {item['impact']} | {confidence_note}"
            )
    else:
        lines.append("- No high-priority directional items were detected; avoid overstating the news signal.")

    return "\n".join(lines)


# -----------------------------------------------------------------------------
# Existing simple dashboard sentiment
# -----------------------------------------------------------------------------


def analyze_news_sentiment(news_items: list) -> dict:
    if not news_items:
        return {
            "label": "No News",
            "score": 0,
            "positive_hits": 0,
            "negative_hits": 0,
            "summary": "No recent news found.",
        }

    text = " ".join([item.get("title", "") for item in news_items]).lower()
    positive_hits = sum(1 for word in POSITIVE_NEWS_WORDS if word in text)
    negative_hits = sum(1 for word in NEGATIVE_NEWS_WORDS if word in text)
    score = positive_hits - negative_hits

    if positive_hits > 0 and negative_hits > 0:
        label = "Mixed"
    elif score >= 2:
        label = "Positive"
    elif score <= -2:
        label = "Negative"
    elif score == 1:
        label = "Slightly Positive"
    elif score == -1:
        label = "Slightly Negative"
    else:
        label = "Neutral"

    return {
        "label": label,
        "score": score,
        "positive_hits": positive_hits,
        "negative_hits": negative_hits,
        "summary": f"{label} news tone based on recent headlines.",
    }
