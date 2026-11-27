import uuid

import streamlit as st

from marketagent.config import DEFAULT_POSITION_ALERT_RANGE_PCT
from marketagent.market_data import fetch_latest_price, fetch_latest_quotes
from marketagent.storage import (
    append_portfolio_history,
    append_transaction,
    get_active_portfolio_profile_id,
    get_default_position,
    get_portfolio_profile_name,
    load_transactions,
    save_app_settings,
    save_transactions,
)
from marketagent.utils import normalize_symbol, now_et_string, safe_float, today_et_string


def build_default_alert_levels(cost: float, range_pct: float = DEFAULT_POSITION_ALERT_RANGE_PCT) -> tuple[float, float]:
    """Return default break-above and stop-breakdown levels from average cost."""
    cost = safe_float(cost, 0.0)
    range_pct = safe_float(range_pct, DEFAULT_POSITION_ALERT_RANGE_PCT)

    if cost <= 0:
        return 0.0, 0.0

    pct = max(range_pct, 0.0) / 100
    return round(cost * (1 + pct), 2), round(cost * (1 - pct), 2)


def get_position(symbol: str) -> dict:
    symbol = normalize_symbol(symbol)
    position = st.session_state.positions.get(symbol, get_default_position())
    return {
        "shares": safe_float(position.get("shares"), 0.0),
        "cost": safe_float(position.get("cost"), 0.0),
        "alert_above": safe_float(position.get("alert_above"), 0.0),
        "alert_below": safe_float(position.get("alert_below"), 0.0),
        "pnl_warning_pct": safe_float(position.get("pnl_warning_pct"), 5.0),
    }


def set_position(symbol: str, position: dict):
    symbol = normalize_symbol(symbol)
    if not symbol:
        return
    st.session_state.positions[symbol] = {
        "shares": safe_float(position.get("shares"), 0.0),
        "cost": safe_float(position.get("cost"), 0.0),
        "alert_above": safe_float(position.get("alert_above"), 0.0),
        "alert_below": safe_float(position.get("alert_below"), 0.0),
        "pnl_warning_pct": safe_float(position.get("pnl_warning_pct"), 5.0),
    }


def remove_position(symbol: str):
    symbol = normalize_symbol(symbol)
    if symbol and symbol in st.session_state.positions:
        del st.session_state.positions[symbol]


def get_active_position_symbols(include_alert_only: bool = True) -> list[str]:
    symbols = []
    for symbol, position in st.session_state.positions.items():
        symbol = normalize_symbol(symbol)
        if not symbol:
            continue

        shares = safe_float(position.get("shares"), 0.0)
        cost = safe_float(position.get("cost"), 0.0)
        alert_above = safe_float(position.get("alert_above"), 0.0)
        alert_below = safe_float(position.get("alert_below"), 0.0)

        has_holding = shares > 0 and cost > 0
        has_alert = alert_above > 0 or alert_below > 0

        if has_holding or (include_alert_only and has_alert):
            symbols.append(symbol)

    return sorted(list(dict.fromkeys(symbols)))


def calculate_position_metrics(symbol: str, current_price):
    position = get_position(symbol)
    shares = position["shares"]
    cost = position["cost"]

    result = {
        "shares": shares,
        "cost_price": cost,
        "cost_amount": None,
        "market_value": None,
        "unrealized_pl": None,
        "unrealized_pl_pct": None,
        "alert_above": position["alert_above"],
        "alert_below": position["alert_below"],
        "pnl_warning_pct": position["pnl_warning_pct"],
    }

    if shares > 0 and cost > 0 and current_price is not None:
        cost_amount = shares * cost
        market_value = shares * current_price
        unrealized_pl = market_value - cost_amount
        unrealized_pl_pct = unrealized_pl / cost_amount * 100
        result.update(
            {
                "cost_amount": cost_amount,
                "market_value": market_value,
                "unrealized_pl": unrealized_pl,
                "unrealized_pl_pct": unrealized_pl_pct,
            }
        )

    return result


