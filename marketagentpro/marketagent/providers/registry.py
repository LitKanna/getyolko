from __future__ import annotations

from functools import lru_cache

from marketagent.providers.alpaca_provider import AlpacaProvider
from marketagent.providers.base import MarketDataProvider
from marketagent.providers.yfinance_provider import YFinanceProvider
from marketagent.storage import load_app_settings, sanitize_api_settings


def _effective_api_settings() -> dict:
    """Return runtime API settings: current Streamlit session first, then saved file.

    When neither is available (e.g. import-time / headless calls),
    sanitize_api_settings falls back to environment variables / .env defaults.
    """
    try:
        import streamlit as st

        if "api_settings" in st.session_state:
            return sanitize_api_settings(st.session_state.api_settings)
    except Exception:
        pass

    return sanitize_api_settings(load_app_settings().get("api_settings", {}))


def _effective_provider_name() -> str:
    provider_name = _effective_api_settings().get("market_data_provider") or "yfinance"
    return (provider_name or "yfinance").strip().lower()


@lru_cache(maxsize=1)
def get_market_data_provider() -> MarketDataProvider:
    provider_name = _effective_provider_name()

    if provider_name == "alpaca":
        settings = _effective_api_settings()
        return AlpacaProvider(
            api_key=settings.get("alpaca_api_key"),
            secret_key=settings.get("alpaca_secret_key"),
            data_feed=settings.get("alpaca_data_feed"),
            options_feed=settings.get("alpaca_options_feed"),
        )

    return YFinanceProvider()


def reset_market_data_provider() -> None:
    """Drop the cached provider so the next fetch uses the current API settings."""
    get_market_data_provider.cache_clear()


def get_market_data_provider_name() -> str:
    return get_market_data_provider().name



def get_market_data_provider_health(test_symbol: str = "AAPL") -> dict:
    provider = get_market_data_provider()
    return provider.health_check(test_symbol=test_symbol)
