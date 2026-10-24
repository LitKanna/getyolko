from marketagent.utils import format_pct, format_price


def evaluate_custom_alerts(current_price, risk_analysis: dict, alert_above: float, alert_below: float, pnl_warning_pct: float) -> dict:
    triggered = []
    watching = []
    unrealized_pl_pct = risk_analysis.get("position", {}).get("unrealized_pl_pct")

    if current_price is None:
        return {"triggered": ["Current price unavailable. Alerts cannot be evaluated."], "watching": []}

    if alert_above and alert_above > 0:
        if current_price >= alert_above:
            triggered.append(f"Breakout alert triggered: price is at or above {format_price(alert_above)}.")
        else:
            watching.append(f"Watching breakout above {format_price(alert_above)}.")

    if alert_below and alert_below > 0:
        if current_price <= alert_below:
            triggered.append(f"Breakdown / stop alert triggered: price is at or below {format_price(alert_below)}.")
        else:
            watching.append(f"Watching risk below {format_price(alert_below)}.")

    if pnl_warning_pct and pnl_warning_pct > 0 and unrealized_pl_pct is not None:
        if unrealized_pl_pct <= -abs(pnl_warning_pct):
            triggered.append(f"P/L warning triggered: unrealized P/L is {format_pct(unrealized_pl_pct)}.")
        else:
            watching.append(f"Watching P/L warning at -{pnl_warning_pct:.2f}%.")

    if risk_analysis.get("risk_level") in ["High", "Extreme"]:
        triggered.append(f"Risk engine warning: risk level is {risk_analysis.get('risk_level')}.")

    if not triggered and not watching:
        watching.append("No custom alert configured yet.")

    return {"triggered": triggered, "watching": watching}