def apply_transaction_to_position(
    transaction_type: str,
    symbol: str,
    trade_date: str,
    shares: float,
    price: float,
    fees: float,
    note: str,
    add_to_watchlist: bool = True,
) -> tuple:
    symbol = normalize_symbol(symbol)
    transaction_type = transaction_type.strip().title()

    if not symbol:
        return False, "Symbol is required."
    if shares <= 0:
        return False, "Shares must be greater than 0."
    if price <= 0:
        return False, "Price must be greater than 0."
    if fees < 0:
        return False, "Fees cannot be negative."

    if add_to_watchlist and symbol not in st.session_state.watchlist:
        st.session_state.watchlist.append(symbol)
        st.session_state.watchlist = sorted(list(dict.fromkeys(st.session_state.watchlist)))

    position = get_position(symbol)
    old_shares = position["shares"]
    old_cost = position["cost"]

    realized_pl = None
    realized_pl_pct = None
    avg_cost_at_trade = old_cost

    if transaction_type == "Buy":
        old_cost_amount = old_shares * old_cost
        new_cost_amount = shares * price + fees
        new_shares = old_shares + shares
        new_avg_cost = (old_cost_amount + new_cost_amount) / new_shares if new_shares > 0 else 0.0
        position["shares"] = new_shares
        position["cost"] = new_avg_cost

        # New positions should immediately get default alerts, without requiring a separate update.
        # Existing custom alerts are preserved when adding more shares to an already-open position.
        default_above, default_below = build_default_alert_levels(new_avg_cost)
        is_new_position = old_shares <= 0

        if is_new_position:
            position["alert_above"] = default_above
            position["alert_below"] = default_below
        else:
            if position.get("alert_above", 0.0) <= 0:
                position["alert_above"] = default_above
            if position.get("alert_below", 0.0) <= 0:
                position["alert_below"] = default_below

    elif transaction_type == "Sell":
        if old_shares <= 0:
            return False, f"No current shares found for {symbol}."
        if shares > old_shares:
            return False, f"Sell shares cannot exceed current shares. Current shares: {old_shares:,.2f}"
        cost_basis_sold = shares * old_cost
        gross_proceeds = shares * price
        realized_pl = gross_proceeds - cost_basis_sold - fees
        realized_pl_pct = realized_pl / cost_basis_sold * 100 if cost_basis_sold > 0 else None
        new_shares = old_shares - shares
        position["shares"] = max(new_shares, 0.0)
        position["cost"] = 0.0 if position["shares"] <= 0 else old_cost
    else:
        return False, "Transaction type must be Buy or Sell."

    set_position(symbol, position)

    append_transaction(
        {
            "id": str(uuid.uuid4()),
            "created_at_et": now_et_string(),
            "trade_date": trade_date,
            "type": transaction_type,
            "symbol": symbol,
            "shares": shares,
            "price": price,
            "fees": fees,
            "gross_amount": shares * price,
            "avg_cost_at_trade": avg_cost_at_trade,
            "realized_pl": realized_pl,
            "realized_pl_pct": realized_pl_pct,
            "note": note,
        }
    )
    save_app_settings()
    return True, f"{transaction_type} transaction saved and position updated for {symbol}."



def _transaction_sort_key(transaction: dict) -> tuple[str, str, str]:
    """Return a stable chronological sort key for transaction replay."""
    return (
        str(transaction.get("trade_date") or ""),
        str(transaction.get("created_at_et") or ""),
        str(transaction.get("id") or ""),
    )


def _replay_symbol_position(symbol: str, transactions: list[dict]) -> dict:
    """Recalculate one stock position from remaining Buy/Sell transactions.

    This keeps alerts and warning settings from the current position, but rebuilds
    shares and average cost from the transaction history after an edit/delete.
    """
    symbol = normalize_symbol(symbol)
    current_position = get_position(symbol)
    shares_held = 0.0
    average_cost = 0.0

    symbol_transactions = [
        transaction for transaction in transactions or []
        if normalize_symbol(transaction.get("symbol", "")) == symbol
    ]

    for transaction in sorted(symbol_transactions, key=_transaction_sort_key):
        transaction_type = str(transaction.get("type") or "").strip().title()
        shares = safe_float(transaction.get("shares"), 0.0)
        price = safe_float(transaction.get("price"), 0.0)
        fees = safe_float(transaction.get("fees"), 0.0)

        if shares <= 0 or price <= 0:
            continue

        if transaction_type == "Buy":
            old_cost_amount = shares_held * average_cost
            buy_cost_amount = shares * price + max(fees, 0.0)
            new_shares = shares_held + shares
            average_cost = (old_cost_amount + buy_cost_amount) / new_shares if new_shares > 0 else 0.0
            shares_held = new_shares

        elif transaction_type == "Sell":
            sell_shares = min(shares, shares_held)
            shares_held = max(shares_held - sell_shares, 0.0)
            if shares_held <= 0:
                average_cost = 0.0

    rebuilt_position = {
        "shares": shares_held,
        "cost": average_cost if shares_held > 0 else 0.0,
        "alert_above": current_position.get("alert_above", 0.0),
        "alert_below": current_position.get("alert_below", 0.0),
        "pnl_warning_pct": current_position.get("pnl_warning_pct", 5.0),
    }

    return rebuilt_position


