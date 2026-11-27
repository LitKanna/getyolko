import pandas as pd

from marketagent.utils import nullable_float


def calculate_rsi(close: pd.Series, period: int = 14) -> pd.Series:
    close = close.astype(float)
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)

    avg_gain = gain.ewm(alpha=1 / period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False).mean()
    rs = avg_gain / avg_loss.mask(avg_loss == 0)
    return 100 - (100 / (1 + rs))


def add_technical_indicators(data: pd.DataFrame) -> pd.DataFrame:
    if data is None or data.empty or "Close" not in data.columns:
        return pd.DataFrame()

    data = data.copy().dropna(subset=["Close"])
    data["EMA20"] = data["Close"].ewm(span=20, adjust=False).mean()
    data["EMA50"] = data["Close"].ewm(span=50, adjust=False).mean()
    data["RSI"] = calculate_rsi(data["Close"], period=14)
    return data


def get_latest_snapshot(data: pd.DataFrame) -> dict:
    if data is None or data.empty:
        return {
            "open": None,
            "close": None,
            "ema20": None,
            "ema50": None,
            "rsi": None,
            "time": None,
        }

    latest = data.iloc[-1]
    try:
        latest_time = data.index[-1].strftime("%Y-%m-%d %H:%M ET")
    except Exception:
        latest_time = None

    return {
        "open": nullable_float(latest.get("Open")),
        "close": nullable_float(latest.get("Close")),
        "ema20": nullable_float(latest.get("EMA20")),
        "ema50": nullable_float(latest.get("EMA50")),
        "rsi": nullable_float(latest.get("RSI")),
        "time": latest_time,
    }


def classify_trend(price, ema20, ema50) -> str:
    if price is None or ema20 is None or ema50 is None:
        return "Unknown"
    if price > ema20 and price > ema50 and ema20 >= ema50:
        return "Bullish"
    if price < ema20 and price < ema50 and ema20 <= ema50:
        return "Bearish"
    if price > ema20 and price > ema50:
        return "Positive"
    if price < ema20 and price < ema50:
        return "Weak"
    return "Mixed"


def classify_rsi(rsi) -> str:
    if rsi is None:
        return "Unknown"
    if rsi >= 75:
        return "Very High"
    if rsi >= 70:
        return "Overbought"
    if rsi >= 60:
        return "Strong"
    if rsi >= 45:
        return "Neutral"
    if rsi >= 35:
        return "Weak"
    return "Oversold"
