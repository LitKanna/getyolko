from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pandas as pd
import requests

from marketagent.config import (
    ALPACA_API_KEY,
    ALPACA_DATA_FEED,
    ALPACA_MAX_QUOTE_SPREAD_PCT,
    ALPACA_OPTIONS_FEED,
    ALPACA_QUOTE_NEWER_THAN_TRADE_SECONDS,
    ALPACA_SECRET_KEY,
    ALPACA_USE_QUOTE_MID_WHEN_NEWER,
)
from marketagent.providers.base import MarketDataProvider
from marketagent.providers.yfinance_provider import YFinanceProvider
from marketagent.utils import nullable_float, normalize_symbol


class AlpacaProvider(MarketDataProvider):
    """Alpaca provider.

    Current design:
    - Historical chart candles still fall back to yfinance.
    - Latest display price uses this priority:
      1) Alpaca latest trade price
      2) yfinance latest close
      3) Alpaca latest quote bid/ask fallback
    - Batch quote requests are used by the dashboard/portfolio to reduce API calls.
    - If Alpaca is not configured or request fails, fallback to yfinance latest price.
    """

    name = "alpaca"
    base_url = "https://data.alpaca.markets/v2/stocks"
    options_base_url = "https://data.alpaca.markets/v1beta1/options"
    option_contracts_url = "https://paper-api.alpaca.markets/v2/options/contracts"

    def __init__(
        self,
        api_key: str | None = None,
        secret_key: str | None = None,
        data_feed: str | None = None,
        options_feed: str | None = None,
    ):
        """Create an Alpaca provider.

        Values passed by the caller (e.g. keys entered in the app settings
        panel) take priority; environment / .env values remain the fallback.
        """
        self.api_key = (api_key or ALPACA_API_KEY or "").strip()
        self.secret_key = (secret_key or ALPACA_SECRET_KEY or "").strip()
        self.data_feed = (data_feed or ALPACA_DATA_FEED or "iex").strip().lower()
        self.options_feed = (options_feed or ALPACA_OPTIONS_FEED or "indicative").strip().lower()
        self.fallback_provider = YFinanceProvider()

    @property
    def is_configured(self) -> bool:
        return bool(self.api_key and self.secret_key)

    def _headers(self) -> dict[str, str]:
        return {
            "APCA-API-KEY-ID": self.api_key,
            "APCA-API-SECRET-KEY": self.secret_key,
        }

    @staticmethod
    def _is_valid_price(value) -> bool:
        try:
            return value is not None and float(value) > 0
        except Exception:
            return False

    @staticmethod
    def _parse_api_timestamp(value):
        """Parse Alpaca/Yahoo-style timestamps into UTC datetimes when possible."""
        if not value:
            return None

        if isinstance(value, datetime):
            parsed = value
        else:
            text = str(value).strip()
            if not text:
                return None
            try:
                parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
            except Exception:
                return None

        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)

    @staticmethod
    def _seconds_between(later, earlier):
        if later is None or earlier is None:
            return None
        try:
            return (later - earlier).total_seconds()
        except Exception:
            return None

    def _fallback_quote(self, symbol: str, error_message: str | None = None) -> dict[str, Any]:
        quote = self.fallback_provider.fetch_latest_quote(symbol)
        quote["provider"] = self.name
        quote["source"] = "alpaca_fallback_yfinance"
        quote["feed"] = self.data_feed
        quote["price_method"] = "yfinance_close"
        quote["selected_price_source"] = "yfinance"
        quote["yfinance_price"] = quote.get("price")
        quote["yfinance_timestamp"] = quote.get("timestamp")
        quote["yfinance_source"] = quote.get("source")
        quote["quote_timestamp"] = None
        quote["trade_timestamp"] = None

        if error_message:
            quote["status"] = "fallback"
            quote["error"] = error_message
            quote["fallback_reason"] = error_message
        else:
            quote["fallback_reason"] = "Using yfinance latest close."

        return quote

    def _fallback_quotes(self, symbols: list[str], error_message: str | None = None) -> dict[str, dict[str, Any]]:
        return {symbol: self._fallback_quote(symbol, error_message) for symbol in symbols}

    def _get_json(self, endpoint: str, symbols: str | list[str] | tuple[str, ...]) -> dict[str, Any]:
        """Fetch latest quote/trade JSON from Alpaca.

        Alpaca supports comma-separated symbols on latest quote/trade endpoints, so
        the same helper works for single-symbol and batch requests.
        """
        if isinstance(symbols, str):
            symbol_param = normalize_symbol(symbols)
        else:
            symbol_param = ",".join(
                [normalize_symbol(symbol) for symbol in symbols if normalize_symbol(symbol)]
            )

        url = f"{self.base_url}/{endpoint}/latest"
        response = requests.get(
            url,
            headers=self._headers(),
            params={"symbols": symbol_param, "feed": self.data_feed},
            timeout=10,
        )
        response.raise_for_status()
        return response.json()

    @staticmethod
    def _extract_symbol_payload(data: dict[str, Any], root_key: str, symbol: str) -> dict[str, Any]:
        payload = data.get(root_key, {})

        if isinstance(payload, dict):
            return payload.get(symbol) or payload.get(symbol.upper()) or {}

        return {}

    def _build_quote_from_payloads(
        self,
        symbol: str,
        quote: dict[str, Any],
        trade: dict[str, Any],
        source_prefix: str,
    ) -> dict[str, Any]:
        bid = nullable_float(quote.get("bp"))
        ask = nullable_float(quote.get("ap"))
        last = nullable_float(trade.get("p"))
        quote_timestamp = quote.get("t")
        trade_timestamp = trade.get("t")

        mid = None
        if self._is_valid_price(bid) and self._is_valid_price(ask):
            mid = (bid + ask) / 2

        quote_dt = self._parse_api_timestamp(quote_timestamp)
        trade_dt = self._parse_api_timestamp(trade_timestamp)
        quote_minus_trade_seconds = self._seconds_between(quote_dt, trade_dt)

        quote_mid_spread_pct = None
        if self._is_valid_price(bid) and self._is_valid_price(ask) and self._is_valid_price(mid):
            try:
                quote_mid_spread_pct = (ask - bid) / mid * 100
            except Exception:
                quote_mid_spread_pct = None

        quote_spread_ok = (
            self._is_valid_price(mid)
            and quote_mid_spread_pct is not None
            and quote_mid_spread_pct >= 0
            and quote_mid_spread_pct <= ALPACA_MAX_QUOTE_SPREAD_PCT
        )

        quote_is_newer_than_trade = (
            quote_minus_trade_seconds is not None
            and quote_minus_trade_seconds >= ALPACA_QUOTE_NEWER_THAN_TRADE_SECONDS
        )

        use_quote_mid_over_trade = (
            ALPACA_USE_QUOTE_MID_WHEN_NEWER
            and self._is_valid_price(last)
            and quote_spread_ok
            and quote_is_newer_than_trade
        )

        yfinance_quote = None
        yfinance_price = None
        yfinance_timestamp = None
        yfinance_source = None

        price = None
        timestamp = None
        price_method = None
        source = None
        selected_price_source = None
        fallback_reason = None

        if use_quote_mid_over_trade:
            price = mid
            timestamp = quote_timestamp
            price_method = "alpaca_quote_mid_newer_than_trade"
            source = f"{source_prefix}_quote_mid_newer_than_trade"
            selected_price_source = "alpaca_quote"
            fallback_reason = (
                "Using Alpaca bid/ask mid because the latest quote is newer than the latest trade "
                "and the spread is within the configured threshold. This is useful during pre/after-hours."
            )
        elif self._is_valid_price(last):
            price = last
            timestamp = trade_timestamp
            price_method = "alpaca_last_trade"
            source = f"{source_prefix}_latest_trade"
            selected_price_source = "alpaca_trade"
        elif quote_spread_ok:
            price = mid
            timestamp = quote_timestamp
            price_method = "alpaca_quote_mid"
            source = f"{source_prefix}_quote_mid"
            selected_price_source = "alpaca_quote"
            fallback_reason = "Alpaca latest trade was unavailable; using bid/ask mid because the spread is reasonable."
        else:
            # Only ask yfinance after Alpaca trade/quote options are unusable.
            yfinance_quote = self.fallback_provider.fetch_latest_quote(symbol)
            yfinance_price = nullable_float(yfinance_quote.get("price"))
            yfinance_timestamp = yfinance_quote.get("timestamp")
            yfinance_source = yfinance_quote.get("source")

            if self._is_valid_price(yfinance_price):
                price = yfinance_price
                timestamp = yfinance_timestamp
                price_method = "yfinance_close"
                source = f"{source_prefix}_yfinance_close"
                selected_price_source = "yfinance"
                fallback_reason = "Alpaca latest trade/quote were unavailable or quote spread was too wide; using yfinance latest close."
            elif self._is_valid_price(mid):
                price = mid
                timestamp = quote_timestamp
                price_method = "alpaca_quote_mid_wide_spread"
                source = f"{source_prefix}_quote_mid_wide_spread"
                selected_price_source = "alpaca_quote"
                fallback_reason = "Using bid/ask mid as a last Alpaca fallback, but the spread may be wide."
            else:
                price_method = "unavailable"
                source = f"{source_prefix}_unavailable"

        status = "ok" if price is not None else "unavailable"
        error = None if price is not None else "No usable Alpaca trade, yfinance close, or Alpaca quote price."

        return {
            "symbol": symbol,
            "price": price,
            "bid": bid,
            "ask": ask,
            "mid": mid,
            "last": last,
            "quote_mid_spread_pct": quote_mid_spread_pct,
            "quote_minus_trade_seconds": quote_minus_trade_seconds,
            "quote_is_newer_than_trade": quote_is_newer_than_trade,
            "quote_spread_ok": quote_spread_ok,
            "quote_mid_max_spread_pct": ALPACA_MAX_QUOTE_SPREAD_PCT,
            "timestamp": timestamp,
            "quote_timestamp": quote_timestamp,
            "trade_timestamp": trade_timestamp,
            "yfinance_price": yfinance_price,
            "yfinance_timestamp": yfinance_timestamp,
            "yfinance_source": yfinance_source,
            "price_method": price_method,
            "selected_price_source": selected_price_source,
            "source": source,
            "provider": self.name,
            "feed": self.data_feed,
            "status": status,
            "fallback_reason": fallback_reason,
            "error": error,
        }


    def _get_options_json(self, contract_symbols: str | list[str] | tuple[str, ...]) -> dict[str, Any]:
        if isinstance(contract_symbols, str):
            symbol_param = normalize_symbol(contract_symbols)
        else:
            symbol_param = ",".join(
                [normalize_symbol(symbol) for symbol in contract_symbols if normalize_symbol(symbol)]
            )

        url = f"{self.options_base_url}/snapshots"
        response = requests.get(
            url,
            headers=self._headers(),
            params={"symbols": symbol_param, "feed": self.options_feed},
            timeout=10,
        )
        response.raise_for_status()
        return response.json()

    @staticmethod
    def _extract_option_snapshot_payload(data: dict[str, Any], contract_symbol: str) -> dict[str, Any]:
        snapshots = data.get("snapshots", {})
        if not isinstance(snapshots, dict):
            return {}
        return snapshots.get(contract_symbol) or snapshots.get(contract_symbol.upper()) or {}

    def _empty_option_snapshot(self, contract_symbol: str, status: str, error: str | None = None) -> dict[str, Any]:
        contract_symbol = normalize_symbol(contract_symbol)
        return {
            "contract_symbol": contract_symbol,
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
            "source": "alpaca_option_snapshot",
            "provider": self.name,
            "feed": self.options_feed,
            "status": status,
            "error": error,
        }

    def _build_option_snapshot_from_payload(self, contract_symbol: str, payload: dict[str, Any]) -> dict[str, Any]:
        contract_symbol = normalize_symbol(contract_symbol)
        if not isinstance(payload, dict) or not payload:
            return self._empty_option_snapshot(
                contract_symbol,
                status="missing",
                error="No option snapshot returned for this contract symbol.",
            )

        latest_quote = payload.get("latestQuote") or payload.get("latest_quote") or {}
        latest_trade = payload.get("latestTrade") or payload.get("latest_trade") or {}
        greeks = payload.get("greeks") or {}

        bid = nullable_float(latest_quote.get("bp"))
        ask = nullable_float(latest_quote.get("ap"))
        last = nullable_float(latest_trade.get("p"))
        mid = None
        if self._is_valid_price(bid) and self._is_valid_price(ask):
            mid = (bid + ask) / 2

        implied_volatility = nullable_float(
            payload.get("impliedVolatility") if "impliedVolatility" in payload else payload.get("implied_volatility")
        )

        quote_dt = self._parse_api_timestamp(latest_quote.get("t"))
        trade_dt = self._parse_api_timestamp(latest_trade.get("t"))
        quote_minus_trade_seconds = self._seconds_between(quote_dt, trade_dt)

        quote_mid_spread_pct = None
        if self._is_valid_price(bid) and self._is_valid_price(ask) and self._is_valid_price(mid):
            try:
                quote_mid_spread_pct = (ask - bid) / mid * 100
            except Exception:
                quote_mid_spread_pct = None

        quote_spread_ok = (
            self._is_valid_price(mid)
            and quote_mid_spread_pct is not None
            and quote_mid_spread_pct >= 0
            and quote_mid_spread_pct <= ALPACA_MAX_QUOTE_SPREAD_PCT
        )
        quote_is_newer_than_trade = (
            quote_minus_trade_seconds is not None
            and quote_minus_trade_seconds >= ALPACA_QUOTE_NEWER_THAN_TRADE_SECONDS
        )

        usable_price = self._is_valid_price(bid) or self._is_valid_price(ask) or self._is_valid_price(last)

        return {
            "contract_symbol": contract_symbol,
            "bid": bid,
            "ask": ask,
            "mid": mid,
            "last": last,
            "quote_mid_spread_pct": quote_mid_spread_pct,
            "quote_minus_trade_seconds": quote_minus_trade_seconds,
            "quote_is_newer_than_trade": quote_is_newer_than_trade,
            "quote_spread_ok": quote_spread_ok,
            "quote_mid_max_spread_pct": ALPACA_MAX_QUOTE_SPREAD_PCT,
            "bid_size": nullable_float(latest_quote.get("bs")),
            "ask_size": nullable_float(latest_quote.get("as")),
            "last_size": nullable_float(latest_trade.get("s")),
            "implied_volatility": implied_volatility,
            "delta": nullable_float(greeks.get("delta")),
            "gamma": nullable_float(greeks.get("gamma")),
            "theta": nullable_float(greeks.get("theta")),
            "vega": nullable_float(greeks.get("vega")),
            "rho": nullable_float(greeks.get("rho")),
            "quote_timestamp": latest_quote.get("t"),
            "trade_timestamp": latest_trade.get("t"),
            "source": "alpaca_option_snapshot",
            "provider": self.name,
            "feed": self.options_feed,
            "status": "ok" if usable_price else "no_price",
            "error": None if usable_price else "Snapshot returned but no usable bid, ask, or latest trade price was found.",
        }


    # ------------------------------------------------------------
    # Option contracts / chain helpers
    # ------------------------------------------------------------
    @staticmethod
    def _normalize_option_contract(raw_contract: dict[str, Any]) -> dict[str, Any]:
        """Normalize Alpaca option contract metadata into stable internal keys."""
        if not isinstance(raw_contract, dict):
            raw_contract = {}

        contract_symbol = (
            raw_contract.get("symbol")
            or raw_contract.get("contract_symbol")
            or raw_contract.get("id")
            or ""
        )
        option_type = raw_contract.get("type") or raw_contract.get("option_type") or ""
        option_type = str(option_type or "").strip().lower()
        if option_type == "call":
            display_type = "Call"
        elif option_type == "put":
            display_type = "Put"
        else:
            display_type = str(option_type or "").title()

        return {
            "contract_symbol": normalize_symbol(contract_symbol),
            "symbol": normalize_symbol(contract_symbol),
            "underlying_symbol": normalize_symbol(raw_contract.get("underlying_symbol") or raw_contract.get("underlying") or ""),
            "root_symbol": normalize_symbol(raw_contract.get("root_symbol") or ""),
            "expiration_date": raw_contract.get("expiration_date") or raw_contract.get("expiration") or "",
            "option_type": display_type,
            "type": option_type,
            "strike_price": nullable_float(raw_contract.get("strike_price") or raw_contract.get("strike")),
            "status": raw_contract.get("status"),
            "style": raw_contract.get("style"),
            "raw": raw_contract,
        }

    def fetch_option_contracts(self, underlying_symbol: str, **filters) -> list[dict[str, Any]]:
        """Fetch option contract metadata from Alpaca Trading API.

        Useful for expiration dropdowns and manual chain picking. Alpaca's
        contracts endpoint is paginated, so this helper follows page tokens up to
        a small safety cap.
        """
        underlying_symbol = normalize_symbol(underlying_symbol)
        if not underlying_symbol or not self.is_configured:
            return []

        params: dict[str, Any] = {
            "underlying_symbols": underlying_symbol,
            "status": filters.get("status", "active"),
            "limit": int(filters.get("limit", 1000)),
        }

        mapping = {
            "expiration_date": "expiration_date",
            "expiration_date_gte": "expiration_date_gte",
            "expiration_date_lte": "expiration_date_lte",
            "type": "type",
            "strike_price_gte": "strike_price_gte",
            "strike_price_lte": "strike_price_lte",
            "root_symbol": "root_symbol",
        }
        for internal_key, api_key in mapping.items():
            value = filters.get(internal_key)
            if value not in (None, ""):
                params[api_key] = value

        contracts: list[dict[str, Any]] = []
        page_token = filters.get("page_token")
        pages = 0
        max_pages = int(filters.get("max_pages", 5))

        try:
            while True:
                request_params = params.copy()
                if page_token:
                    request_params["page_token"] = page_token

                response = requests.get(
                    self.option_contracts_url,
                    headers=self._headers(),
                    params=request_params,
                    timeout=12,
                )
                response.raise_for_status()
                data = response.json()

                raw_contracts = (
                    data.get("option_contracts")
                    or data.get("contracts")
                    or data.get("data")
                    or []
                )
                for raw_contract in raw_contracts:
                    normalized = self._normalize_option_contract(raw_contract)
                    if normalized.get("contract_symbol"):
                        contracts.append(normalized)

                page_token = data.get("next_page_token") or data.get("next_token")
                pages += 1
                if not page_token or pages >= max_pages:
                    break
        except Exception:
            return contracts

        # Dedupe and sort for stable dropdowns.
        deduped: dict[str, dict[str, Any]] = {}
        for contract in contracts:
            deduped[contract["contract_symbol"]] = contract
        return sorted(
            deduped.values(),
            key=lambda item: (str(item.get("expiration_date") or ""), float(item.get("strike_price") or 0), str(item.get("option_type") or "")),
        )

    def fetch_option_chain(self, underlying_symbol: str, **filters) -> dict[str, dict[str, Any]]:
        """Fetch option chain snapshots from Alpaca market data.

        The option-chain endpoint returns latest quote/trade/greeks by contract.
        This helper supports expiration, type, and strike-range filters.
        """
        underlying_symbol = normalize_symbol(underlying_symbol)
        if not underlying_symbol or not self.is_configured:
            return {}

        params: dict[str, Any] = {
            "feed": filters.get("feed") or self.options_feed,
            "limit": int(filters.get("limit", 1000)),
        }
        mapping = {
            "expiration_date": "expiration_date",
            "expiration_date_gte": "expiration_date_gte",
            "expiration_date_lte": "expiration_date_lte",
            "type": "type",
            "strike_price_gte": "strike_price_gte",
            "strike_price_lte": "strike_price_lte",
            "root_symbol": "root_symbol",
            "updated_since": "updated_since",
        }
        for internal_key, api_key in mapping.items():
            value = filters.get(internal_key)
            if value not in (None, ""):
                params[api_key] = value

        result: dict[str, dict[str, Any]] = {}
        page_token = filters.get("page_token")
        pages = 0
        max_pages = int(filters.get("max_pages", 5))

        try:
            while True:
                request_params = params.copy()
                if page_token:
                    request_params["page_token"] = page_token
                url = f"{self.options_base_url}/snapshots/{underlying_symbol}"
                response = requests.get(
                    url,
                    headers=self._headers(),
                    params=request_params,
                    timeout=15,
                )
                response.raise_for_status()
                data = response.json()
                snapshots = data.get("snapshots", {}) or {}
                if isinstance(snapshots, dict):
                    for contract_symbol, payload in snapshots.items():
                        symbol = normalize_symbol(contract_symbol)
                        if symbol:
                            result[symbol] = self._build_option_snapshot_from_payload(symbol, payload)

                page_token = data.get("next_page_token") or data.get("next_token")
                pages += 1
                if not page_token or pages >= max_pages:
                    break
        except Exception:
            return result

        return result


    def _empty_option_bar_summary(
        self,
        contract_symbol: str,
        *,
        timeframe: str,
        start: str | None,
        end: str | None,
        status: str,
        error: str | None = None,
    ) -> dict[str, Any]:
        contract_symbol = normalize_symbol(contract_symbol)
        return {
            "contract_symbol": contract_symbol,
            "total_volume": None,
            "latest_volume": None,
            "latest_close": None,
            "latest_timestamp": None,
            "bar_count": 0,
            "timeframe": timeframe,
            "start": start,
            "end": end,
            "source": "alpaca_option_bars",
            "provider": self.name,
            "feed": self.options_feed,
            "status": status,
            "error": error,
        }

    @staticmethod
    def _extract_option_bars_payload(data: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
        bars = data.get("bars", {}) if isinstance(data, dict) else {}
        return bars if isinstance(bars, dict) else {}

    def _build_option_bar_summary(
        self,
        contract_symbol: str,
        bars: list[dict[str, Any]],
        *,
        timeframe: str,
        start: str | None,
        end: str | None,
    ) -> dict[str, Any]:
        contract_symbol = normalize_symbol(contract_symbol)
        if not isinstance(bars, list) or not bars:
            return self._empty_option_bar_summary(
                contract_symbol,
                timeframe=timeframe,
                start=start,
                end=end,
                status="no_bars",
                error="No option bars returned for this contract symbol and time range.",
            )

        total_volume = 0.0
        valid_volume_count = 0
        for bar in bars:
            volume = nullable_float(bar.get("v") if isinstance(bar, dict) else None)
            if volume is not None:
                total_volume += volume
                valid_volume_count += 1

        latest_bar = bars[-1] if isinstance(bars[-1], dict) else {}
        latest_volume = nullable_float(latest_bar.get("v"))
        latest_close = nullable_float(latest_bar.get("c"))
        latest_timestamp = latest_bar.get("t")

        return {
            "contract_symbol": contract_symbol,
            "total_volume": total_volume if valid_volume_count else None,
            "latest_volume": latest_volume,
            "latest_close": latest_close,
            "latest_timestamp": latest_timestamp,
            "bar_count": len(bars),
            "timeframe": timeframe,
            "start": start,
            "end": end,
            "source": "alpaca_option_bars",
            "provider": self.name,
            "feed": self.options_feed,
            "status": "ok" if valid_volume_count else "no_volume",
            "error": None if valid_volume_count else "Bars returned but no volume field was available.",
        }

    def fetch_option_bars(
        self,
        contract_symbols: list[str] | tuple[str, ...],
        *,
        timeframe: str = "1Day",
        start: str | None = None,
        end: str | None = None,
        limit: int = 1000,
    ) -> dict[str, dict[str, Any]]:
        """Fetch Alpaca option bars and summarize volume by contract symbol.

        This is meant as a reference tool, not as a main P/L input. For Basic
        options data, indicative feed volume should be treated as an estimate.
        """
        normalized_symbols: list[str] = []
        for symbol in contract_symbols or []:
            normalized_symbol = normalize_symbol(symbol)
            if normalized_symbol and normalized_symbol not in normalized_symbols:
                normalized_symbols.append(normalized_symbol)

        if not normalized_symbols:
            return {}

        timeframe = str(timeframe or "1Day").strip() or "1Day"
        now_utc = datetime.now(timezone.utc)
        if not end:
            end = now_utc.isoformat().replace("+00:00", "Z")
        if not start:
            lookback_days = 7 if timeframe.lower() != "1day" else 2
            start = (now_utc - timedelta(days=lookback_days)).isoformat().replace("+00:00", "Z")

        if not self.is_configured:
            return {
                symbol: self._empty_option_bar_summary(
                    symbol,
                    timeframe=timeframe,
                    start=start,
                    end=end,
                    status="not_configured",
                    error="Alpaca API keys are not configured. Option bars require Alpaca market data credentials.",
                )
                for symbol in normalized_symbols
            }

        result: dict[str, dict[str, Any]] = {}
        remaining_symbols = normalized_symbols[:]

        # Alpaca supports comma-separated option symbols. Keep chunks small so URLs
        # remain comfortable even for long OCC contract symbols.
        chunk_size = 100
        try:
            for start_idx in range(0, len(remaining_symbols), chunk_size):
                chunk = remaining_symbols[start_idx:start_idx + chunk_size]
                params: dict[str, Any] = {
                    "symbols": ",".join(chunk),
                    "timeframe": timeframe,
                    "start": start,
                    "end": end,
                    "feed": self.options_feed,
                    "limit": int(limit or 1000),
                }
                page_token = None
                raw_bars: dict[str, list[dict[str, Any]]] = {symbol: [] for symbol in chunk}
                pages = 0
                while True:
                    request_params = params.copy()
                    if page_token:
                        request_params["page_token"] = page_token
                    response = requests.get(
                        f"{self.options_base_url}/bars",
                        headers=self._headers(),
                        params=request_params,
                        timeout=15,
                    )
                    response.raise_for_status()
                    data = response.json()
                    bars_payload = self._extract_option_bars_payload(data)
                    for symbol in chunk:
                        bars_for_symbol = bars_payload.get(symbol) or bars_payload.get(symbol.upper()) or []
                        if isinstance(bars_for_symbol, list):
                            raw_bars[symbol].extend(bars_for_symbol)

                    page_token = data.get("next_page_token") or data.get("next_token")
                    pages += 1
                    if not page_token or pages >= 5:
                        break

                for symbol in chunk:
                    result[symbol] = self._build_option_bar_summary(
                        symbol,
                        raw_bars.get(symbol, []),
                        timeframe=timeframe,
                        start=start,
                        end=end,
                    )
        except Exception as exc:
            return {
                symbol: self._empty_option_bar_summary(
                    symbol,
                    timeframe=timeframe,
                    start=start,
                    end=end,
                    status="error",
                    error=f"Alpaca option bars request failed: {exc}",
                )
                for symbol in normalized_symbols
            }

        return result

    def fetch_option_snapshots(self, contract_symbols: list[str] | tuple[str, ...]) -> dict[str, dict[str, Any]]:
        normalized_symbols = []
        for symbol in contract_symbols or []:
            normalized_symbol = normalize_symbol(symbol)
            if normalized_symbol and normalized_symbol not in normalized_symbols:
                normalized_symbols.append(normalized_symbol)

        if not normalized_symbols:
            return {}

        if not self.is_configured:
            return {
                symbol: self._empty_option_snapshot(
                    symbol,
                    status="not_configured",
                    error="Alpaca API keys are not configured. Option snapshots require Alpaca market data credentials.",
                )
                for symbol in normalized_symbols
            }

        try:
            data = self._get_options_json(normalized_symbols)
            result: dict[str, dict[str, Any]] = {}
            for symbol in normalized_symbols:
                payload = self._extract_option_snapshot_payload(data, symbol)
                result[symbol] = self._build_option_snapshot_from_payload(symbol, payload)
            return result
        except Exception as exc:
            return {
                symbol: self._empty_option_snapshot(
                    symbol,
                    status="error",
                    error=f"Alpaca option snapshot request failed: {exc}",
                )
                for symbol in normalized_symbols
            }

    def fetch_history(
        self,
        symbol: str,
        period: str,
        interval: str,
        prepost: bool,
    ) -> pd.DataFrame:
        # Historical candles intentionally remain on yfinance for now.
        # Alpaca bars can be added later without changing the UI layer.
        return self.fallback_provider.fetch_history(
            symbol=symbol,
            period=period,
            interval=interval,
            prepost=prepost,
        )

    def fetch_latest_quotes(self, symbols: list[str] | tuple[str, ...]) -> dict[str, dict[str, Any]]:
        normalized_symbols = []
        for symbol in symbols:
            normalized_symbol = normalize_symbol(symbol)
            if normalized_symbol and normalized_symbol not in normalized_symbols:
                normalized_symbols.append(normalized_symbol)

        if not normalized_symbols:
            return {}

        if not self.is_configured:
            return self._fallback_quotes(
                normalized_symbols,
                "Alpaca API keys are not configured. Using yfinance fallback.",
            )

        try:
            quote_data = self._get_json("quotes", normalized_symbols)
            trade_data = self._get_json("trades", normalized_symbols)

            result: dict[str, dict[str, Any]] = {}

            for symbol in normalized_symbols:
                quote = self._extract_symbol_payload(quote_data, "quotes", symbol)
                trade = self._extract_symbol_payload(trade_data, "trades", symbol)
                built_quote = self._build_quote_from_payloads(
                    symbol=symbol,
                    quote=quote,
                    trade=trade,
                    source_prefix="alpaca_batch",
                )

                if built_quote.get("price") is None:
                    built_quote = self._fallback_quote(
                        symbol,
                        "Alpaca batch quote/trade returned no usable price. Using yfinance fallback.",
                    )

                result[symbol] = built_quote

            return result

        except Exception as exc:
            return self._fallback_quotes(
                normalized_symbols,
                f"Alpaca batch request failed: {exc}",
            )

    def fetch_latest_quote(self, symbol: str) -> dict[str, Any]:
        symbol = normalize_symbol(symbol)

        if not symbol:
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
                "price_method": "unavailable",
                "source": "alpaca",
                "provider": self.name,
                "feed": self.data_feed,
                "status": "unavailable",
                "error": "Missing symbol.",
            }

        quotes = self.fetch_latest_quotes([symbol])
        return quotes.get(symbol) or self._fallback_quote(symbol, "No quote returned for symbol.")

    def health_check(self, test_symbol: str = "AAPL") -> dict[str, Any]:
        """Check Alpaca native quote/trade connection without hiding errors.

        fetch_latest_quote() intentionally falls back to yfinance so the app keeps
        working. This health check reports the real Alpaca status for the sidebar.
        """
        symbol = normalize_symbol(test_symbol)

        if not symbol:
            symbol = "AAPL"

        if not self.is_configured:
            return {
                "provider": self.name,
                "configured": False,
                "status": "not_configured",
                "test_symbol": symbol,
                "price": None,
                "bid": None,
                "ask": None,
                "timestamp": None,
                "source": "alpaca",
                "feed": self.data_feed,
                "price_method": "unavailable",
                "error": "ALPACA_API_KEY or ALPACA_SECRET_KEY is missing in .env.",
            }

        try:
            quote_data = self._get_json("quotes", symbol)
            trade_data = self._get_json("trades", symbol)

            quote = self._extract_symbol_payload(quote_data, "quotes", symbol)
            trade = self._extract_symbol_payload(trade_data, "trades", symbol)
            built_quote = self._build_quote_from_payloads(
                symbol=symbol,
                quote=quote,
                trade=trade,
                source_prefix="alpaca_native_health_check",
            )

            return {
                "provider": self.name,
                "configured": True,
                "status": "ok" if built_quote.get("price") is not None else "no_price",
                "test_symbol": symbol,
                "price": built_quote.get("price"),
                "bid": built_quote.get("bid"),
                "ask": built_quote.get("ask"),
                "timestamp": built_quote.get("timestamp"),
                "source": built_quote.get("source"),
                "feed": self.data_feed,
                "price_method": built_quote.get("price_method"),
                "error": None if built_quote.get("price") is not None else "Alpaca returned no usable trade/quote price.",
            }

        except Exception as exc:
            return {
                "provider": self.name,
                "configured": True,
                "status": "error",
                "test_symbol": symbol,
                "price": None,
                "bid": None,
                "ask": None,
                "timestamp": None,
                "source": "alpaca_native_health_check",
                "feed": self.data_feed,
                "price_method": "unavailable",
                "error": str(exc),
            }