def rebuild_position_from_transactions(symbol: str, transactions: list[dict] | None = None):
    """Rebuild a symbol's current holding from transaction history and save settings."""
    symbol = normalize_symbol(symbol)
    if not symbol:
        return

    transactions = transactions if transactions is not None else load_transactions()
    rebuilt_position = _replay_symbol_position(symbol, transactions)

    has_holding = safe_float(rebuilt_position.get("shares"), 0.0) > 0 and safe_float(rebuilt_position.get("cost"), 0.0) > 0
    has_alert = safe_float(rebuilt_position.get("alert_above"), 0.0) > 0 or safe_float(rebuilt_position.get("alert_below"), 0.0) > 0

    if has_holding or has_alert:
        set_position(symbol, rebuilt_position)
    else:
        remove_position(symbol)


def delete_transaction(transaction_id: str | None = None, row_index: int | None = None) -> tuple[bool, str]:
    """Delete one transaction and rebuild the affected symbol's current position.

    Transactions are stored as JSONL, so deleting one entry requires rewriting the
    file. After deletion, the affected symbol is replayed from remaining history
    to keep Holdings, Summary, and Realized P/L consistent.
    """
    transactions = load_transactions()
    if not transactions:
        return False, "No transaction history found."

    delete_index = None
    deleted_transaction = None

    if transaction_id:
        for index, transaction in enumerate(transactions):
            if str(transaction.get("id") or "") == str(transaction_id):
                delete_index = index
                deleted_transaction = transaction
                break

    if delete_index is None and row_index is not None:
        try:
            row_index = int(row_index)
        except Exception:
            row_index = None
        if row_index is not None and 0 <= row_index < len(transactions):
            delete_index = row_index
            deleted_transaction = transactions[row_index]

    if delete_index is None or deleted_transaction is None:
        return False, "Selected transaction was not found."

    affected_symbol = normalize_symbol(deleted_transaction.get("symbol", ""))
    remaining_transactions = [
        transaction for index, transaction in enumerate(transactions)
        if index != delete_index
    ]

    save_transactions(remaining_transactions)

    if affected_symbol:
        rebuild_position_from_transactions(affected_symbol, remaining_transactions)

    save_app_settings()
    label = f"{deleted_transaction.get('trade_date', '')} {deleted_transaction.get('type', '')} {affected_symbol}".strip()
    return True, f"Deleted transaction: {label}. Holdings and Realized P/L were recalculated from remaining history."


