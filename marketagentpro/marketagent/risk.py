import pandas as pd

from marketagent.utils import distance_pct, nullable_float


def build_chart_levels(chart_data: pd.DataFrame, chart_style: str | None = "Line") -> dict:
    """Build displayed chart levels from the same data style shown in the chart.

    Line mode uses Close high/low. Candlestick mode uses OHLC High/Low wick values.
    """
    if chart_data is None or chart_data.empty:
        return {"range_high": None, "range_low": None}

    style = (chart_style or "Line").strip().lower()

    if style == "candlestick" and {"High", "Low"}.issubset(set(chart_data.columns)):
        high = pd.to_numeric(chart_data["High"], errors="coerce").dropna()
        low = pd.to_numeric(chart_data["Low"], errors="coerce").dropna()
        if not high.empty and not low.empty:
            return {
                "range_high": nullable_float(high.max()),
                "range_low": nullable_float(low.min()),
            }

    if "Close" not in chart_data.columns:
        return {"range_high": None, "range_low": None}

    close = pd.to_numeric(chart_data["Close"], errors="coerce").dropna()
    if close.empty:
        return {"range_high": None, "range_low": None}

    return {
        "range_high": nullable_float(close.max()),
        "range_low": nullable_float(close.min()),
    }


def evaluate_risk(current_price, signal_data: dict, news_sentiment: dict, chart_levels: dict, shares=0.0, cost_price=0.0) -> dict:
    risk_points = 0.0
    reasons = []
    watch_items = []

    hourly = signal_data.get("1H", {}).get("snapshot", {})
    daily = signal_data.get("Daily", {}).get("snapshot", {})

    h_ema20 = hourly.get("ema20")
    h_ema50 = hourly.get("ema50")
    h_rsi = hourly.get("rsi")
    d_ema20 = daily.get("ema20")
    d_ema50 = daily.get("ema50")
    d_rsi = daily.get("rsi")
    price_for_signal = current_price or hourly.get("close") or daily.get("close")

    def add_risk(points, reason):
        nonlocal risk_points
        risk_points += points
        reasons.append(reason)

    if price_for_signal is not None and h_ema20 is not None:
        if price_for_signal < h_ema20:
            add_risk(1.0, "Current price is below 1H EMA20.")
        else:
            watch_items.append("Price is holding above 1H EMA20.")

    if price_for_signal is not None and h_ema50 is not None:
        if price_for_signal < h_ema50:
            add_risk(1.5, "Current price is below 1H EMA50.")
        else:
            watch_items.append("Price is holding above 1H EMA50.")

    if h_ema20 is not None and h_ema50 is not None:
        if h_ema20 < h_ema50:
            add_risk(1.0, "1H EMA20 is below 1H EMA50.")
        else:
            watch_items.append("1H EMA20 remains above 1H EMA50.")

    if h_rsi is not None:
        if h_rsi >= 75:
            add_risk(1.5, "1H RSI is very high; short-term pullback risk is elevated.")
        elif h_rsi >= 70:
            add_risk(1.0, "1H RSI is overbought.")
        elif h_rsi <= 35:
            add_risk(1.0, "1H RSI is weak or oversold.")

    if price_for_signal is not None and d_ema20 is not None:
        if price_for_signal < d_ema20:
            add_risk(2.0, "Current price is below Daily EMA20.")
        else:
            watch_items.append("Price is above Daily EMA20.")

    if d_ema20 is not None and d_ema50 is not None:
        if d_ema20 < d_ema50:
            add_risk(2.0, "Daily EMA20 is below Daily EMA50.")
        else:
            watch_items.append("Daily EMA20 is above Daily EMA50.")

    if d_rsi is not None:
        if d_rsi >= 75:
            add_risk(1.0, "Daily RSI is very high.")
        elif d_rsi <= 35:
            add_risk(1.5, "Daily RSI is weak.")

    news_label = news_sentiment.get("label", "Neutral")
    if news_label in ["Negative", "Slightly Negative"]:
        add_risk(1.0, f"Recent news tone is {news_label}.")
    elif news_label == "Mixed":
        add_risk(0.5, "Recent news tone is mixed.")
    elif news_label in ["Positive", "Slightly Positive"]:
        watch_items.append("Recent news tone is supportive.")

    range_high = chart_levels.get("range_high")
    range_low = chart_levels.get("range_low")

    if current_price is not None and range_low is not None:
        low_distance = distance_pct(current_price, range_low)
        if low_distance is not None and low_distance <= 1.0:
            add_risk(1.0, "Current price is close to the displayed chart low.")

    if current_price is not None and range_high is not None:
        high_distance = distance_pct(current_price, range_high)
        if high_distance is not None and high_distance >= -1.0:
            watch_items.append("Current price is close to the displayed chart high.")

    position = {
        "shares": shares,
        "cost_price": cost_price,
        "cost_amount": None,
        "market_value": None,
        "unrealized_pl": None,
        "unrealized_pl_pct": None,
    }

    if shares > 0 and cost_price > 0 and current_price is not None:
        cost_amount = shares * cost_price
        market_value = shares * current_price
        unrealized_pl = market_value - cost_amount
        unrealized_pl_pct = unrealized_pl / cost_amount * 100
        position.update(
            {
                "cost_amount": cost_amount,
                "market_value": market_value,
                "unrealized_pl": unrealized_pl,
                "unrealized_pl_pct": unrealized_pl_pct,
            }
        )

        if unrealized_pl_pct <= -5:
            add_risk(2.0, "Position is down more than 5%.")
        elif unrealized_pl_pct <= -2:
            add_risk(1.0, "Position is down more than 2%.")
        elif unrealized_pl_pct >= 10 and h_rsi is not None and h_rsi >= 70:
            add_risk(1.0, "Position has strong profit while 1H RSI is high; pullback risk should be watched.")
        elif unrealized_pl_pct > 0:
            watch_items.append("Position is currently profitable.")

    if risk_points <= 1.5:
        risk_level = "Low"
    elif risk_points <= 3.5:
        risk_level = "Medium"
    elif risk_points <= 5.5:
        risk_level = "High"
    else:
        risk_level = "Extreme"

    if not reasons:
        reasons.append("No major risk signal detected from current technical and news inputs.")
    if not watch_items:
        watch_items.append("No specific watch item detected yet.")

    return {
        "risk_points": risk_points,
        "risk_level": risk_level,
        "reasons": reasons,
        "watch_items": watch_items,
        "position": position,
    }
