import os
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

# ------------------------------------------------------------
# Project paths
# ------------------------------------------------------------
# config.py lives in: <project_root>/marketagent/config.py
# parents[1] points to <project_root>, where app.py and .env should live.
# When frozen with PyInstaller, config.py is extracted into a temp folder, so the
# project root becomes the folder that contains the executable. Users can then put
# a .env file next to MarketAgentPro.exe and it will actually be loaded.
if getattr(sys, "frozen", False):
    PROJECT_ROOT = Path(sys.executable).resolve().parent
else:
    PROJECT_ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = PROJECT_ROOT / ".env"

# Load .env explicitly from the project root.
# override=True makes the local .env file win if Windows or PowerShell already has
# MARKET_DATA_PROVIDER set to another value.
ENV_FILE_LOADED = False
try:
    from dotenv import load_dotenv

    ENV_FILE_LOADED = load_dotenv(dotenv_path=ENV_FILE, override=True)
except Exception:
    ENV_FILE_LOADED = False

MARKET_TZ = ZoneInfo("America/New_York")

DATA_DIR = Path("data")
SETTINGS_FILE = DATA_DIR / "marketagentpro_settings.json"
PORTFOLIO_HISTORY_FILE = DATA_DIR / "portfolio_history.jsonl"
TRANSACTIONS_FILE = DATA_DIR / "transactions.jsonl"
OPTIONS_STRATEGIES_FILE = DATA_DIR / "options_strategies.json"
NEWS_HISTORY_FILE = DATA_DIR / "news_history.json"
PORTFOLIOS_DIR = DATA_DIR / "portfolios"
PORTFOLIO_PROFILES_FILE = DATA_DIR / "portfolio_profiles.json"
DEFAULT_PORTFOLIO_PROFILE_ID = "default"
DEFAULT_PORTFOLIO_PROFILE_NAME = "Default Portfolio"

# ------------------------------------------------------------
# Data provider settings
# ------------------------------------------------------------
# Current supported values:
# - yfinance: stable for historical charts and fallback quote polling
# - alpaca: uses Alpaca latest quote for current price, P/L, and alerts;
#           historical chart candles still use yfinance in this version.
MARKET_DATA_PROVIDER = os.getenv("MARKET_DATA_PROVIDER", "yfinance").strip().lower()

# Alpaca settings. For free/basic setups, ALPACA_DATA_FEED="iex" is usually the safest starting point.
ALPACA_API_KEY = os.getenv("ALPACA_API_KEY", "").strip()
ALPACA_SECRET_KEY = os.getenv("ALPACA_SECRET_KEY", "").strip()
ALPACA_DATA_FEED = os.getenv("ALPACA_DATA_FEED", "iex").strip().lower()

# Alpaca current price selection. During pre/after-hours, latest trade can lag
# while bid/ask quotes keep moving. When the quote is newer and the spread is
# reasonable, the dashboard can use quote mid as the current display price.
ALPACA_USE_QUOTE_MID_WHEN_NEWER = os.getenv("ALPACA_USE_QUOTE_MID_WHEN_NEWER", "true").strip().lower() not in {"0", "false", "no", "off"}
ALPACA_QUOTE_NEWER_THAN_TRADE_SECONDS = int(os.getenv("ALPACA_QUOTE_NEWER_THAN_TRADE_SECONDS", "30"))
ALPACA_MAX_QUOTE_SPREAD_PCT = float(os.getenv("ALPACA_MAX_QUOTE_SPREAD_PCT", "2.0"))

# Dashboard-only extended-hours fallback. Today/2 Days charts use yfinance
# pre/post-market candles. If Alpaca last trade is stale during extended hours,
# the Dashboard can show the latest chart close so Current Price matches the
# visible chart without changing Portfolio/Options/global quote logic.
DASHBOARD_USE_CHART_CLOSE_EXTENDED_HOURS_FALLBACK = os.getenv(
    "DASHBOARD_USE_CHART_CLOSE_EXTENDED_HOURS_FALLBACK", "true"
).strip().lower() not in {"0", "false", "no", "off"}
DASHBOARD_CHART_CLOSE_NEWER_THAN_QUOTE_SECONDS = int(os.getenv("DASHBOARD_CHART_CLOSE_NEWER_THAN_QUOTE_SECONDS", "120"))
DASHBOARD_CHART_CLOSE_MIN_DIFF_PCT = float(os.getenv("DASHBOARD_CHART_CLOSE_MIN_DIFF_PCT", "0.05"))