def build_realized_pl_rows(force_refresh: bool = False) -> list[dict]:
    """Replay stock transactions and build realized/total P&L rows by symbol.

    The report uses the same average-cost method as the transaction workflow.
    Closed symbols remain in the report even when they no longer appear as
    active holdings, so users can review realized gains/losses after selling.
    """
    transactions = load_transactions()
    if not transactions:
        return []

    states: dict[str, dict] = {}

    for transaction in sorted(transactions, key=_transaction_sort_key):
        symbol = normalize_symbol(transaction.get("symbol", ""))
        transaction_type = str(transaction.get("type") or "").strip().title()
        shares = safe_float(transaction.get("shares"), 0.0)
        price = safe_float(transaction.get("price"), 0.0)
        fees = safe_float(transaction.get("fees"), 0.0)
        trade_date = str(transaction.get("trade_date") or "")

        if not symbol or transaction_type not in {"Buy", "Sell"} or shares <= 0 or price <= 0:
            continue

        state = states.setdefault(
            symbol,
            {
                "symbol": symbol,
                "remaining_shares": 0.0,
                "average_cost": 0.0,
                "total_bought_shares": 0.0,
                "total_sold_shares": 0.0,
                "total_buy_cost": 0.0,
                "total_sell_proceeds": 0.0,
                "total_fees": 0.0,
                "realized_cost_basis": 0.0,
                "realized_pl": 0.0,
                "first_trade_date": trade_date,
                "last_trade_date": trade_date,
                "transactions_count": 0,
                "sell_transactions_count": 0,
            },
        )

        if trade_date:
            if not state.get("first_trade_date") or trade_date < state["first_trade_date"]:
                state["first_trade_date"] = trade_date
            if not state.get("last_trade_date") or trade_date > state["last_trade_date"]:
                state["last_trade_date"] = trade_date

        state["transactions_count"] += 1
        state["total_fees"] += fees

        if transaction_type == "Buy":
            old_shares = state["remaining_shares"]
            old_cost_amount = old_shares * state["average_cost"]
            buy_cost_amount = shares * price + fees
            new_shares = old_shares + shares

            state["remaining_shares"] = new_shares
            state["average_cost"] = (old_cost_amount + buy_cost_amount) / new_shares if new_shares > 0 else 0.0
            state["total_bought_shares"] += shares
            state["total_buy_cost"] += buy_cost_amount

        elif transaction_type == "Sell":
            avg_cost_at_trade = state["average_cost"]
            if avg_cost_at_trade <= 0:
                avg_cost_at_trade = safe_float(transaction.get("avg_cost_at_trade"), 0.0)

            gross_proceeds = shares * price
            cost_basis_sold = shares * avg_cost_at_trade

            recorded_realized = transaction.get("realized_pl")
            realized_pl = None
            try:
                if recorded_realized is not None:
                    realized_pl = float(recorded_realized)
            except Exception:
                realized_pl = None
            if realized_pl is None:
                realized_pl = gross_proceeds - cost_basis_sold - fees

            state["remaining_shares"] = max(state["remaining_shares"] - shares, 0.0)
            if state["remaining_shares"] <= 0:
                state["average_cost"] = 0.0

            state["total_sold_shares"] += shares
            state["total_sell_proceeds"] += gross_proceeds
            state["realized_cost_basis"] += cost_basis_sold
            state["realized_pl"] += realized_pl
            state["sell_transactions_count"] += 1

    open_symbols = [
        symbol
        for symbol, state in states.items()
        if safe_float(state.get("remaining_shares"), 0.0) > 0
    ]
    quote_cache = fetch_latest_quotes(
        tuple(open_symbols),
        force_refresh=force_refresh,
        max_age_seconds=0 if force_refresh else None,
    ) if open_symbols else {}

    rows = []
    for symbol, state in sorted(states.items()):
        remaining_shares = safe_float(state.get("remaining_shares"), 0.0)
        average_cost = safe_float(state.get("average_cost"), 0.0)
        current_price = None
        quote_source = "N/A"
        quote_updated = "N/A"
        market_value = None
        unrealized_pl = 0.0
        unrealized_pl_pct = None

        if remaining_shares > 0:
            current_price = quote_cache.get(symbol, {}).get("price")
            quote_source = quote_cache.get(symbol, {}).get("source", "N/A")
            quote_updated = quote_cache.get(symbol, {}).get("cache_updated_at_et", "N/A")
            if current_price is None:
                current_price = fetch_latest_price(symbol, force_refresh=force_refresh)
            if current_price is not None and average_cost > 0:
                market_value = remaining_shares * current_price
                remaining_cost_basis = remaining_shares * average_cost
                unrealized_pl = market_value - remaining_cost_basis
                unrealized_pl_pct = unrealized_pl / remaining_cost_basis * 100 if remaining_cost_basis > 0 else None

        realized_pl = safe_float(state.get("realized_pl"), 0.0)
        realized_cost_basis = safe_float(state.get("realized_cost_basis"), 0.0)
        realized_pl_pct = realized_pl / realized_cost_basis * 100 if realized_cost_basis > 0 else None
        total_pl = realized_pl + safe_float(unrealized_pl, 0.0)
        total_basis = realized_cost_basis + (remaining_shares * average_cost if remaining_shares > 0 else 0.0)
        total_pl_pct = total_pl / total_basis * 100 if total_basis > 0 else None

        if remaining_shares > 0 and state.get("total_sold_shares", 0.0) > 0:
            status = "Partially Sold"
        elif remaining_shares > 0:
            status = "Open"
        elif state.get("total_sold_shares", 0.0) > 0:
            status = "Closed"
        else:
            status = "No Sale"

        avg_sell_price = (
            state["total_sell_proceeds"] / state["total_sold_shares"]
            if state.get("total_sold_shares", 0.0) > 0
            else None
        )

        rows.append(
            {
                "symbol": symbol,
                "status": status,
                "total_bought_shares": safe_float(state.get("total_bought_shares"), 0.0),
                "total_sold_shares": safe_float(state.get("total_sold_shares"), 0.0),
                "remaining_shares": remaining_shares,
                "average_cost": average_cost if average_cost > 0 else None,
                "avg_sell_price": avg_sell_price,
                "current_price": current_price,
                "market_value": market_value,
                "realized_pl": realized_pl,
                "realized_pl_pct": realized_pl_pct,
                "unrealized_pl": unrealized_pl if remaining_shares > 0 else 0.0,
                "unrealized_pl_pct": unrealized_pl_pct,
                "total_pl": total_pl,
                "total_pl_pct": total_pl_pct,
                "total_fees": safe_float(state.get("total_fees"), 0.0),
                "first_trade_date": state.get("first_trade_date", ""),
                "last_trade_date": state.get("last_trade_date", ""),
                "transactions_count": int(state.get("transactions_count", 0)),
                "sell_transactions_count": int(state.get("sell_transactions_count", 0)),
                "quote_source": quote_source,
                "quote_updated": quote_updated,
            }
        )

    return rows


