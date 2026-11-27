from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

import pandas as pd

from marketagent.utils import normalize_symbol


class MarketDataProvider(ABC):
    """Unified interface for market data providers.

    Dashboard and portfolio code should call marketagent.market_data, not a specific
    provider directly. This lets us keep yfinance for historical charts while adding
    Alpaca live quotes for current price / alerts / P&L.
    """

    name: str = "base"

    @abstractmethod
    def fetch_history(
        self,
        symbol: str,
        period: str,
        interval: str,
        prepost: bool,
    ) -> pd.DataFrame:
        """Return OHLCV history as a pandas DataFrame."""

    @abstractmethod
    def fetch_latest_quote(self, symbol: str) -> dict[str, Any]:
        """Return latest quote info.

        Expected keys:
        - symbol
        - price: selected display/valuation price
        - price_method: alpaca_last_trade / yfinance_close / alpaca_quote_mid / unavailable
        - bid
        - ask
        - mid
        - last
        - timestamp: timestamp for selected price
        - quote_timestamp
        - trade_timestamp
        - yfinance_price
        - yfinance_timestamp
        - source
        - provider
        - feed
        - status
        - error
        """

    def fetch_latest_quotes(self, symbols: list[str] | tuple[str, ...]) -> dict[str, dict[str, Any]]:
        """Return latest quote info for multiple symbols.

        Providers can override this with a native batch endpoint. The default
        implementation keeps compatibility by calling fetch_latest_quote() one
        symbol at a time.
        """
        result: dict[str, dict[str, Any]] = {}
        normalized_symbols = []

        for symbol in symbols:
            normalized_symbol = normalize_symbol(symbol)
            if normalized_symbol and normalized_symbol not in normalized_symbols:
                normalized_symbols.append(normalized_symbol)

        for symbol in normalized_symbols:
            result[symbol] = self.fetch_latest_quote(symbol)

        return result


    def fetch_option_snapshots(self, contract_symbols: list[str] | tuple[str, ...]) -> dict[str, dict[str, Any]]:
        """Return option snapshots for contract symbols.

        Providers that support options should override this method. Expected keys
        per contract include bid, ask, mid, last, implied_volatility, greeks,
        quote/trade timestamps, feed, status, and error.
        """
        result: dict[str, dict[str, Any]] = {}
        for contract_symbol in contract_symbols or []:
            symbol = normalize_symbol(contract_symbol)
            if not symbol:
                continue
            result[symbol] = {
                "contract_symbol": symbol,
                "bid": None,
                "ask": None,
                "mid": None,
                "last": None,
                "implied_volatility": None,
                "delta": None,
                "gamma": None,
                "theta": None,
                "vega": None,
                "rho": None,
                "quote_timestamp": None,
                "trade_timestamp": None,
                "source": self.name,
                "feed": None,
                "status": "unsupported",
                "error": f"{self.name} does not support option snapshots.",
            }
        return result


    def fetch_option_contracts(self, underlying_symbol: str, **filters) -> list[dict[str, Any]]:
        """Return option contract metadata for an underlying symbol.

        Providers that support options can override this. Expected contract keys
        include symbol, underlying_symbol, expiration_date, type, and strike_price.
        """
        return []

    def fetch_option_chain(self, underlying_symbol: str, **filters) -> dict[str, dict[str, Any]]:
        """Return an option chain snapshot keyed by contract symbol.

        Providers that support options can override this. The default returns an
        empty chain so UI code can gracefully fall back to manual entry.
        """
        return {}


    def fetch_option_bars(
        self,
        contract_symbols: list[str] | tuple[str, ...],
        *,
        timeframe: str = "1Day",
        start: str | None = None,
        end: str | None = None,
        limit: int = 1000,
    ) -> dict[str, dict[str, Any]]:
        """Return option bar volume summaries for contract symbols.

        Providers that support options can override this. Expected keys include
        total_volume, latest_volume, latest_close, bar_count, status, feed, and error.
        """
        result: dict[str, dict[str, Any]] = {}
        for contract_symbol in contract_symbols or []:
            symbol = normalize_symbol(contract_symbol)
            if not symbol:
                continue
            result[symbol] = {
                "contract_symbol": symbol,
                "total_volume": None,
                "latest_volume": None,
                "latest_close": None,
                "bar_count": 0,
                "timeframe": timeframe,
                "start": start,
                "end": end,
                "source": self.name,
                "feed": None,
                "status": "unsupported",
                "error": f"{self.name} does not support option bars.",
            }
        return result

    def fetch_latest_price(self, symbol: str):
        """Return latest available price as float, or None when unavailable."""
        quote = self.fetch_latest_quote(symbol)
        return quote.get("price")

    def health_check(self, test_symbol: str = "AAPL") -> dict[str, Any]:
        """Return provider status for UI diagnostics.

        Providers may override this to avoid fallback behavior and test their native
        connection directly.
        """
        quote = self.fetch_latest_quote(test_symbol)
        status = quote.get("status", "unknown")

        return {
            "provider": self.name,
            "configured": True,
            "status": "ok" if status == "ok" else status,
            "test_symbol": test_symbol,
            "price": quote.get("price"),
            "bid": quote.get("bid"),
            "ask": quote.get("ask"),
            "timestamp": quote.get("timestamp"),
            "source": quote.get("source"),
            "feed": quote.get("feed"),
            "error": quote.get("error"),
        }