# Options market data feed. For Basic/free Alpaca accounts, indicative is the safer default.
# opra requires a paid OPRA market data subscription.
ALPACA_OPTIONS_FEED = os.getenv("ALPACA_OPTIONS_FEED", "indicative").strip().lower()

# Latest quote cache / refresh layer. Historical chart data uses its own cache.
LATEST_QUOTE_CACHE_SECONDS = int(os.getenv("LATEST_QUOTE_CACHE_SECONDS", "5"))
OPTION_SNAPSHOT_CACHE_SECONDS = int(os.getenv("OPTION_SNAPSHOT_CACHE_SECONDS", "30"))
OPTION_BARS_CACHE_SECONDS = int(os.getenv("OPTION_BARS_CACHE_SECONDS", "300"))
TODAY_PAGE_REFRESH_SECONDS = int(os.getenv("TODAY_PAGE_REFRESH_SECONDS", "5"))

# Default alert range for newly created positions. Example: 10 means
# Break Above = Avg Cost x 1.10 and Stop Breakdown = Avg Cost x 0.90.
DEFAULT_POSITION_ALERT_RANGE_PCT = float(os.getenv("DEFAULT_POSITION_ALERT_RANGE_PCT", "10"))
DEFAULT_TRANSACTION_FEE = float(os.getenv("DEFAULT_TRANSACTION_FEE", "6.95"))
DEFAULT_OPTIONS_PROFIT_TARGET_PCT = float(os.getenv("DEFAULT_OPTIONS_PROFIT_TARGET_PCT", "60"))

# AI provider settings.
# - If a .env file exists, its values are the defaults: AI_PROVIDER=ollama uses
#   the local Ollama model; AI_PROVIDER=openai / anthropic uses cloud keys from
#   .env or from the app's AI Settings panel (BYOK).
# - Without a .env, users can enter their own OpenAI (GPT) or Anthropic (Claude)
#   API keys directly in the sidebar AI Settings panel.
# Saved settings in data/marketagentpro_settings.json take priority over these
# defaults once the user saves them from the UI.
DEFAULT_AI_PROVIDER = os.getenv("AI_PROVIDER", "ollama").strip().lower()
if DEFAULT_AI_PROVIDER not in {"off", "ollama", "openai", "anthropic"}:
    DEFAULT_AI_PROVIDER = "off"
DEFAULT_AI_LANGUAGE_MODE = os.getenv("AI_LANGUAGE_MODE", "english_only").strip().lower()
if DEFAULT_AI_LANGUAGE_MODE not in {"english_only", "chinese", "bilingual"}:
    DEFAULT_AI_LANGUAGE_MODE = "english_only"

# Ollama / local AI settings. These are defaults only; the sidebar AI Settings
# panel can override them and save the selection into data/marketagentpro_settings.json.
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434").strip().rstrip("/")
DEFAULT_OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen2.5:14b").strip()
DEFAULT_OLLAMA_NUM_CTX = int(os.getenv("OLLAMA_NUM_CTX", "16384"))
DEFAULT_OLLAMA_TEMPERATURE = float(os.getenv("OLLAMA_TEMPERATURE", "0.3"))

# OpenAI (GPT) BYOK defaults. Values from .env are fallbacks; the AI Settings
# panel can override them and save into data/marketagentpro_settings.json.
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini").strip()
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").strip().rstrip("/")

# Anthropic (Claude) BYOK defaults.
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "").strip()
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-3-5-sonnet-latest").strip()
ANTHROPIC_BASE_URL = os.getenv("ANTHROPIC_BASE_URL", "https://api.anthropic.com/v1").strip().rstrip("/")

# Dashboard AI capability / prompt profile settings. These let publish-ready users
# run the same app with different model sizes: small local models can use Fast,
# qwen2.5:14b can use Balanced, and stronger/cloud models can use Detailed later.
DEFAULT_DASHBOARD_AI_MODE = os.getenv("DASHBOARD_AI_MODE", "balanced").strip().lower()
if DEFAULT_DASHBOARD_AI_MODE not in {"fast", "balanced", "detailed"}:
    DEFAULT_DASHBOARD_AI_MODE = "balanced"

DEFAULT_AI_STREAMING = os.getenv("AI_STREAMING", "auto").strip().lower()
if DEFAULT_AI_STREAMING not in {"auto", "on", "off"}:
    DEFAULT_AI_STREAMING = "auto"

