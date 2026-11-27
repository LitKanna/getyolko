from __future__ import annotations

from typing import Any

import pandas as pd
import yfinance as yf

from marketagent.config import MARKET_TZ
from marketagent.providers.base import MarketDataProvider
from marketagent.utils import nullable_float, normalize_symbol


class YFinanceProvider(MarketDataProvider):
    name = "yfinance"

    @staticmethod
    def _convert_index_to_market_tz(data: pd.DataFrame) -> pd.DataFrame:
        if data is None or data.empty:
            return data

        data = data.copy()

        try:
            if isinstance(data.index, pd.DatetimeIndex):
                if data.index.tz is None:
                    data.index = data.index.tz_localize(MARKET_TZ)
                else:
                    data.index = data.index.tz_convert(MARKET_TZ)
        except Exception:
            pass

        return data

    def fetch_history(
        self,
        symbol: str,
        period: str,
        interval: str,
        prepost: bool,
    ) -> pd.DataFrame:
        try:
            data = yf.Ticker(symbol).history(
                period=period,
                interval=interval,
                prepost=prepost,
                auto_adjust=False,
            )

            if data is None or data.empty:
                return pd.DataFrame()

            data = self._convert_index_to_market_tz(data)

            if "Close" not in data.columns:
                return pd.DataFrame()

            return data.dropna(subset=["Close"])

        except Exception:
            return pd.DataFrame()

    def fetch_latest_quote(self, symbol: str) -> dict[str, Any]:
        symbol = normalize_symbol(symbol)

        data = self.fetch_history(
            symbol=symbol,
            period="1d",
            interval="1m",
            prepost=True,
        )

        if data is None or data.empty:
            return {
                "symbol": symbol,
                "price": None,
                "bid": None,
                "ask": None,
                "mid": None,
                "last": None,
                "timestamp": None,
                "quote_timestamp": None,
                "trade_timestamp": None,
                "yfinance_price": None,
                "yfinance_timestamp": None,
                "yfinance_source": "yfinance_1m_history",
                "price_method": "unavailable",
                "selected_price_source": None,
                "source": "yfinance_1m_history",
                "provider": self.name,
                "feed": None,
                "status": "unavailable",
                "error": "No yfinance latest 1m data available.",
            }

        price = nullable_float(data["Close"].iloc[-1])

        timestamp = None
        try:
            timestamp = data.index[-1].strftime("%Y-%m-%d %H:%M:%S ET")
        except Exception:
            timestamp = None

        return {
            "symbol": symbol,
            "price": price,
            "bid": None,
            "ask": None,
            "mid": price,
            "last": price,
            "timestamp": timestamp,
            "quote_timestamp": None,
            "trade_timestamp": timestamp,
            "yfinance_price": price,
            "yfinance_timestamp": timestamp,
            "yfinance_source": "yfinance_1m_history",
            "price_method": "yfinance_close",
            "selected_price_source": "yfinance",
            "source": "yfinance_1m_history",
            "provider": self.name,
            "feed": None,
            "status": "ok" if price is not None else "unavailable",
            "error": None,
        }


    def health_check(self, test_symbol: str = "AAPL") -> dict[str, Any]:
        quote = self.fetch_latest_quote(test_symbol)

        return {
            "provider": self.name,
            "configured": True,
            "status": quote.get("status", "unknown"),
            "test_symbol": normalize_symbol(test_symbol),
            "price": quote.get("price"),
            "bid": quote.get("bid"),
            "ask": quote.get("ask"),
            "timestamp": quote.get("timestamp"),
            "source": quote.get("source"),
            "feed": quote.get("feed"),
            "price_method": quote.get("price_method"),
            "error": quote.get("error"),
        }