def build_realized_pl_summary(rows: list[dict]) -> dict:
    """Aggregate realized, unrealized, and total P&L across report rows."""
    realized_pl = sum(safe_float(row.get("realized_pl"), 0.0) for row in rows)
    unrealized_pl = sum(safe_float(row.get("unrealized_pl"), 0.0) for row in rows)
    total_pl = realized_pl + unrealized_pl
    closed_count = sum(1 for row in rows if row.get("status") == "Closed")
    open_count = sum(1 for row in rows if row.get("status") in {"Open", "Partially Sold"})
    sold_symbols_count = sum(1 for row in rows if safe_float(row.get("total_sold_shares"), 0.0) > 0)

    return {
        "realized_pl": realized_pl,
        "unrealized_pl": unrealized_pl,
        "total_pl": total_pl,
        "closed_count": closed_count,
        "open_count": open_count,
        "sold_symbols_count": sold_symbols_count,
        "symbols_count": len(rows),
    }

def build_current_portfolio_snapshot(force_refresh: bool = True) -> dict:
    holdings = []
    total_cost = 0.0
    total_market_value = 0.0
    total_unrealized_pl = 0.0
    active_positions = []

    for symbol, position in st.session_state.positions.items():
        symbol = normalize_symbol(symbol)
        shares = safe_float(position.get("shares"), 0.0)
        cost = safe_float(position.get("cost"), 0.0)

        if shares <= 0 or cost <= 0:
            continue

        active_positions.append({"symbol": symbol, "shares": shares, "cost": cost})

    quote_cache = fetch_latest_quotes(
        tuple(item["symbol"] for item in active_positions),
        force_refresh=force_refresh,
        max_age_seconds=0 if force_refresh else None,
    )

    for item in active_positions:
        symbol = item["symbol"]
        shares = item["shares"]
        cost = item["cost"]

        current_price = quote_cache.get(symbol, {}).get("price")
        if current_price is None:
            current_price = fetch_latest_price(symbol, force_refresh=force_refresh)
        if current_price is None:
            continue

        cost_amount = shares * cost
        market_value = shares * current_price
        unrealized_pl = market_value - cost_amount
        unrealized_pl_pct = unrealized_pl / cost_amount * 100 if cost_amount > 0 else None

        total_cost += cost_amount
        total_market_value += market_value
        total_unrealized_pl += unrealized_pl

        holdings.append(
            {
                "symbol": symbol,
                "shares": shares,
                "average_cost": cost,
                "current_price": current_price,
                "cost_amount": cost_amount,
                "market_value": market_value,
                "unrealized_pl": unrealized_pl,
                "unrealized_pl_pct": unrealized_pl_pct,
            }
        )

    total_unrealized_pl_pct = total_unrealized_pl / total_cost * 100 if total_cost > 0 else None

    return {
        "id": str(uuid.uuid4()),
        "snapshot_time_et": now_et_string(),
        "snapshot_date": today_et_string(),
        "profile_id": get_active_portfolio_profile_id(),
        "profile_name": get_portfolio_profile_name(),
        "source": "manual",
        "total_cost": total_cost,
        "market_value": total_market_value,
        "unrealized_pl": total_unrealized_pl,
        "unrealized_pl_pct": total_unrealized_pl_pct,
        "holdings_count": len(holdings),
        "holdings": holdings,
    }


def save_portfolio_snapshot(source: str = "manual") -> tuple:
    snapshot = build_current_portfolio_snapshot(force_refresh=True)
    snapshot["source"] = source
    if snapshot["holdings_count"] <= 0:
        return False, "No active holdings to snapshot."
    append_portfolio_history(snapshot)
    return True, "Portfolio snapshot saved."


def auto_save_daily_snapshot():
    current_date = today_et_string()
    last_date = st.session_state.get("last_auto_snapshot_date", "")
    if current_date == last_date:
        return

    snapshot = build_current_portfolio_snapshot(force_refresh=True)
    if snapshot["holdings_count"] <= 0:
        return

    snapshot["source"] = "auto_daily"
    append_portfolio_history(snapshot)
    st.session_state.last_auto_snapshot_date = current_date
    save_app_settings()