try:
    DEFAULT_DASHBOARD_AI_MAX_NEWS_ITEMS = int(os.getenv("DASHBOARD_AI_MAX_NEWS_ITEMS", "5"))
except Exception:
    DEFAULT_DASHBOARD_AI_MAX_NEWS_ITEMS = 5
if DEFAULT_DASHBOARD_AI_MAX_NEWS_ITEMS not in {3, 5, 8}:
    DEFAULT_DASHBOARD_AI_MAX_NEWS_ITEMS = 5

DEFAULT_DASHBOARD_AI_OUTPUT_LENGTH = os.getenv("DASHBOARD_AI_OUTPUT_LENGTH", "medium").strip().lower()
if DEFAULT_DASHBOARD_AI_OUTPUT_LENGTH not in {"short", "medium", "long"}:
    DEFAULT_DASHBOARD_AI_OUTPUT_LENGTH = "medium"

DEFAULT_WATCHLIST = []

DEFAULT_SETTINGS = {
    "watchlist": [],
    "display_symbols": [],
    "positions": {},
    "last_auto_snapshot_date": "",
    "active_portfolio_profile_id": DEFAULT_PORTFOLIO_PROFILE_ID,
    "ai_settings": {
        "provider": DEFAULT_AI_PROVIDER,
        "language_mode": DEFAULT_AI_LANGUAGE_MODE,
        "ollama_model": DEFAULT_OLLAMA_MODEL,
        "ollama_num_ctx": DEFAULT_OLLAMA_NUM_CTX,
        "ollama_temperature": DEFAULT_OLLAMA_TEMPERATURE,
        "openai_api_key": OPENAI_API_KEY,
        "openai_model": OPENAI_MODEL,
        "openai_base_url": OPENAI_BASE_URL,
        "anthropic_api_key": ANTHROPIC_API_KEY,
        "anthropic_model": ANTHROPIC_MODEL,
        "anthropic_base_url": ANTHROPIC_BASE_URL,
        "dashboard_ai_mode": DEFAULT_DASHBOARD_AI_MODE,
        "ai_streaming": DEFAULT_AI_STREAMING,
        "dashboard_max_news_items": DEFAULT_DASHBOARD_AI_MAX_NEWS_ITEMS,
        "dashboard_output_length": DEFAULT_DASHBOARD_AI_OUTPUT_LENGTH,
    },
}

CHART_VIEW_CONFIG = {
    "2 Days": {
        "period": "10d",
        "interval": "5m",
        "prepost": True,
        "refresh_seconds": 15,
        "live_quote_refresh_seconds": 15,
        "session_label": "Pre + Regular + After",
        "description": "Display a rolling two-trading-day window. Default chart mode is overlay comparison, with split view available.",
    },
    "Today": {
        "period": "1d",
        "interval": "1m",
        "prepost": True,
        "refresh_seconds": 30,
        "live_quote_refresh_seconds": TODAY_PAGE_REFRESH_SECONDS,
        "session_label": "Pre + Regular + After",
        "description": "Today intraday view with pre-market and after-hours.",
    },
    "Month": {
        "period": "1mo",
        "interval": "1d",
        "prepost": False,
        "refresh_seconds": 300,
        "live_quote_refresh_seconds": 300,
        "session_label": "Regular Daily Close Only",
        "description": "Daily close chart. After-hours ignored.",
    },
    "52 Weeks": {
        "period": "1y",
        "interval": "1d",
        "prepost": False,
        "refresh_seconds": 300,
        "live_quote_refresh_seconds": 300,
        "session_label": "Regular Daily Close Only",
        "description": "52-week daily close chart. After-hours ignored.",
    },
}

SIGNAL_CONFIG = {
    "1H": {"period": "3mo", "interval": "60m", "prepost": False},
    "Daily": {"period": "1y", "interval": "1d", "prepost": False},
}

POSITIVE_NEWS_WORDS = [
    "upgrade", "raises", "raised", "beat", "beats", "strong", "growth", "surge",
    "surges", "record", "bullish", "outperform", "buy rating", "demand",
    "ai demand", "partnership", "profit", "profits", "revenue growth",
]

NEGATIVE_NEWS_WORDS = [
    "downgrade", "cuts", "cut", "miss", "misses", "weak", "weakness", "decline",
    "falls", "fall", "drops", "drop", "bearish", "underperform", "sell rating",
    "lawsuit", "probe", "investigation", "warning", "loss", "losses", "guidance cut",
]
