from datetime import date

import pandas as pd
import streamlit as st

try:
    import plotly.graph_objects as go
    HAS_PLOTLY = True
except Exception:
    HAS_PLOTLY = False

from marketagent.config import ALPACA_OPTIONS_FEED, DEFAULT_OPTIONS_PROFIT_TARGET_PCT, DEFAULT_POSITION_ALERT_RANGE_PCT, DEFAULT_TRANSACTION_FEE, DEFAULT_PORTFOLIO_PROFILE_ID
from marketagent.market_data import (
    fetch_latest_price,
    fetch_latest_quotes,
    fetch_option_bars,
    fetch_option_chain,
    fetch_option_contracts,
    fetch_option_expirations,
    get_quote_cache_status,
    refresh_latest_quotes,
    get_option_snapshot_cache_status,
    refresh_option_snapshots,
)
from marketagent.portfolio import (
    apply_transaction_to_position,
    auto_save_daily_snapshot,
    build_default_alert_levels,
    build_realized_pl_rows,
    build_realized_pl_summary,
    delete_transaction,
    get_active_position_symbols,
    get_position,
    remove_position,
    save_portfolio_snapshot,
    set_position,
)
from marketagent.options import (
    BUILDER_OUTLOOKS,
    STRATEGY_TYPES,
    apply_option_snapshots_to_strategy,
    build_option_contract_symbol,
    build_strategy_candidate,
    calculate_strategy_metrics,
    calculate_strategy_display_metrics,
    close_strategy,
    get_strategy_contract_symbols,
    is_strategy_closed,
    remove_strategy,
    reopen_strategy,
    select_open_premium_for_leg,
    strategies_to_dataframe,
    update_strategy_from_option_snapshots,
    update_strategy_leg_premiums,
    upsert_strategy,
)
from marketagent.storage import (
    create_portfolio_profile,
    delete_portfolio_profile,
    ensure_portfolio_profiles,
    get_active_portfolio_profile_id,
    get_portfolio_profile_name,
    list_portfolio_profiles,
    load_portfolio_history,
    load_transactions,
    rename_portfolio_profile,
    save_app_settings,
    save_option_strategies,
    switch_portfolio_profile,
)
from marketagent.utils import (
    format_age,
    format_pct,
    format_price,
    format_volume,
    normalize_symbol,
    safe_float,
)







def render_portfolio_profile_selector():
    """Top-level selector for independent stock/options portfolio profiles."""
    ensure_portfolio_profiles()
    profiles = list_portfolio_profiles()
    if not profiles:
        return

    active_profile_id = get_active_portfolio_profile_id()
    profile_ids = [profile.get("id") for profile in profiles]
    if active_profile_id not in profile_ids:
        active_profile_id = DEFAULT_PORTFOLIO_PROFILE_ID
        switch_portfolio_profile(active_profile_id)
        profile_ids = [profile.get("id") for profile in list_portfolio_profiles()]

    label_by_id = {profile.get("id"): profile.get("name") or profile.get("id") for profile in profiles}

    col_profile, col_hint = st.columns([1.2, 2.2])
    with col_profile:
        selected_profile_id = st.selectbox(
            "Active Portfolio Profile",
            options=profile_ids,
            index=profile_ids.index(active_profile_id) if active_profile_id in profile_ids else 0,
            format_func=lambda profile_id: label_by_id.get(profile_id, profile_id),
            key="active_portfolio_profile_selectbox",
            help="Each profile has its own holdings, stock transactions, realized P/L, snapshot history, and option strategies.",
        )
        if selected_profile_id != get_active_portfolio_profile_id():
            switch_portfolio_profile(selected_profile_id)
            st.rerun()

    with col_hint:
        st.caption(
            f"Current profile: **{get_portfolio_profile_name()}** · "
            "watchlist/news/dashboard settings stay shared; portfolio data is profile-specific."
        )

    with st.expander("Manage Portfolio Profiles", expanded=False):
        st.caption(
            "Use profiles for real portfolio, paper/mock portfolio, or another person's portfolio. "
            "Creating profiles does not affect broker accounts; everything is local under `data/portfolios/`."
        )

        create_col, rename_col, delete_col = st.columns(3)

        with create_col:
            st.markdown("**Create profile**")
            new_profile_name = st.text_input("New profile name", key="new_portfolio_profile_name", placeholder="Mock Portfolio")
            duplicate_active = st.checkbox("Duplicate current profile", key="duplicate_active_portfolio_profile")
            if st.button("Create Profile", key="create_portfolio_profile_button"):
                save_app_settings()
                ok, message, new_profile_id = create_portfolio_profile(new_profile_name, duplicate_from_active=duplicate_active)
                if ok:
                    switch_portfolio_profile(new_profile_id)
                    st.success(message)
                    st.rerun()
                else:
                    st.warning(message)

        with rename_col:
            st.markdown("**Rename current**")
            current_name = get_portfolio_profile_name()
            renamed_profile_name = st.text_input("Profile display name", value=current_name, key=f"rename_portfolio_profile_name_{active_profile_id}")
            if st.button("Rename Profile", key="rename_portfolio_profile_button"):
                ok, message = rename_portfolio_profile(get_active_portfolio_profile_id(), renamed_profile_name)
                if ok:
                    st.success(message)
                    st.rerun()
                else:
                    st.warning(message)

        with delete_col:
            st.markdown("**Delete current**")
            if get_active_portfolio_profile_id() == DEFAULT_PORTFOLIO_PROFILE_ID:
                st.caption("Default Portfolio cannot be deleted.")
            else:
                confirm_delete = st.checkbox("Confirm delete current profile", key="confirm_delete_portfolio_profile")
                if st.button("Delete Profile", key="delete_portfolio_profile_button", disabled=not confirm_delete):
                    ok, message = delete_portfolio_profile(get_active_portfolio_profile_id())
                    if ok:
                        st.success(message)
                        st.rerun()
                    else:
                        st.warning(message)

def set_transaction_shares_to_max(max_shares: float):
    st.session_state.transaction_shares_input = float(max_shares or 0.0)




def format_option_iv(value) -> str:
    if value is None or pd.isna(value):
        return "N/A"
    value = float(value)
    display_value = value * 100 if abs(value) <= 2 else value
    return f"{display_value:.2f}%"


def format_greek(value) -> str:
    if value is None or pd.isna(value):
        return "N/A"
    return f"{float(value):.4f}"


def format_option_risk_value(value) -> str:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return "N/A"
    if isinstance(value, str):
        return value
    return format_price(value)

def get_observed_symbols() -> list[str]:
    """Return symbols the user is currently watching, displaying, or holding."""
    symbols = []

    for source in [
        getattr(st.session_state, "watchlist", []),
        getattr(st.session_state, "display_symbols", []),
        get_active_position_symbols(include_alert_only=True),
    ]:
        for symbol in source:
            normalized = normalize_symbol(symbol)
            if normalized:
                symbols.append(normalized)

    unique_symbols = sorted(list(dict.fromkeys(symbols)))
    return unique_symbols or ["MU"]

def get_current_position_rows(include_alert_only: bool = True) -> list[dict]:
    rows = []

    for symbol, position in st.session_state.positions.items():
        symbol = normalize_symbol(symbol)
        if not symbol:
            continue

        shares = safe_float(position.get("shares"), 0.0)
        cost = safe_float(position.get("cost"), 0.0)
        alert_above = safe_float(position.get("alert_above"), 0.0)
        alert_below = safe_float(position.get("alert_below"), 0.0)
        pnl_warning_pct = safe_float(position.get("pnl_warning_pct"), 5.0)

        has_holding = shares > 0 and cost > 0
        has_alert = alert_above > 0 or alert_below > 0

        if not has_holding and not (include_alert_only and has_alert):
            continue

        rows.append(
            {
                "symbol": symbol,
                "shares": shares,
                "cost": cost,
                "alert_above": alert_above,
                "alert_below": alert_below,
                "pnl_warning_pct": pnl_warning_pct,
            }
        )

    return sorted(rows, key=lambda item: item["symbol"])


def apply_builder_snapshots_to_entry_and_current(strategy: dict, snapshots: dict) -> dict:
    """Apply option snapshots and set entry premium from estimated opening prices.

    Builder candidates represent a new strategy that could be opened now, so entry
    premiums use estimated open pricing:
    - Buy legs prefer ask
    - Sell legs prefer bid

    Current premiums still use the conservative close logic inside
    apply_option_snapshots_to_strategy:
    - Long legs prefer bid to close
    - Short legs prefer ask to close
    """
    updated_strategy = apply_option_snapshots_to_strategy(strategy, snapshots)
    underlying = updated_strategy.get("underlying")
    expiration = updated_strategy.get("expiration")
    updated_legs = []

    for leg in updated_strategy.get("legs", []):
        contract_symbol = normalize_symbol(leg.get("contract_symbol", "")) or build_option_contract_symbol(
            underlying=underlying,
            expiration=expiration,
            option_type=leg.get("option_type"),
            strike=leg.get("strike"),
        )
        snapshot = snapshots.get(contract_symbol, {}) if contract_symbol else {}
        open_premium, open_method = select_open_premium_for_leg(leg, snapshot)
        if open_premium is not None:
            leg["entry_premium"] = open_premium
            leg["option_open_price_method"] = open_method
        elif safe_float(leg.get("current_premium"), 0.0) > 0:
            leg["entry_premium"] = safe_float(leg.get("current_premium"), 0.0)
            leg["option_open_price_method"] = "current_premium_fallback"
        else:
            leg["option_open_price_method"] = "open_unavailable"
        updated_legs.append(leg)

    updated_strategy["legs"] = updated_legs
    return updated_strategy


def render_builder_underlying_input(observed_symbols: list[str]) -> tuple[str, bool, str]:
    """Render builder underlying select/manual controls."""
    if observed_symbols:
        mode = st.radio(
            "Underlying Input",
            options=["Select", "Manual"],
            horizontal=True,
            key="builder_underlying_input_mode",
        )
    else:
        mode = "Manual"
        st.caption("No watched or held tickers found. Manual input is enabled.")

    add_to_watchlist = False
    if mode == "Manual":
        manual_underlying = st.text_input(
            "Manual Underlying",
            value="",
            placeholder="Example: QQQ",
            key="builder_manual_underlying",
        )
        underlying = normalize_symbol(manual_underlying)
        if underlying and underlying not in st.session_state.watchlist:
            add_to_watchlist = st.checkbox(
                "Add to watchlist",
                value=True,
                key="builder_manual_add_to_watchlist",
            )
        elif underlying:
            st.caption(f"{underlying} is already in watchlist.")
    else:
        underlying = st.selectbox(
            "Underlying",
            options=observed_symbols,
            key="builder_select_underlying",
        )

    return normalize_symbol(underlying), add_to_watchlist, mode


def format_builder_leg_label(leg: dict) -> str:
    return f"{leg.get('action')} {leg.get('option_type')} {safe_float(leg.get('strike'), 0.0):g}"


def parse_occ_option_symbol(contract_symbol: str, underlying: str = "") -> dict:
    """Parse OCC option symbol into expiration/type/strike for display.

    Example: QQQ260717C00500000 -> 2026-07-17 Call 500.00
    """
    symbol = normalize_symbol(contract_symbol)
    underlying = normalize_symbol(underlying)
    if underlying and symbol.startswith(underlying):
        tail = symbol[len(underlying):]
    else:
        # Fallback: last 15 chars are YYMMDD + C/P + 8-digit strike.
        tail = symbol[-15:]

    if len(tail) < 15:
        return {"expiration": "", "option_type": "", "strike": None}

    yymmdd = tail[:6]
    cp = tail[6]
    strike_code = tail[7:15]
    try:
        year = 2000 + int(yymmdd[:2])
        month = int(yymmdd[2:4])
        day = int(yymmdd[4:6])
        expiration = f"{year:04d}-{month:02d}-{day:02d}"
        option_type = "Call" if cp == "C" else "Put" if cp == "P" else ""
        strike = int(strike_code) / 1000
    except Exception:
        return {"expiration": "", "option_type": "", "strike": None}

    return {"expiration": expiration, "option_type": option_type, "strike": strike}


def render_alpaca_expiration_selector(prefix: str, underlying: str, default_date: date | None = None):
    """Render an expiration selector backed by Alpaca contracts, with manual fallback."""
    default_date = default_date or date.today()
    mode = st.radio(
        "Expiration Source",
        options=["Alpaca Dropdown", "Manual Date"],
        horizontal=True,
        key=f"{prefix}_expiration_source",
        help="Alpaca Dropdown pulls active expirations from Alpaca contracts. Manual Date is a fallback.",
    )

    if mode == "Alpaca Dropdown" and underlying:
        try:
            expirations = fetch_option_expirations(
                underlying,
                expiration_date_gte=str(date.today()),
                limit=1000,
            )
        except Exception:
            expirations = []

        if expirations:
            # Prefer a non-0DTE expiration around 30-45 days when available.
            default_index = 0
            for i, exp in enumerate(expirations):
                try:
                    dte = (date.fromisoformat(exp) - date.today()).days
                    if dte >= 14:
                        default_index = i
                        break
                except Exception:
                    continue
            expiration = st.selectbox(
                "Expiration",
                options=expirations,
                index=default_index,
                key=f"{prefix}_alpaca_expiration",
            )
            try:
                dte = (date.fromisoformat(expiration) - date.today()).days
                if dte <= 0:
                    st.warning("0DTE / same-day options may not return IV or Greeks reliably.")
                else:
                    st.caption(f"DTE: {dte} days")
            except Exception:
                pass
            return expiration, "alpaca"

        st.caption("No Alpaca expirations returned. Falling back to manual date.")

    expiration_date = st.date_input(
        "Expiration",
        value=default_date,
        key=f"{prefix}_manual_expiration",
    )
    if expiration_date <= date.today():
        st.warning("0DTE / same-day options may not return IV or Greeks reliably.")
    return str(expiration_date), "manual"


def _chain_to_rows(chain: dict, underlying: str) -> list[dict]:
    rows = []
    for contract_symbol, snapshot in (chain or {}).items():
        parsed = parse_occ_option_symbol(contract_symbol, underlying)
        bid = snapshot.get("bid")
        ask = snapshot.get("ask")
        mid = snapshot.get("mid")
        rows.append(
            {
                "Contract": contract_symbol,
                "Type": parsed.get("option_type"),
                "Strike": parsed.get("strike"),
                "Bid": bid,
                "Ask": ask,
                "Last": snapshot.get("last"),
                "Mid": mid,
                "IV": snapshot.get("implied_volatility"),
                "Delta": snapshot.get("delta"),
                "Theta": snapshot.get("theta"),
                "Vega": snapshot.get("vega"),
                "Status": snapshot.get("status"),
            }
        )
    rows = [row for row in rows if row.get("Strike") is not None]
    return sorted(rows, key=lambda row: (row.get("Type") or "", float(row.get("Strike") or 0)))


def _select_chain_row_by_delta(rows: list[dict], option_type: str, target_delta: float) -> dict | None:
    filtered = []
    for row in rows:
        if row.get("Type") != option_type:
            continue
        delta = row.get("Delta")
        if delta is None or pd.isna(delta):
            continue
        filtered.append((abs(float(delta) - float(target_delta)), row))
    if not filtered:
        return None
    filtered.sort(key=lambda item: item[0])
    return filtered[0][1]


def build_delta_based_candidate(
    *,
    underlying: str,
    current_price: float,
    outlook: str,
    expiration: str,
    target_short_delta_abs: float,
    wing_width: float,
    contracts: float,
    strike_increment: float,
    profit_target_pct: float,
):
    """Build a strategy candidate using option-chain delta for short strikes."""
    from marketagent.options import build_strategy_candidate

    target_short_delta_abs = abs(safe_float(target_short_delta_abs, 0.20))
    width = max(safe_float(wing_width, 10.0), safe_float(strike_increment, 1.0))
    lower_bound = max(0.01, safe_float(current_price, 0.0) - max(width * 4, safe_float(current_price, 0.0) * 0.25))
    upper_bound = safe_float(current_price, 0.0) + max(width * 4, safe_float(current_price, 0.0) * 0.25)

    all_rows = []
    if outlook in ["Neutral", "Bullish"]:
        put_chain = fetch_option_chain(
            underlying,
            expiration_date=expiration,
            option_type="put",
            strike_price_gte=lower_bound,
            strike_price_lte=safe_float(current_price, 0.0),
            limit=1000,
        )
        all_rows.extend(_chain_to_rows(put_chain, underlying))
    if outlook in ["Neutral", "Bearish"]:
        call_chain = fetch_option_chain(
            underlying,
            expiration_date=expiration,
            option_type="call",
            strike_price_gte=safe_float(current_price, 0.0),
            strike_price_lte=upper_bound,
            limit=1000,
        )
        all_rows.extend(_chain_to_rows(call_chain, underlying))

    if not all_rows:
        return None, "No option chain rows returned. Try manual distance mode or another expiration."

    # Start from percentage candidate, then replace short strikes with delta-selected strikes.
    candidate = build_strategy_candidate(
        underlying=underlying,
        underlying_price=current_price,
        outlook=outlook,
        expiration=expiration,
        short_distance_pct=5.0,
        wing_width=width,
        contracts=contracts,
        strike_increment=strike_increment,
        profit_target_pct=profit_target_pct,
        notes=f"Builder candidate. Delta-based short strike selection, target short delta ≈ {target_short_delta_abs:.2f}.",
    )

    short_put_row = _select_chain_row_by_delta(all_rows, "Put", -target_short_delta_abs)
    short_call_row = _select_chain_row_by_delta(all_rows, "Call", target_short_delta_abs)

    if outlook in ["Neutral", "Bullish"] and not short_put_row:
        return None, "No put contract with usable delta found for the selected expiration."
    if outlook in ["Neutral", "Bearish"] and not short_call_row:
        return None, "No call contract with usable delta found for the selected expiration."

    if outlook == "Bullish":
        short_put = safe_float(short_put_row.get("Strike"), 0.0)
        long_put = max(0.01, short_put - width)
        long_put = round(round(long_put / strike_increment) * strike_increment, 2)
        candidate["legs"] = [
            {"action": "Sell", "option_type": "Put", "strike": short_put, "contracts": contracts, "entry_premium": 0.0, "current_premium": 0.0},
            {"action": "Buy", "option_type": "Put", "strike": long_put, "contracts": contracts, "entry_premium": 0.0, "current_premium": 0.0},
        ]
    elif outlook == "Bearish":
        short_call = safe_float(short_call_row.get("Strike"), 0.0)
        long_call = short_call + width
        long_call = round(round(long_call / strike_increment) * strike_increment, 2)
        candidate["legs"] = [
            {"action": "Sell", "option_type": "Call", "strike": short_call, "contracts": contracts, "entry_premium": 0.0, "current_premium": 0.0},
            {"action": "Buy", "option_type": "Call", "strike": long_call, "contracts": contracts, "entry_premium": 0.0, "current_premium": 0.0},
        ]
    else:
        short_put = safe_float(short_put_row.get("Strike"), 0.0)
        long_put = round(round(max(0.01, short_put - width) / strike_increment) * strike_increment, 2)
        short_call = safe_float(short_call_row.get("Strike"), 0.0)
        long_call = round(round((short_call + width) / strike_increment) * strike_increment, 2)
        candidate["legs"] = [
            {"action": "Buy", "option_type": "Put", "strike": long_put, "contracts": contracts, "entry_premium": 0.0, "current_premium": 0.0},
            {"action": "Sell", "option_type": "Put", "strike": short_put, "contracts": contracts, "entry_premium": 0.0, "current_premium": 0.0},
            {"action": "Sell", "option_type": "Call", "strike": short_call, "contracts": contracts, "entry_premium": 0.0, "current_premium": 0.0},
            {"action": "Buy", "option_type": "Call", "strike": long_call, "contracts": contracts, "entry_premium": 0.0, "current_premium": 0.0},
        ]

    return candidate, None


def render_option_chain_picker():
    st.subheader("Option Chain Picker")
    st.caption("Use this compact picker to inspect Alpaca option-chain rows before building or manually entering a strategy.")
    observed_symbols = get_observed_symbols()
    with st.expander("Open Option Chain Picker", expanded=False):
        c1, c2, c3, c4 = st.columns([1, 1, 1, 1])
        with c1:
            underlying = st.selectbox("Underlying", options=observed_symbols, key="chain_picker_underlying")
        with c2:
            expiration, _ = render_alpaca_expiration_selector("chain_picker", underlying)
        with c3:
            option_type = st.selectbox("Type", options=["Call", "Put"], key="chain_picker_type")
        with c4:
            strike_range_pct = st.number_input("Strike range %", min_value=1.0, value=10.0, step=1.0, key="chain_picker_range")

        quote = fetch_latest_quotes((underlying,), force_refresh=False).get(underlying, {}) if underlying else {}
        current_price = quote.get("price")
        if current_price:
            st.caption(f"Underlying price: {format_price(current_price)}")

        fetch_chain = st.button("Fetch Option Chain", use_container_width=True, key="fetch_chain_picker")
        if fetch_chain and underlying and expiration:
            lower = None
            upper = None
            if current_price:
                lower = max(0.01, current_price * (1 - strike_range_pct / 100))
                upper = current_price * (1 + strike_range_pct / 100)
            chain = fetch_option_chain(
                underlying,
                expiration_date=str(expiration),
                option_type=option_type.lower(),
                strike_price_gte=lower,
                strike_price_lte=upper,
                limit=1000,
            )
            rows = _chain_to_rows(chain, underlying)
            if not rows:
                st.warning("No option chain rows returned for this filter.")
                return
            display_df = pd.DataFrame(rows)
            for col in ["Bid", "Ask", "Last", "Mid"]:
                if col in display_df.columns:
                    display_df[col] = display_df[col].apply(lambda x: format_price(x) if pd.notna(x) else "N/A")
            if "IV" in display_df.columns:
                display_df["IV"] = display_df["IV"].apply(format_option_iv)
            for col in ["Delta", "Theta", "Vega"]:
                if col in display_df.columns:
                    display_df[col] = display_df[col].apply(format_greek)
            st.dataframe(display_df, use_container_width=True, hide_index=True)



def _format_option_volume_reference_rows(rows: list[dict]) -> pd.DataFrame:
    display_df = pd.DataFrame(rows)
    if display_df.empty:
        return display_df

    for col in ["Volume", "Latest Bar Volume"]:
        if col in display_df.columns:
            display_df[col] = display_df[col].apply(lambda x: format_volume(x) if pd.notna(x) else "N/A")

    if "Latest Close" in display_df.columns:
        display_df["Latest Close"] = display_df["Latest Close"].apply(lambda x: format_price(x) if pd.notna(x) else "N/A")

    return display_df


def render_option_volume_reference():
    st.subheader("Option Volume Reference")
    st.caption(
        "A compact reference tool for option contract volume. It does not affect option P/L, premium, or alerts."
    )

    with st.expander("Open Option Volume Reference", expanded=False):
        observed_symbols = get_observed_symbols()
        col_1, col_2, col_3, col_4 = st.columns([1.1, 1.1, 0.9, 0.9])

        with col_1:
            input_mode = st.radio(
                "Underlying Input",
                options=["Select", "Manual"],
                horizontal=True,
                key="option_volume_underlying_mode",
            )
            if input_mode == "Manual":
                underlying = normalize_symbol(
                    st.text_input("Underlying", value="QQQ", key="option_volume_manual_underlying")
                )
            else:
                underlying = st.selectbox(
                    "Underlying",
                    options=observed_symbols or ["QQQ"],
                    key="option_volume_select_underlying",
                )

        with col_2:
            expiration, _ = render_alpaca_expiration_selector("option_volume", underlying)

        with col_3:
            option_type_filter = st.selectbox(
                "Type",
                options=["Both", "Call", "Put"],
                index=0,
                key="option_volume_type_filter",
            )

        with col_4:
            timeframe = st.selectbox(
                "Bar Timeframe",
                options=["1Day", "1Hour", "15Min", "5Min", "1Min"],
                index=0,
                key="option_volume_timeframe",
                help="1Day is usually enough for quick volume reference. Intraday timeframes may return more rows and can be slower.",
            )

        col_5, col_6, col_7 = st.columns([1, 1, 1])
        with col_5:
            strike_range_pct = st.number_input(
                "Strike range %",
                min_value=1.0,
                max_value=100.0,
                value=10.0,
                step=1.0,
                key="option_volume_strike_range_pct",
            )
        with col_6:
            max_contracts = st.number_input(
                "Max contracts",
                min_value=10,
                max_value=300,
                value=80,
                step=10,
                key="option_volume_max_contracts",
                help="Keeps this reference query lightweight.",
            )
        with col_7:
            fetch_volume = st.button(
                "Fetch Option Volume",
                use_container_width=True,
                key="fetch_option_volume_reference",
            )

        quote = fetch_latest_quotes((underlying,), force_refresh=False).get(underlying, {}) if underlying else {}
        current_price = quote.get("price")
        if current_price:
            st.caption(f"Underlying price: {format_price(current_price)} · Options feed: {ALPACA_OPTIONS_FEED}")
        else:
            st.caption(f"Options feed: {ALPACA_OPTIONS_FEED}")

        if fetch_volume:
            if not underlying:
                st.error("Enter or select an underlying symbol first.")
                return
            if not expiration:
                st.error("Select an expiration first.")
                return

            lower = None
            upper = None
            if current_price:
                lower = max(0.01, float(current_price) * (1 - strike_range_pct / 100))
                upper = float(current_price) * (1 + strike_range_pct / 100)

            contract_filters = {
                "expiration_date": str(expiration),
                "strike_price_gte": lower,
                "strike_price_lte": upper,
                "limit": 1000,
            }
            if option_type_filter != "Both":
                contract_filters["option_type"] = option_type_filter.lower()

            contracts = fetch_option_contracts(underlying, **contract_filters)
            if not contracts:
                st.warning("No option contracts returned for this filter.")
                return

            def _sort_key(contract):
                strike = safe_float(contract.get("strike_price"), 0.0)
                distance = abs(strike - safe_float(current_price, strike)) if current_price else strike
                return (distance, str(contract.get("option_type") or ""), strike)

            contracts = sorted(contracts, key=_sort_key)[: int(max_contracts)]
            contract_symbols = [contract.get("contract_symbol") for contract in contracts if contract.get("contract_symbol")]

            if not contract_symbols:
                st.warning("No valid contract symbols returned for this filter.")
                return

            with st.spinner("Fetching option volume bars..."):
                bar_summaries = fetch_option_bars(contract_symbols, timeframe=timeframe, limit=1000)

            rows = []
            contract_lookup = {contract.get("contract_symbol"): contract for contract in contracts}
            for contract_symbol in contract_symbols:
                contract = contract_lookup.get(contract_symbol, {})
                summary = bar_summaries.get(contract_symbol, {})
                rows.append(
                    {
                        "Contract": contract_symbol,
                        "Type": contract.get("option_type"),
                        "Strike": contract.get("strike_price"),
                        "Expiration": contract.get("expiration_date"),
                        "Volume": summary.get("total_volume"),
                        "Latest Bar Volume": summary.get("latest_volume"),
                        "Latest Close": summary.get("latest_close"),
                        "Bars": summary.get("bar_count"),
                        "Timeframe": summary.get("timeframe") or timeframe,
                        "Status": summary.get("status"),
                    }
                )

            rows = sorted(
                rows,
                key=lambda row: (
                    -safe_float(row.get("Volume"), -1),
                    str(row.get("Type") or ""),
                    safe_float(row.get("Strike"), 0.0),
                ),
            )
            display_df = _format_option_volume_reference_rows(rows)
            st.dataframe(display_df, use_container_width=True, hide_index=True)
            st.caption(
                "Volume comes from Alpaca option bars and is for reference only. "
                "With indicative options data, treat volume as a development/tracking estimate rather than broker-grade OPRA volume."
            )


def build_current_portfolio_dataframe(force_refresh: bool = False) -> pd.DataFrame:
    rows = []
    active_positions = get_current_position_rows(include_alert_only=True)

    quote_cache = fetch_latest_quotes(
        tuple(item["symbol"] for item in active_positions),
        force_refresh=force_refresh,
        max_age_seconds=0 if force_refresh else None,
    )

    for item in active_positions:
        symbol = item["symbol"]
        shares = item["shares"]
        cost = item["cost"]
        alert_above = item["alert_above"]
        alert_below = item["alert_below"]
        pnl_warning_pct = item["pnl_warning_pct"]

        current_price = quote_cache.get(symbol, {}).get("price")
        if current_price is None:
            current_price = fetch_latest_price(symbol, force_refresh=force_refresh)

        cost_amount = None
        market_value = None
        unrealized_pl = None
        unrealized_pl_pct = None

        if shares > 0 and cost > 0 and current_price is not None:
            cost_amount = shares * cost
            market_value = shares * current_price
            unrealized_pl = market_value - cost_amount
            unrealized_pl_pct = unrealized_pl / cost_amount * 100

        rows.append(
            {
                "Symbol": symbol,
                "Shares": shares,
                "Average Cost": cost,
                "Current Price": current_price,
                "Cost Amount": cost_amount,
                "Market Value": market_value,
                "Unrealized P/L": unrealized_pl,
                "Unrealized P/L %": unrealized_pl_pct,
                "Break Above": alert_above,
                "Stop Breakdown": alert_below,
                "P/L Warning %": pnl_warning_pct,
                "Quote Source": quote_cache.get(symbol, {}).get("source", "N/A"),
                "Quote Updated": quote_cache.get(symbol, {}).get("cache_updated_at_et", "N/A"),
            }
        )

    return pd.DataFrame(rows)


def render_portfolio_quote_controls(symbols: list[str]) -> bool:
    st.subheader("Quote Status")

    status = get_quote_cache_status(symbols)

    status_col_1, status_col_2, status_col_3, status_col_4 = st.columns([1, 1, 2, 1])

    with status_col_1:
        st.metric(
            "Cached Quotes",
            f"{status.get('cached_count', 0)}/{status.get('requested_count', 0)}",
        )

    with status_col_2:
        st.metric("Oldest Quote Age", format_age(status.get("oldest_age_seconds")))

    with status_col_3:
        st.metric("Quote Source", status.get("source_summary", "N/A"))

    refreshed = False
    with status_col_4:
        st.write("")
        if st.button("Refresh Quotes", use_container_width=True, disabled=not bool(symbols)):
            refresh_latest_quotes(tuple(symbols))
            refreshed = True
            st.success("Quotes refreshed.")

    if status.get("missing_symbols"):
        st.caption("Missing cached quotes: " + ", ".join(status.get("missing_symbols", [])))

    if status.get("last_updated_et"):
        st.caption(f"Last quote cache update: {status.get('last_updated_et')}")
    else:
        st.caption("Portfolio reads the shared quote cache. Use Refresh Quotes when prices look stale.")

    return refreshed



def build_realized_pl_dataframe(force_refresh: bool = False) -> pd.DataFrame:
    rows = build_realized_pl_rows(force_refresh=force_refresh)
    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame(rows)
    preferred_cols = [
        "symbol",
        "status",
        "total_bought_shares",
        "total_sold_shares",
        "remaining_shares",
        "average_cost",
        "avg_sell_price",
        "current_price",
        "market_value",
        "realized_pl",
        "realized_pl_pct",
        "unrealized_pl",
        "unrealized_pl_pct",
        "total_pl",
        "total_pl_pct",
        "total_fees",
        "first_trade_date",
        "last_trade_date",
        "transactions_count",
        "quote_source",
        "quote_updated",
    ]
    existing_cols = [col for col in preferred_cols if col in df.columns]
    return df[existing_cols].copy()


def format_realized_pl_dataframe(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df

    display_df = df.copy()
    rename_map = {
        "symbol": "Symbol",
        "status": "Status",
        "total_bought_shares": "Bought Shares",
        "total_sold_shares": "Sold Shares",
        "remaining_shares": "Remaining Shares",
        "average_cost": "Avg Cost",
        "avg_sell_price": "Avg Sell Price",
        "current_price": "Current Price",
        "market_value": "Market Value",
        "realized_pl": "Realized P/L",
        "realized_pl_pct": "Realized P/L %",
        "unrealized_pl": "Unrealized P/L",
        "unrealized_pl_pct": "Unrealized P/L %",
        "total_pl": "Total P/L",
        "total_pl_pct": "Total P/L %",
        "total_fees": "Total Fees",
        "first_trade_date": "First Trade",
        "last_trade_date": "Last Trade",
        "transactions_count": "Transactions",
        "quote_source": "Quote Source",
        "quote_updated": "Quote Updated",
    }
    display_df = display_df.rename(columns=rename_map)

    money_cols = [
        "Avg Cost",
        "Avg Sell Price",
        "Current Price",
        "Market Value",
        "Realized P/L",
        "Unrealized P/L",
        "Total P/L",
        "Total Fees",
    ]
    for col in money_cols:
        if col in display_df.columns:
            display_df[col] = display_df[col].apply(lambda x: format_price(x) if pd.notna(x) else "N/A")

    pct_cols = ["Realized P/L %", "Unrealized P/L %", "Total P/L %"]
    for col in pct_cols:
        if col in display_df.columns:
            display_df[col] = display_df[col].apply(lambda x: format_pct(x) if pd.notna(x) else "N/A")

    share_cols = ["Bought Shares", "Sold Shares", "Remaining Shares"]
    for col in share_cols:
        if col in display_df.columns:
            display_df[col] = display_df[col].apply(lambda x: f"{float(x):,.4g}" if pd.notna(x) else "N/A")

    return display_df

def render_portfolio_summary_tab():
    active_symbols = get_active_position_symbols(include_alert_only=True)
    force_refresh = render_portfolio_quote_controls(active_symbols)

    portfolio_df = build_current_portfolio_dataframe(force_refresh=force_refresh)
    realized_rows = build_realized_pl_rows(force_refresh=False)
    realized_summary = build_realized_pl_summary(realized_rows)

    has_current_holdings = not portfolio_df.empty
    has_transaction_history = bool(realized_rows)

    if not has_current_holdings and not has_transaction_history:
        st.info("No saved positions or transaction history yet. Add/update positions from Holdings, or record a Buy transaction.")
        return

    total_cost = portfolio_df["Cost Amount"].dropna().sum() if has_current_holdings else 0.0
    total_market_value = portfolio_df["Market Value"].dropna().sum() if has_current_holdings else 0.0
    total_unrealized_pl = portfolio_df["Unrealized P/L"].dropna().sum() if has_current_holdings else 0.0
    total_unrealized_pl_pct = total_unrealized_pl / total_cost * 100 if total_cost > 0 else None
    total_realized_pl = realized_summary.get("realized_pl", 0.0)
    total_combined_pl = total_realized_pl + total_unrealized_pl

    st.subheader("Portfolio Performance")
    metric_col_1, metric_col_2, metric_col_3, metric_col_4, metric_col_5 = st.columns(5)

    with metric_col_1:
        st.metric("Open Cost", format_price(total_cost))

    with metric_col_2:
        st.metric("Market Value", format_price(total_market_value))

    with metric_col_3:
        st.metric("Unrealized P/L", format_price(total_unrealized_pl), format_pct(total_unrealized_pl_pct))

    with metric_col_4:
        st.metric("Realized P/L", format_price(total_realized_pl))

    with metric_col_5:
        st.metric("Total P/L", format_price(total_combined_pl))

    perf_col_1, perf_col_2, perf_col_3 = st.columns(3)
    with perf_col_1:
        st.caption(f"Closed positions: {realized_summary.get('closed_count', 0)}")
    with perf_col_2:
        st.caption(f"Symbols with sells: {realized_summary.get('sold_symbols_count', 0)}")
    with perf_col_3:
        st.caption("Total P/L = realized P/L + current unrealized P/L.")

    if not has_current_holdings:
        st.info("No current open holdings. Your realized gains/losses are still available in the Realized P/L tab.")
    else:
        st.subheader("Current Holdings")

        display_df = portfolio_df.copy()

        money_cols = [
            "Average Cost",
            "Current Price",
            "Cost Amount",
            "Market Value",
            "Unrealized P/L",
            "Break Above",
            "Stop Breakdown",
        ]

        for col in money_cols:
            display_df[col] = display_df[col].apply(lambda x: format_price(x) if pd.notna(x) else "N/A")

        display_df["Unrealized P/L %"] = display_df["Unrealized P/L %"].apply(
            lambda x: format_pct(x) if pd.notna(x) else "N/A"
        )

        display_df["P/L Warning %"] = display_df["P/L Warning %"].apply(
            lambda x: f"-{float(x):.2f}%" if pd.notna(x) else "N/A"
        )

        st.dataframe(display_df, use_container_width=True, hide_index=True)

    if has_transaction_history:
        st.subheader("Top Realized / Total P&L")
        realized_df = pd.DataFrame(realized_rows)
        top_df = realized_df.sort_values(by="total_pl", ascending=False).head(8)
        top_display = format_realized_pl_dataframe(top_df)
        compact_cols = [
            "Symbol",
            "Status",
            "Realized P/L",
            "Unrealized P/L",
            "Total P/L",
            "Remaining Shares",
            "Last Trade",
        ]
        compact_cols = [col for col in compact_cols if col in top_display.columns]
        st.dataframe(top_display[compact_cols], use_container_width=True, hide_index=True)
        st.caption("Open the Realized P/L tab for the full by-symbol report, including closed positions.")

    col_1, col_2 = st.columns([1, 4])

    with col_1:
        if st.button("Save Portfolio Snapshot Now", use_container_width=True, disabled=not has_current_holdings):
            success, message = save_portfolio_snapshot(source="manual")
            if success:
                st.success(message)
            else:
                st.warning(message)

    with col_2:
        st.caption("Snapshots track current open holdings only. Realized P/L is calculated from transaction history.")

def render_holdings_tab():
    st.subheader("Add / Update Position")

    with st.form("add_update_position_form", clear_on_submit=False):
        col_1, col_2, col_3 = st.columns(3)

        with col_1:
            observed_symbols = get_observed_symbols()
            symbol = st.selectbox(
                "Symbol",
                options=observed_symbols,
                help="Select from current Dashboard watchlist / displayed symbols / portfolio symbols.",
                key="holdings_symbol_select",
            )

        with col_2:
            shares = st.number_input("Shares", min_value=0.0, value=0.0, step=1.0)

        with col_3:
            average_cost = st.number_input("Average Cost", min_value=0.0, value=0.0, step=0.01)

        col_4, col_5, col_6 = st.columns(3)

        with col_4:
            default_range_pct = st.number_input(
                "Default Alert Range %",
                min_value=0.0,
                value=float(DEFAULT_POSITION_ALERT_RANGE_PCT),
                step=1.0,
                help="If Break Above or Stop Breakdown is left at 0, it will be generated from average cost using this percentage.",
            )

        with col_5:
            alert_above = st.number_input("Break Above", min_value=0.0, value=0.0, step=0.01)

        with col_6:
            alert_below = st.number_input("Stop Breakdown", min_value=0.0, value=0.0, step=0.01)

        pnl_warning_pct = st.number_input(
            "P/L Warning %",
            min_value=0.0,
            value=5.0,
            step=0.5,
            help="Dashboard alert will warn when unrealized P/L drops below this percentage from cost.",
        )

        submitted = st.form_submit_button("Save Position")

        if submitted:
            symbol = normalize_symbol(symbol)

            if not symbol:
                st.error("Symbol is required.")
            elif shares > 0 and average_cost <= 0:
                st.error("Average Cost is required when Shares is greater than 0.")
            else:
                default_above, default_below = build_default_alert_levels(average_cost, default_range_pct)

                if alert_above <= 0:
                    alert_above = default_above
                if alert_below <= 0:
                    alert_below = default_below

                set_position(
                    symbol,
                    {
                        "shares": shares,
                        "cost": average_cost,
                        "alert_above": alert_above,
                        "alert_below": alert_below,
                        "pnl_warning_pct": pnl_warning_pct,
                    },
                )

                if symbol not in st.session_state.watchlist:
                    st.session_state.watchlist.append(symbol)
                    st.session_state.watchlist = sorted(list(dict.fromkeys(st.session_state.watchlist)))

                save_app_settings()
                st.success(f"Position saved for {symbol}. Default alert range used where alert values were 0.")
                st.rerun()

    st.divider()
    st.subheader("Edit Existing Position")

    active_symbols = get_active_position_symbols(include_alert_only=True)

    if not active_symbols:
        st.info("No current positions or alert-only positions to edit yet.")
    else:
        selected_symbol = st.selectbox("Position to Edit", options=active_symbols, key="edit_position_symbol")
        current = get_position(selected_symbol)

        with st.form(f"edit_position_form_{selected_symbol}", clear_on_submit=False):
            edit_col_1, edit_col_2, edit_col_3 = st.columns(3)

            with edit_col_1:
                edit_shares = st.number_input(
                    "Shares",
                    min_value=0.0,
                    value=float(current.get("shares", 0.0)),
                    step=1.0,
                    key=f"edit_{selected_symbol}_shares",
                )

            with edit_col_2:
                edit_cost = st.number_input(
                    "Average Cost",
                    min_value=0.0,
                    value=float(current.get("cost", 0.0)),
                    step=0.01,
                    key=f"edit_{selected_symbol}_cost",
                )

            with edit_col_3:
                edit_default_range_pct = st.number_input(
                    "Reset Alert Range %",
                    min_value=0.0,
                    value=float(DEFAULT_POSITION_ALERT_RANGE_PCT),
                    step=1.0,
                    key=f"edit_{selected_symbol}_range",
                )

            edit_col_4, edit_col_5, edit_col_6 = st.columns(3)

            with edit_col_4:
                edit_alert_above = st.number_input(
                    "Break Above",
                    min_value=0.0,
                    value=float(current.get("alert_above", 0.0)),
                    step=0.01,
                    key=f"edit_{selected_symbol}_above",
                )

            with edit_col_5:
                edit_alert_below = st.number_input(
                    "Stop Breakdown",
                    min_value=0.0,
                    value=float(current.get("alert_below", 0.0)),
                    step=0.01,
                    key=f"edit_{selected_symbol}_below",
                )

            with edit_col_6:
                edit_pnl_warning_pct = st.number_input(
                    "P/L Warning %",
                    min_value=0.0,
                    value=float(current.get("pnl_warning_pct", 5.0)),
                    step=0.5,
                    key=f"edit_{selected_symbol}_pnl_warning",
                )

            reset_alerts = st.checkbox(
                "Reset Break Above / Stop Breakdown to selected range from Average Cost",
                value=False,
                key=f"edit_{selected_symbol}_reset_alerts",
            )

            edit_submitted = st.form_submit_button("Save Changes")

            if edit_submitted:
                if edit_shares > 0 and edit_cost <= 0:
                    st.error("Average Cost is required when Shares is greater than 0.")
                else:
                    if reset_alerts:
                        edit_alert_above, edit_alert_below = build_default_alert_levels(
                            edit_cost,
                            edit_default_range_pct,
                        )

                    set_position(
                        selected_symbol,
                        {
                            "shares": edit_shares,
                            "cost": edit_cost,
                            "alert_above": edit_alert_above,
                            "alert_below": edit_alert_below,
                            "pnl_warning_pct": edit_pnl_warning_pct,
                        },
                    )
                    save_app_settings()
                    st.success(f"Position updated for {selected_symbol}.")
                    st.rerun()

        with st.expander("Delete Position", expanded=False):
            st.warning("Deleting a position removes its holdings and alert settings from Portfolio. It does not delete transaction history.")
            confirm_delete = st.checkbox(
                f"I understand and want to delete {selected_symbol}",
                value=False,
                key=f"delete_confirm_{selected_symbol}",
            )
            if st.button("Delete Selected Position", disabled=not confirm_delete, use_container_width=True):
                remove_position(selected_symbol)
                save_app_settings()
                st.success(f"Position deleted for {selected_symbol}.")
                st.rerun()


def render_transaction_tab():
    st.subheader("Add Buy / Sell Transaction")

    # Keep these outside a form so the Sell MAX button can update the shares input immediately.
    transaction_type = st.selectbox(
        "Transaction Type",
        options=["Buy", "Sell"],
        key="transaction_type_selector",
    )

    holding_symbols = [
        symbol for symbol in get_active_position_symbols(include_alert_only=False)
        if get_position(symbol).get("shares", 0.0) > 0
    ]

    if transaction_type == "Sell" and not holding_symbols:
        st.info("No current holdings available to sell. Add a position or record a Buy transaction first.")
        return

    if "transaction_shares_input" not in st.session_state:
        st.session_state.transaction_shares_input = 0.0
    if "transaction_fees_input" not in st.session_state:
        st.session_state.transaction_fees_input = float(DEFAULT_TRANSACTION_FEE)

    col_1, col_2 = st.columns(2)

    with col_1:
        if transaction_type == "Sell":
            transaction_symbol = st.selectbox(
                "Symbol",
                options=holding_symbols,
                key="sell_symbol_select",
            )
            max_sell_shares = float(get_position(transaction_symbol).get("shares", 0.0))
            st.caption(f"Current shares: {max_sell_shares:,.2f}")
        else:
            observed_symbols = get_observed_symbols()
            buy_symbol_mode = st.radio(
                "Buy Symbol Input",
                options=["Select", "Manual"],
                horizontal=True,
                key="buy_symbol_input_mode",
                help="Select from watched tickers, or manually type a new ticker.",
            )

            if buy_symbol_mode == "Manual":
                manual_symbol = st.text_input(
                    "Manual Symbol",
                    value="",
                    placeholder="Example: MU",
                    key="buy_manual_symbol_input",
                )
                transaction_symbol = normalize_symbol(manual_symbol)

                if transaction_symbol:
                    if transaction_symbol in st.session_state.watchlist:
                        st.caption(f"{transaction_symbol} is already in watchlist.")
                        add_buy_symbol_to_watchlist = False
                    else:
                        add_buy_symbol_to_watchlist = st.checkbox(
                            "Add to watchlist",
                            value=True,
                            key="buy_manual_add_to_watchlist",
                            help="Keep this checked if you want the new ticker to appear on Dashboard watchlist.",
                        )
                else:
                    add_buy_symbol_to_watchlist = False
                    st.caption("Type a ticker symbol, for example MU or NVDA.")
            else:
                transaction_symbol = st.selectbox(
                    "Symbol",
                    options=observed_symbols,
                    key="buy_symbol_select",
                    help="Select from the current Dashboard watchlist / displayed tickers / portfolio symbols.",
                )
                add_buy_symbol_to_watchlist = True

            max_sell_shares = None

    with col_2:
        trade_date = st.date_input(
            "Trade Date",
            value=date.today(),
            key="transaction_trade_date",
        )

    col_3, col_3b, col_4, col_5 = st.columns([1.2, 0.7, 1, 1])

    with col_3:
        if transaction_type == "Sell":
            max_sell_shares = float(max_sell_shares or 0.0)
            current_value = safe_float(st.session_state.get("transaction_shares_input"), 0.0)
            if current_value > max_sell_shares:
                st.session_state.transaction_shares_input = max_sell_shares
            transaction_shares = st.number_input(
                "Shares",
                min_value=0.0,
                max_value=max_sell_shares,
                step=1.0,
                key="transaction_shares_input",
            )
        else:
            transaction_shares = st.number_input(
                "Shares",
                min_value=0.0,
                step=1.0,
                key="transaction_shares_input",
            )

    with col_3b:
        st.write("")
        st.write("")
        if transaction_type == "Sell":
            st.button(
                "MAX",
                use_container_width=True,
                help="Fill all current shares for the selected holding.",
                on_click=set_transaction_shares_to_max,
                args=(max_sell_shares,),
            )
        else:
            st.caption("MAX is available for Sell.")

    with col_4:
        transaction_price = st.number_input(
            "Price",
            min_value=0.0,
            value=0.0,
            step=0.01,
            key="transaction_price_input",
        )

    with col_5:
        transaction_fees = st.number_input(
            "Fees / Commission",
            min_value=0.0,
            step=0.01,
            key="transaction_fees_input",
            help="Default is 6.95. You can adjust it before saving.",
        )

    transaction_note = st.text_area(
        "Note",
        value="",
        placeholder="Example: partial sell near resistance / add after breakout",
        key="transaction_note_input",
    )

    if transaction_type == "Buy" and transaction_price > 0:
        default_above, default_below = build_default_alert_levels(
            transaction_price,
            DEFAULT_POSITION_ALERT_RANGE_PCT,
        )
        st.caption(
            f"New Buy positions will default alerts to Break Above {format_price(default_above)} "
            f"and Stop Breakdown {format_price(default_below)} if no custom alerts already exist."
        )

    if st.button("Save Transaction and Update Position", type="primary", use_container_width=True):
        success, message = apply_transaction_to_position(
            transaction_type=transaction_type,
            symbol=transaction_symbol,
            trade_date=str(trade_date),
            shares=transaction_shares,
            price=transaction_price,
            fees=transaction_fees,
            note=transaction_note,
            add_to_watchlist=add_buy_symbol_to_watchlist if transaction_type == "Buy" else False,
        )

        if success:
            st.success(message)
            st.rerun()
        else:
            st.error(message)

    st.divider()
    st.subheader("Transaction History")

    transactions = load_transactions()

    if not transactions:
        st.info("No transactions recorded yet.")
        return

    transactions_df = pd.DataFrame(transactions)

    preferred_cols = [
        "trade_date",
        "type",
        "symbol",
        "shares",
        "price",
        "fees",
        "gross_amount",
        "avg_cost_at_trade",
        "realized_pl",
        "realized_pl_pct",
        "note",
        "created_at_et",
    ]

    existing_cols = [col for col in preferred_cols if col in transactions_df.columns]
    transactions_df = transactions_df[existing_cols].copy()

    transactions_df = transactions_df.sort_values(
        by=["trade_date", "created_at_et"],
        ascending=False,
    )

    display_df = transactions_df.copy()

    for col in ["price", "fees", "gross_amount", "avg_cost_at_trade", "realized_pl"]:
        if col in display_df.columns:
            display_df[col] = display_df[col].apply(
                lambda x: format_price(x) if pd.notna(x) else "N/A"
            )

    if "realized_pl_pct" in display_df.columns:
        display_df["realized_pl_pct"] = display_df["realized_pl_pct"].apply(
            lambda x: format_pct(x) if pd.notna(x) else "N/A"
        )

    st.dataframe(display_df, use_container_width=True, hide_index=True)

    st.divider()
    with st.expander("Delete / correct a transaction", expanded=False):
        st.warning(
            "Use this only for mistaken entries. Deleting a transaction rewrites the local transaction history "
            "and recalculates the affected stock's current holding from the remaining Buy/Sell records."
        )

        transaction_choices = []
        for original_index, transaction in enumerate(transactions):
            transaction_choices.append(
                {
                    "original_index": original_index,
                    "id": str(transaction.get("id") or ""),
                    "trade_date": str(transaction.get("trade_date") or ""),
                    "created_at_et": str(transaction.get("created_at_et") or ""),
                    "type": str(transaction.get("type") or ""),
                    "symbol": normalize_symbol(transaction.get("symbol", "")),
                    "shares": safe_float(transaction.get("shares"), 0.0),
                    "price": safe_float(transaction.get("price"), 0.0),
                    "fees": safe_float(transaction.get("fees"), 0.0),
                    "note": str(transaction.get("note") or ""),
                }
            )

        transaction_choices = sorted(
            transaction_choices,
            key=lambda item: (item["trade_date"], item["created_at_et"], item["id"]),
            reverse=True,
        )

        def _format_delete_choice(index: int) -> str:
            item = transaction_choices[index]
            note = f" | {item['note'][:45]}" if item.get("note") else ""
            return (
                f"{item['trade_date']} | {item['type']} | {item['symbol']} | "
                f"{item['shares']:,.4g} @ {format_price(item['price'])} | Fee {format_price(item['fees'])}"
                f"{note}"
            )

        selected_delete_index = st.selectbox(
            "Select mistaken transaction",
            options=list(range(len(transaction_choices))),
            format_func=_format_delete_choice,
            key="delete_transaction_select",
        )

        selected_item = transaction_choices[selected_delete_index]
        st.caption(
            f"Selected: {selected_item['trade_date']} {selected_item['type']} "
            f"{selected_item['symbol']} {selected_item['shares']:,.4g} @ {format_price(selected_item['price'])}"
        )

        confirm_delete_tx = st.checkbox(
            "I understand this will delete the selected transaction and recalculate the affected holding.",
            key="confirm_delete_transaction",
        )

        if st.button(
            "Delete Selected Transaction",
            disabled=not confirm_delete_tx,
            use_container_width=True,
            key="delete_selected_transaction_button",
        ):
            success, message = delete_transaction(
                transaction_id=selected_item.get("id") or None,
                row_index=selected_item.get("original_index"),
            )
            if success:
                st.success(message)
                st.rerun()
            else:
                st.error(message)


def render_realized_pl_tab():
    st.subheader("Realized P/L & Closed Positions")
    st.caption(
        "This report replays your stock Buy/Sell transaction history using the average-cost method. "
        "Fully sold symbols stay here even when they no longer appear in Current Holdings."
    )

    refresh_col, filter_col = st.columns([1, 2])
    with refresh_col:
        force_refresh = st.button("Refresh Open Quotes", use_container_width=True)
    with filter_col:
        status_filter = st.multiselect(
            "Status Filter",
            options=["Open", "Partially Sold", "Closed", "No Sale"],
            default=["Open", "Partially Sold", "Closed"],
            help="No Sale means there are buys but no sell transaction yet.",
        )

    realized_df = build_realized_pl_dataframe(force_refresh=force_refresh)

    if realized_df.empty:
        st.info("No stock transaction history found yet. Record Buy/Sell transactions to build realized P/L.")
        return

    if status_filter and "status" in realized_df.columns:
        realized_df = realized_df[realized_df["status"].isin(status_filter)].copy()

    if realized_df.empty:
        st.info("No rows match the selected status filter.")
        return

    summary = build_realized_pl_summary(realized_df.to_dict("records"))
    metric_col_1, metric_col_2, metric_col_3, metric_col_4 = st.columns(4)

    with metric_col_1:
        st.metric("Realized P/L", format_price(summary.get("realized_pl", 0.0)))
    with metric_col_2:
        st.metric("Unrealized P/L", format_price(summary.get("unrealized_pl", 0.0)))
    with metric_col_3:
        st.metric("Total P/L", format_price(summary.get("total_pl", 0.0)))
    with metric_col_4:
        st.metric("Closed Positions", f"{summary.get('closed_count', 0)}")

    sort_by = st.selectbox(
        "Sort By",
        options=["total_pl", "realized_pl", "unrealized_pl", "last_trade_date", "symbol"],
        format_func=lambda x: {
            "total_pl": "Total P/L",
            "realized_pl": "Realized P/L",
            "unrealized_pl": "Unrealized P/L",
            "last_trade_date": "Last Trade",
            "symbol": "Symbol",
        }.get(x, x),
        key="realized_pl_sort_by",
    )
    ascending = st.checkbox("Sort ascending", value=False, key="realized_pl_sort_ascending")

    if sort_by in realized_df.columns:
        realized_df = realized_df.sort_values(by=sort_by, ascending=ascending)

    display_df = format_realized_pl_dataframe(realized_df)
    st.dataframe(display_df, use_container_width=True, hide_index=True)

    with st.expander("How this is calculated", expanded=False):
        st.markdown(
            """
- **Realized P/L** is created when you record a Sell transaction.
- The first version uses the same **average cost** method as the current holdings logic.
- **Closed** means remaining shares are zero but the symbol still has sell history.
- **Total P/L** = realized P/L + unrealized P/L for any remaining shares.
- Manual edits in the Holdings tab can change current holdings but do not create realized P/L. Use Transactions for trade history.
            """
        )


def render_history_tab():
    st.subheader("Portfolio Snapshot History")

    history = load_portfolio_history()

    if not history:
        st.info("No portfolio history yet. Click 'Save Portfolio Snapshot Now' from the Summary tab.")
        return

    history_df = pd.DataFrame(history)

    if history_df.empty:
        st.info("No portfolio history yet.")
        return

    history_df = history_df.sort_values(by="snapshot_time_et")

    chart_df = history_df.copy()
    chart_df["snapshot_time"] = pd.to_datetime(
        chart_df["snapshot_time_et"].str.replace(" ET", "", regex=False),
        errors="coerce",
    )

    st.subheader("History Charts")

    if HAS_PLOTLY:
        chart_col_1, chart_col_2 = st.columns(2)

        with chart_col_1:
            fig_value = go.Figure()
            fig_value.add_trace(
                go.Scatter(
                    x=chart_df["snapshot_time"],
                    y=chart_df["market_value"],
                    mode="lines+markers",
                    name="Market Value",
                )
            )
            fig_value.update_layout(
                title="Market Value History",
                height=380,
                margin=dict(l=20, r=20, t=45, b=20),
                xaxis_title="Time",
                yaxis_title="Market Value",
                hovermode="x unified",
            )
            st.plotly_chart(fig_value, use_container_width=True)

        with chart_col_2:
            fig_pl = go.Figure()
            fig_pl.add_trace(
                go.Scatter(
                    x=chart_df["snapshot_time"],
                    y=chart_df["unrealized_pl"],
                    mode="lines+markers",
                    name="Unrealized P/L",
                )
            )
            fig_pl.update_layout(
                title="Unrealized P/L History",
                height=380,
                margin=dict(l=20, r=20, t=45, b=20),
                xaxis_title="Time",
                yaxis_title="Unrealized P/L",
                hovermode="x unified",
            )
            st.plotly_chart(fig_pl, use_container_width=True)

    else:
        st.line_chart(chart_df.set_index("snapshot_time")[["market_value", "unrealized_pl"]])

    st.subheader("History Table")

    display_df = history_df[
        [
            "snapshot_time_et",
            "source",
            "total_cost",
            "market_value",
            "unrealized_pl",
            "unrealized_pl_pct",
            "holdings_count",
        ]
    ].copy()

    for col in ["total_cost", "market_value", "unrealized_pl"]:
        display_df[col] = display_df[col].apply(lambda x: format_price(x) if pd.notna(x) else "N/A")

    display_df["unrealized_pl_pct"] = display_df["unrealized_pl_pct"].apply(
        lambda x: format_pct(x) if pd.notna(x) else "N/A"
    )

    st.dataframe(display_df.sort_values(by="snapshot_time_et", ascending=False), use_container_width=True, hide_index=True)


def render_options_strategy_summary():
    strategies = getattr(st.session_state, "option_strategies", [])

    if not strategies:
        st.info("No option strategies yet. Add your first strategy below.")
        return

    df = strategies_to_dataframe(strategies)
    if df.empty:
        st.info("No option strategies yet. Add your first strategy below.")
        return

    display_df = df.drop(columns=["id"], errors="ignore").copy()

    for col in ["Entry Cash Flow", "Current Close Cash Flow", "Unrealized P/L", "Realized P/L"]:
        if col in display_df.columns:
            display_df[col] = display_df[col].apply(lambda x: format_price(x) if pd.notna(x) else "N/A")

    for col in ["Max Profit", "Max Loss"]:
        if col in display_df.columns:
            display_df[col] = display_df[col].apply(format_option_risk_value)

    for col in ["Profit Progress %", "Target %"]:
        if col in display_df.columns:
            display_df[col] = display_df[col].apply(lambda x: format_pct(x) if pd.notna(x) else "N/A")

    display_df = display_df.rename(
        columns={
            "Type": "Strategy",
            "Entry Cash Flow": "Net Entry",
            "Current Close Cash Flow": "Close Value",
            "Unrealized P/L": "P/L",
            "Realized P/L": "Realized P/L",
            "Profit Progress %": "Progress",
            "Snapshot Status": "Snapshot",
        }
    )

    preferred_cols = [
        "Name", "Underlying", "Status", "Strategy", "Expiration", "Legs", "Entry Type",
        "Net Entry", "Close Value", "P/L", "Realized P/L", "Progress", "Max Profit", "Max Loss",
        "Break-even(s)", "Target %", "Data Quality", "Snapshot", "Alert", "Closed At", "Updated",
    ]
    display_df = display_df[[col for col in preferred_cols if col in display_df.columns]]

    open_count = int((display_df.get("Status") == "Open").sum()) if "Status" in display_df.columns else len(display_df)
    closed_count = int((display_df.get("Status") == "Closed").sum()) if "Status" in display_df.columns else 0
    st.subheader("Options Strategy Summary")
    st.caption(f"Open strategies: {open_count} · Closed strategies: {closed_count}. Closed strategies remain in this local history with realized P/L.")
    st.dataframe(display_df, use_container_width=True, hide_index=True)


def render_options_strategy_builder():
    st.subheader("Strategy Builder")
    st.caption(
        "Generate a rules-based options candidate from the current stock price. "
        "This is a tracking shortcut, not a trade recommendation. v1 uses percentage distance and wing width; later v2 can use option-chain delta."
    )

    observed_symbols = get_observed_symbols()

    with st.expander("Build Strategy Candidate", expanded=True):
        col_1, col_2, col_3, col_4 = st.columns([1.2, 1, 1, 1])

        with col_1:
            underlying, add_to_watchlist, underlying_mode = render_builder_underlying_input(observed_symbols)

        with col_2:
            outlook = st.selectbox(
                "Outlook",
                options=BUILDER_OUTLOOKS,
                index=BUILDER_OUTLOOKS.index("Neutral"),
                key="builder_outlook",
                help="Neutral builds an Iron Condor. Bullish builds a Put Credit Spread. Bearish builds a Call Credit Spread.",
            )

        with col_3:
            expiration, expiration_source = render_alpaca_expiration_selector("builder", underlying)

        with col_4:
            contracts = st.number_input(
                "Contracts",
                min_value=1.0,
                value=1.0,
                step=1.0,
                key="builder_contracts",
            )

        strike_selection_method = st.selectbox(
            "Strike Selection Method",
            options=["Percent Distance", "Delta Target"],
            index=0,
            key="builder_strike_selection_method",
            help="Percent Distance uses current stock price. Delta Target uses Alpaca option-chain Greeks to choose short strikes when Greeks are available.",
        )

        col_5, col_6, col_7, col_8 = st.columns(4)

        with col_5:
            if strike_selection_method == "Delta Target":
                target_short_delta_abs = st.number_input(
                    "Target Short Delta",
                    min_value=0.05,
                    max_value=0.60,
                    value=0.20,
                    step=0.01,
                    key="builder_target_short_delta",
                    help="Common short-leg delta range is around 0.15-0.30. Puts use negative delta automatically.",
                )
                short_distance_pct = 5.0
            else:
                target_short_delta_abs = 0.20
                short_distance_pct = st.number_input(
                    "Short Strike Distance %",
                    min_value=0.5,
                    value=5.0,
                    step=0.5,
                    key="builder_short_distance_pct",
                    help="Approximate distance from current stock price to the short strike.",
                )

        with col_6:
            wing_width = st.number_input(
                "Wing Width $",
                min_value=0.5,
                value=10.0,
                step=0.5,
                key="builder_wing_width",
                help="Distance between short and long protective strike.",
            )

        with col_7:
            strike_increment = st.selectbox(
                "Strike Increment",
                options=[0.5, 1.0, 2.5, 5.0, 10.0],
                index=1,
                key="builder_strike_increment",
            )

        with col_8:
            profit_target_pct = st.number_input(
                "Profit Target %",
                min_value=0.0,
                value=float(DEFAULT_OPTIONS_PROFIT_TARGET_PCT),
                step=5.0,
                key="builder_profit_target_pct",
            )

        current_price = None
        price_source_caption = ""
        if underlying:
            quote = fetch_latest_quotes((underlying,), force_refresh=False).get(underlying, {})
            current_price = quote.get("price")
            if current_price is None:
                current_price = fetch_latest_price(underlying, force_refresh=True)
            price_source_caption = f"Current stock price: {format_price(current_price)} · Source: {quote.get('source', 'latest quote')}"
            st.caption(price_source_caption)
        else:
            st.caption("Choose or type an underlying first, for example QQQ.")

        candidate = None
        candidate_metrics = None
        if underlying and current_price and current_price > 0:
            if strike_selection_method == "Delta Target":
                candidate, candidate_error = build_delta_based_candidate(
                    underlying=underlying,
                    current_price=current_price,
                    outlook=outlook,
                    expiration=str(expiration),
                    target_short_delta_abs=target_short_delta_abs,
                    wing_width=wing_width,
                    contracts=contracts,
                    strike_increment=strike_increment,
                    profit_target_pct=profit_target_pct,
                )
                if candidate_error:
                    st.warning(candidate_error)
                    candidate = build_strategy_candidate(
                        underlying=underlying,
                        underlying_price=current_price,
                        outlook=outlook,
                        expiration=str(expiration),
                        short_distance_pct=short_distance_pct,
                        wing_width=wing_width,
                        contracts=contracts,
                        strike_increment=strike_increment,
                        profit_target_pct=profit_target_pct,
                        notes="Builder candidate. Fell back to percent distance because delta-based selection was unavailable.",
                    )
            else:
                candidate = build_strategy_candidate(
                    underlying=underlying,
                    underlying_price=current_price,
                    outlook=outlook,
                    expiration=str(expiration),
                    short_distance_pct=short_distance_pct,
                    wing_width=wing_width,
                    contracts=contracts,
                    strike_increment=strike_increment,
                    profit_target_pct=profit_target_pct,
                )
            candidate_metrics = calculate_strategy_metrics(candidate)

            preview_rows = []
            for leg in candidate.get("legs", []):
                preview_rows.append(
                    {
                        "Leg": format_builder_leg_label(leg),
                        "Contracts": leg.get("contracts"),
                        "Contract Symbol": build_option_contract_symbol(
                            underlying,
                            str(expiration),
                            leg.get("option_type"),
                            leg.get("strike"),
                        ),
                    }
                )
            if preview_rows:
                st.markdown("**Candidate legs**")
                st.dataframe(pd.DataFrame(preview_rows), use_container_width=True, hide_index=True)

            if outlook == "Neutral":
                st.caption("Neutral builder creates a 4-leg Iron Condor: long put protection, short put, short call, long call protection.")
            elif outlook == "Bullish":
                st.caption("Bullish builder creates a Put Credit Spread: sell put, buy lower-strike put protection.")
            else:
                st.caption("Bearish builder creates a Call Credit Spread: sell call, buy higher-strike call protection.")

        save_col_1, save_col_2 = st.columns([1, 2])
        with save_col_1:
            save_candidate = st.button(
                "Save Candidate + Fetch Premiums",
                type="primary",
                use_container_width=True,
                disabled=not bool(candidate and candidate.get("legs")),
                key="builder_save_candidate",
            )

        with save_col_2:
            st.caption(
                "When saved, the app fetches Alpaca option snapshots and fills estimated entry premiums. "
                "Buy legs prefer ask to open; sell legs prefer bid to open. P/L uses conservative close pricing."
            )

        if save_candidate:
            if not underlying:
                st.error("Underlying is required.")
                return
            if not candidate or not candidate.get("legs"):
                st.error("Could not generate option legs. Check current price and builder settings.")
                return

            contract_symbols = get_strategy_contract_symbols(candidate)
            if not contract_symbols:
                st.error("Could not generate contract symbols. Check expiration, strike, and call/put settings.")
                return

            with st.spinner("Fetching option snapshots and building strategy..."):
                snapshots = refresh_option_snapshots(contract_symbols)
                candidate = apply_builder_snapshots_to_entry_and_current(candidate, snapshots)

            valid_legs = []
            for leg in candidate.get("legs", []):
                if safe_float(leg.get("contracts"), 0.0) <= 0 or safe_float(leg.get("strike"), 0.0) <= 0:
                    continue
                # If the snapshot did not provide any usable premium, keep the leg but use 0 so diagnostics show why.
                valid_legs.append(leg)
            candidate["legs"] = valid_legs

            if underlying_mode == "Manual" and add_to_watchlist and underlying not in st.session_state.watchlist:
                st.session_state.watchlist.append(underlying)
                st.session_state.watchlist = sorted(list(dict.fromkeys(st.session_state.watchlist)))
                save_app_settings()

            st.session_state.option_strategies = upsert_strategy(
                getattr(st.session_state, "option_strategies", []),
                candidate,
            )
            save_option_strategies(st.session_state.option_strategies)
            st.success(f"Builder candidate saved: {candidate.get('name')}.")
            st.rerun()


def render_add_option_strategy_form():
    st.subheader("Add Option Strategy")

    observed_symbols = get_observed_symbols()

    with st.form("add_option_strategy_form", clear_on_submit=False):
        col_1, col_2, col_3, col_4 = st.columns([1.2, 1, 1, 1])

        with col_1:
            strategy_name = st.text_input(
                "Strategy Name",
                value="",
                placeholder="Example: MU 170/180 Call Spread",
            )

        with col_2:
            if observed_symbols:
                underlying_mode = st.radio(
                    "Underlying Input",
                    options=["Select", "Manual"],
                    horizontal=True,
                    key="option_underlying_input_mode",
                    help="Select from watched/held tickers, or manually type a new underlying.",
                )
            else:
                underlying_mode = "Manual"
                st.caption("No watched or held tickers found. Manual input is enabled.")

        with col_3:
            add_underlying_to_watchlist = False
            if underlying_mode == "Manual":
                manual_underlying = st.text_input(
                    "Manual Underlying",
                    value="",
                    placeholder="Example: MU",
                    key="option_manual_underlying",
                    help="Type a stock ticker. It will be normalized to uppercase when saved.",
                )
                underlying = normalize_symbol(manual_underlying)

                if underlying:
                    if underlying in st.session_state.watchlist:
                        st.caption(f"{underlying} is already in watchlist.")
                    else:
                        add_underlying_to_watchlist = st.checkbox(
                            "Add to watchlist",
                            value=True,
                            key="option_manual_add_to_watchlist",
                            help="Keep this checked if you want the underlying to appear on Dashboard watchlist.",
                        )
                else:
                    st.caption("Type a ticker symbol, for example MU or NVDA.")
            else:
                underlying = st.selectbox(
                    "Underlying",
                    options=observed_symbols,
                    key="option_select_underlying",
                    help="Select from Dashboard watchlist / displayed tickers / current stock holdings.",
                )

        with col_4:
            strategy_type = st.selectbox("Strategy Type", options=STRATEGY_TYPES, index=STRATEGY_TYPES.index("Custom"))

        col_5, col_6, col_7 = st.columns(3)

        with col_5:
            expiration, expiration_source = render_alpaca_expiration_selector("manual_option", underlying)

        with col_6:
            profit_target_pct = st.number_input(
                "Profit Target %",
                min_value=0.0,
                value=float(DEFAULT_OPTIONS_PROFIT_TARGET_PCT),
                step=5.0,
                help="For credit strategies this is profit captured %. For debit strategies this is return on debit %.",
            )

        with col_7:
            leg_count = st.number_input("Number of Legs", min_value=1, max_value=4, value=1, step=1)

        st.caption(
            "Option Snapshot v1: save the strategy first, then use Refresh Option Snapshots in Update / Review to pull bid/ask/latest trade, IV, and Greeks."
        )

        legs = []
        for index in range(int(leg_count)):
            st.markdown(f"**Leg {index + 1}**")
            leg_col_1, leg_col_2, leg_col_3, leg_col_4, leg_col_5, leg_col_6 = st.columns([1, 1, 1, 1, 1, 1])

            with leg_col_1:
                action = st.selectbox(
                    "Action",
                    options=["Buy", "Sell"],
                    key=f"option_leg_{index}_action",
                )

            with leg_col_2:
                option_type = st.selectbox(
                    "Call / Put",
                    options=["Call", "Put"],
                    key=f"option_leg_{index}_type",
                )

            with leg_col_3:
                strike = st.number_input(
                    "Strike",
                    min_value=0.0,
                    step=0.5,
                    key=f"option_leg_{index}_strike",
                )

            with leg_col_4:
                contracts = st.number_input(
                    "Contracts",
                    min_value=0.0,
                    value=1.0,
                    step=1.0,
                    key=f"option_leg_{index}_contracts",
                )

            with leg_col_5:
                entry_premium = st.number_input(
                    "Entry Premium",
                    min_value=0.0,
                    step=0.01,
                    key=f"option_leg_{index}_entry",
                )

            with leg_col_6:
                current_premium = st.number_input(
                    "Current Premium",
                    min_value=0.0,
                    step=0.01,
                    key=f"option_leg_{index}_current",
                    help="For v1 this is manual. If left at 0, it will default to entry premium when saved.",
                )

            legs.append(
                {
                    "action": action,
                    "option_type": option_type,
                    "strike": strike,
                    "contracts": contracts,
                    "entry_premium": entry_premium,
                    "current_premium": current_premium if current_premium > 0 else entry_premium,
                }
            )

        notes = st.text_area(
            "Notes",
            value="",
            placeholder="Example: aiming to close at 60% profit captured",
            key="option_strategy_notes",
        )

        submitted = st.form_submit_button("Save Option Strategy", type="primary")

        if submitted:
            underlying = normalize_symbol(underlying)

            if not underlying:
                st.error("Underlying symbol is required.")
                return

            valid_legs = []
            for leg in legs:
                if leg["contracts"] <= 0 or leg["strike"] <= 0 or leg["entry_premium"] <= 0:
                    continue
                valid_legs.append(leg)

            if not valid_legs:
                st.error("At least one valid leg is required. Contracts, strike, and entry premium must be greater than 0.")
                return

            if underlying_mode == "Manual" and add_underlying_to_watchlist and underlying not in st.session_state.watchlist:
                st.session_state.watchlist.append(underlying)
                st.session_state.watchlist = sorted(list(dict.fromkeys(st.session_state.watchlist)))
                save_app_settings()

            if not strategy_name.strip():
                strategy_name = f"{underlying} {strategy_type} {expiration}"

            strategy = {
                "name": strategy_name.strip(),
                "underlying": underlying,
                "strategy_type": strategy_type,
                "expiration": str(expiration),
                "profit_target_pct": profit_target_pct,
                "notes": notes,
                "legs": valid_legs,
            }

            st.session_state.option_strategies = upsert_strategy(
                getattr(st.session_state, "option_strategies", []),
                strategy,
            )
            save_option_strategies(st.session_state.option_strategies)
            st.success(f"Option strategy saved: {strategy_name}.")
            st.rerun()


def render_option_strategy_details(default_filter: str = "Open only"):
    strategies = getattr(st.session_state, "option_strategies", [])

    if not strategies:
        return

    st.subheader("Review / Update / Close Strategy")
    review_filter = st.radio(
        "Review filter",
        options=["Open only", "Closed only", "All"],
        index=["Open only", "Closed only", "All"].index(default_filter) if default_filter in ["Open only", "Closed only", "All"] else 0,
        horizontal=True,
        key="option_strategy_review_filter",
        help="Use Open only for daily management. Closed only is mainly for checking realized P/L history or reopening a mistaken close.",
    )

    if review_filter == "Open only":
        review_strategies = [strategy for strategy in strategies if not is_strategy_closed(strategy)]
    elif review_filter == "Closed only":
        review_strategies = [strategy for strategy in strategies if is_strategy_closed(strategy)]
    else:
        review_strategies = strategies

    if not review_strategies:
        st.info(f"No strategies match: {review_filter}.")
        return

    strategy_labels = {
        strategy.get("id"): f"{strategy.get('name', 'Unnamed')} · {strategy.get('underlying', '')} · {strategy.get('expiration', '')}"
        for strategy in review_strategies
    }
    strategy_ids = list(strategy_labels.keys())
    selected_id = st.selectbox(
        "Strategy",
        options=strategy_ids,
        format_func=lambda strategy_id: strategy_labels.get(strategy_id, strategy_id),
        key="option_strategy_review_select",
    )

    selected_strategy = None
    for strategy in strategies:
        if strategy.get("id") == selected_id:
            selected_strategy = strategy
            break

    if not selected_strategy:
        return

    metrics = calculate_strategy_display_metrics(selected_strategy)
    closed = is_strategy_closed(selected_strategy)

    if closed:
        st.success(f"Closed strategy · Closed at {metrics.get('closed_at_et', 'N/A')} · Realized P/L {format_price(metrics.get('realized_pl'))}")
        if metrics.get("close_notes"):
            st.caption("Close notes: " + str(metrics.get("close_notes")))

    metric_col_1, metric_col_2, metric_col_3, metric_col_4 = st.columns(4)
    with metric_col_1:
        st.metric("Entry Type", metrics.get("entry_type", "N/A"))
    with metric_col_2:
        st.metric("Entry Cash Flow", format_price(metrics.get("entry_cash_flow")))
    with metric_col_3:
        if closed:
            st.metric("Realized P/L", format_price(metrics.get("realized_pl")))
        else:
            st.metric("Unrealized P/L", format_price(metrics.get("unrealized_pl")))
    with metric_col_4:
        st.metric(metrics.get("progress_label", "Profit Progress"), format_pct(metrics.get("profit_progress_pct")))

    risk_col_1, risk_col_2, risk_col_3 = st.columns(3)
    with risk_col_1:
        st.metric("Est. Max Profit", format_option_risk_value(metrics.get("max_profit_label")))
    with risk_col_2:
        st.metric("Est. Max Loss", format_option_risk_value(metrics.get("max_loss_label")))
    with risk_col_3:
        st.metric("Break-even(s)", metrics.get("breakeven_label", "N/A"))
    st.caption(metrics.get("risk_note", "Risk estimate is based on expiration payoff and entry premiums."))

    if closed:
        st.caption(
            f"Closed realized progress: {format_pct(metrics.get('profit_progress_pct'))}. "
            f"Target was {format_pct(metrics.get('profit_target_pct'))}. Close fees: {format_price(metrics.get('close_fees', 0.0))}."
        )
    elif metrics.get("target_hit"):
        st.success(f"Profit target reached: {format_pct(metrics.get('profit_progress_pct'))} vs target {format_pct(metrics.get('profit_target_pct'))}.")
    else:
        st.caption(f"Target: {format_pct(metrics.get('profit_target_pct'))}. Current progress: {format_pct(metrics.get('profit_progress_pct'))}.")

    contract_symbols = get_strategy_contract_symbols(selected_strategy)
    snapshot_status = get_option_snapshot_cache_status(contract_symbols)

    snapshot_col_1, snapshot_col_2, snapshot_col_3, snapshot_col_4 = st.columns([1, 1, 1.4, 1.2])
    with snapshot_col_1:
        st.metric("Option Snapshots", f"{snapshot_status.get('cached_count', 0)}/{snapshot_status.get('requested_count', 0)}")
    with snapshot_col_2:
        st.metric("Oldest Snapshot", format_age(snapshot_status.get("oldest_age_seconds")))
    with snapshot_col_3:
        st.metric("Option Feed", snapshot_status.get("feed_summary") if snapshot_status.get("feed_summary") != "N/A" else ALPACA_OPTIONS_FEED)
    with snapshot_col_4:
        if st.button("Refresh Option Snapshots", use_container_width=True, disabled=(not bool(contract_symbols) or closed)):
            snapshots = refresh_option_snapshots(contract_symbols)
            st.session_state.option_strategies = update_strategy_from_option_snapshots(
                st.session_state.option_strategies,
                selected_id,
                snapshots,
            )
            save_option_strategies(st.session_state.option_strategies)
            st.success("Option snapshots refreshed and current premiums updated.")
            st.rerun()

    if contract_symbols:
        st.caption(
            "Contract symbols: " + ", ".join(contract_symbols)
            + (". Strategy is closed; saved close premiums are used for realized P/L." if closed else ". Current premium uses conservative close pricing: long legs prefer bid; short legs prefer ask.")
        )
    else:
        st.caption("Contract symbols could not be generated yet. Check underlying, expiration, call/put, and strike.")

    if ALPACA_OPTIONS_FEED == "indicative":
        st.info("Options feed is set to indicative. Premiums can be missing or stale; use manual broker fill prices for final realized P/L.")

    legs_df = pd.DataFrame(metrics.get("legs", []))
    if not legs_df.empty:
        leg_cols = [
            "contract_symbol",
            "action",
            "option_type",
            "strike",
            "contracts",
            "entry_premium",
            "current_premium",
            "close_premium",
            "bid",
            "ask",
            "last",
            "mid",
            "implied_volatility",
            "delta",
            "theta",
            "vega",
            "entry_value",
            "current_value",
            "close_value",
            "unrealized_pl",
            "realized_pl",
            "unrealized_pl_pct",
            "realized_pl_pct",
            "data_quality",
            "data_quality_detail",
            "bid_ask_spread_pct",
            "option_snapshot_status",
            "option_snapshot_updated_at_et",
        ]
        legs_df = legs_df[[col for col in leg_cols if col in legs_df.columns]].copy()

        for col in ["entry_premium", "current_premium", "close_premium", "bid", "ask", "last", "mid", "entry_value", "current_value", "close_value", "unrealized_pl", "realized_pl"]:
            if col in legs_df.columns:
                legs_df[col] = legs_df[col].apply(lambda x: format_price(x) if pd.notna(x) else "N/A")

        if "implied_volatility" in legs_df.columns:
            legs_df["implied_volatility"] = legs_df["implied_volatility"].apply(format_option_iv)

        for col in ["delta", "theta", "vega"]:
            if col in legs_df.columns:
                legs_df[col] = legs_df[col].apply(format_greek)

        if "unrealized_pl_pct" in legs_df.columns:
            legs_df["unrealized_pl_pct"] = legs_df["unrealized_pl_pct"].apply(lambda x: format_pct(x) if pd.notna(x) else "N/A")
        if "realized_pl_pct" in legs_df.columns:
            legs_df["realized_pl_pct"] = legs_df["realized_pl_pct"].apply(lambda x: format_pct(x) if pd.notna(x) else "N/A")
        if "bid_ask_spread_pct" in legs_df.columns:
            legs_df["bid_ask_spread_pct"] = legs_df["bid_ask_spread_pct"].apply(lambda x: format_pct(x) if pd.notna(x) else "N/A")

        legs_df = legs_df.rename(
            columns={
                "contract_symbol": "Contract",
                "action": "Side",
                "option_type": "Type",
                "strike": "Strike",
                "contracts": "Qty",
                "entry_premium": "Entry",
                "current_premium": "Close Est.",
                "close_premium": "Close Actual",
                "bid": "Bid",
                "ask": "Ask",
                "last": "Last",
                "mid": "Mid",
                "implied_volatility": "IV",
                "delta": "Delta",
                "theta": "Theta",
                "vega": "Vega",
                "entry_value": "Entry Value",
                "current_value": "Close Value",
                "close_value": "Close Actual Value",
                "unrealized_pl": "P/L",
                "realized_pl": "Realized P/L",
                "unrealized_pl_pct": "P/L %",
                "realized_pl_pct": "Realized P/L %",
                "data_quality": "Data Quality",
                "data_quality_detail": "Quality Detail",
                "bid_ask_spread_pct": "Spread %",
                "option_snapshot_status": "Snapshot",
                "option_snapshot_updated_at_et": "Updated",
            }
        )
        preferred_leg_cols = [
            "Contract", "Side", "Type", "Strike", "Qty", "Entry", "Close Est.", "Close Actual",
            "Bid", "Ask", "Last", "Mid", "IV", "Delta", "Theta", "Vega",
            "Entry Value", "Close Value", "Close Actual Value", "P/L", "Realized P/L", "P/L %", "Realized P/L %", "Data Quality", "Spread %", "Snapshot", "Updated",
        ]
        legs_df = legs_df[[col for col in preferred_leg_cols if col in legs_df.columns]]

        st.dataframe(legs_df, use_container_width=True, hide_index=True)

    with st.expander("Option Snapshot Diagnostics", expanded=False):
        st.caption("This debug panel stays collapsed so it does not take dashboard space. Use it when prices look wrong or snapshots fail.")
        diagnostic_rows = []
        for leg in metrics.get("legs", []):
            diagnostic_rows.append(
                {
                    "Contract": leg.get("contract_symbol") or build_option_contract_symbol(
                        metrics.get("underlying"),
                        metrics.get("expiration"),
                        leg.get("option_type"),
                        leg.get("strike"),
                    ),
                    "Status": leg.get("option_snapshot_status"),
                    "Method": leg.get("option_price_method"),
                    "Feed": leg.get("option_snapshot_feed"),
                    "Quote Time": leg.get("option_quote_timestamp"),
                    "Trade Time": leg.get("option_trade_timestamp"),
                    "Error": leg.get("option_error"),
                }
            )
        if diagnostic_rows:
            st.dataframe(pd.DataFrame(diagnostic_rows), use_container_width=True, hide_index=True)
        else:
            st.info("No option legs to diagnose.")

    if not closed:
        with st.form(f"update_option_premiums_{selected_id}", clear_on_submit=False):
            st.markdown("**Manual Current Premium Override**")
            st.caption("Use this if Alpaca snapshot data is unavailable or you want to override the automatic close premium.")
            current_premiums = []
            for index, leg in enumerate(metrics.get("legs", [])):
                label = f"Leg {index + 1}: {leg.get('action')} {leg.get('option_type')} {leg.get('strike')}"
                premium = st.number_input(
                    label,
                    min_value=0.0,
                    value=float(leg.get("current_premium", 0.0)),
                    step=0.01,
                    key=f"option_current_premium_{selected_id}_{index}",
                )
                current_premiums.append(premium)

            update_submitted = st.form_submit_button("Update Current Premiums")

            if update_submitted:
                st.session_state.option_strategies = update_strategy_leg_premiums(
                    st.session_state.option_strategies,
                    selected_id,
                    current_premiums,
                )
                save_option_strategies(st.session_state.option_strategies)
                st.success("Current premiums updated.")
                st.rerun()

        with st.expander("Close Strategy / Record Realized P/L", expanded=bool(metrics.get("target_hit"))):
            st.caption(
                "Use this when you actually close the option trade. Defaults use the current close estimates, "
                "but you can enter the real broker fill premiums before saving."
            )
            if metrics.get("target_hit"):
                st.success(f"Profit target reached: {format_pct(metrics.get('profit_progress_pct'))}. Consider recording the close after execution.")

            with st.form(f"close_option_strategy_{selected_id}", clear_on_submit=False):
                close_premiums = []
                for index, leg in enumerate(metrics.get("legs", [])):
                    close_side = "Buy back" if leg.get("action") == "Sell" else "Sell to close"
                    label = f"Leg {index + 1} Close Premium · {close_side} {leg.get('option_type')} {leg.get('strike')}"
                    premium = st.number_input(
                        label,
                        min_value=0.0,
                        value=float(leg.get("current_premium", 0.0)),
                        step=0.01,
                        key=f"option_close_premium_{selected_id}_{index}",
                    )
                    close_premiums.append(premium)

                close_fees = st.number_input(
                    "Closing fees / commission",
                    min_value=0.0,
                    value=0.0,
                    step=0.01,
                    key=f"option_close_fees_{selected_id}",
                )
                close_notes = st.text_area(
                    "Close notes",
                    value="",
                    placeholder="Example: Closed at 70% profit target; broker fill confirmed.",
                    key=f"option_close_notes_{selected_id}",
                )
                confirm_close = st.checkbox(
                    "I confirm this strategy was closed in my broker and I want to record realized P/L",
                    value=False,
                    key=f"confirm_close_option_strategy_{selected_id}",
                )
                close_submitted = st.form_submit_button("Close Strategy and Save Realized P/L", type="primary", disabled=not confirm_close)

                if close_submitted:
                    st.session_state.option_strategies = close_strategy(
                        st.session_state.option_strategies,
                        selected_id,
                        close_premiums,
                        close_fees=close_fees,
                        close_notes=close_notes,
                    )
                    save_option_strategies(st.session_state.option_strategies)
                    st.success("Option strategy closed and realized P/L saved.")
                    st.rerun()
    else:
        with st.expander("Closed Strategy Details", expanded=False):
            st.caption("This local strategy is closed. Saved close premiums are used for realized P/L and snapshots are no longer updated.")
            if st.button("Reopen Strategy", use_container_width=True):
                st.session_state.option_strategies = reopen_strategy(st.session_state.option_strategies, selected_id)
                save_option_strategies(st.session_state.option_strategies)
                st.success("Strategy reopened.")
                st.rerun()

    with st.expander("Delete Option Strategy", expanded=False):
        st.warning("Deleting an option strategy removes it from the local tracker. It does not affect stock holdings or transactions.")
        confirm_delete = st.checkbox(
            f"I understand and want to delete {metrics.get('name', 'this strategy')}",
            value=False,
            key=f"delete_option_strategy_{selected_id}",
        )
        if st.button("Delete Selected Option Strategy", disabled=not confirm_delete, use_container_width=True):
            st.session_state.option_strategies = remove_strategy(st.session_state.option_strategies, selected_id)
            save_option_strategies(st.session_state.option_strategies)
            st.success("Option strategy deleted.")
            st.rerun()


def _format_option_strategy_summary_df(strategies: list[dict], preferred_cols: list[str] | None = None) -> pd.DataFrame:
    df = strategies_to_dataframe(strategies)
    if df.empty:
        return df

    display_df = df.drop(columns=["id"], errors="ignore").copy()

    for col in ["Entry Cash Flow", "Current Close Cash Flow", "Unrealized P/L", "Realized P/L"]:
        if col in display_df.columns:
            display_df[col] = display_df[col].apply(lambda x: format_price(x) if pd.notna(x) else "N/A")

    for col in ["Max Profit", "Max Loss"]:
        if col in display_df.columns:
            display_df[col] = display_df[col].apply(format_option_risk_value)

    for col in ["Profit Progress %", "Target %"]:
        if col in display_df.columns:
            display_df[col] = display_df[col].apply(lambda x: format_pct(x) if pd.notna(x) else "N/A")

    display_df = display_df.rename(
        columns={
            "Type": "Strategy",
            "Entry Cash Flow": "Net Entry",
            "Current Close Cash Flow": "Close Value",
            "Unrealized P/L": "P/L",
            "Profit Progress %": "Progress",
            "Snapshot Status": "Snapshot",
        }
    )

    if preferred_cols:
        display_df = display_df[[col for col in preferred_cols if col in display_df.columns]]

    return display_df


def render_options_open_strategies_panel():
    strategies = getattr(st.session_state, "option_strategies", [])
    open_strategies = [strategy for strategy in strategies if not is_strategy_closed(strategy)]

    st.subheader("Open Strategies")
    if not open_strategies:
        st.info("No open option strategies. Use Add / Build Strategy to create one.")
        return

    df = strategies_to_dataframe(open_strategies)
    target_hits = int((df.get("Alert") == "Target Hit").sum()) if "Alert" in df.columns else 0
    needs_manual = int(df.get("Data Quality", pd.Series(dtype=str)).isin(["Needs manual price", "Wide spread", "Last trade only"]).sum()) if "Data Quality" in df.columns else 0

    col_1, col_2, col_3 = st.columns(3)
    with col_1:
        st.metric("Open Strategies", len(open_strategies))
    with col_2:
        st.metric("Target Hit", target_hits)
    with col_3:
        st.metric("Needs Price Check", needs_manual)

    preferred_cols = [
        "Name", "Underlying", "Strategy", "Expiration", "Entry Type", "Net Entry", "Close Value",
        "P/L", "Progress", "Target %", "Data Quality", "Snapshot", "Alert", "Updated",
    ]
    display_df = _format_option_strategy_summary_df(open_strategies, preferred_cols)
    st.dataframe(display_df, use_container_width=True, hide_index=True)
    st.caption(
        "Estimated P/L uses current close estimates from Alpaca snapshots or manual overrides. "
        "Realized P/L should be recorded from actual broker fill prices when you close."
    )


def render_options_closed_strategies_panel():
    strategies = getattr(st.session_state, "option_strategies", [])
    closed_strategies = [strategy for strategy in strategies if is_strategy_closed(strategy)]

    st.subheader("Closed / Realized Options P&L")
    if not closed_strategies:
        st.info("No closed option strategies recorded yet.")
        return

    total_realized = 0.0
    for strategy in closed_strategies:
        metrics = calculate_strategy_display_metrics(strategy)
        total_realized += safe_float(metrics.get("realized_pl"), 0.0)

    col_1, col_2 = st.columns(2)
    with col_1:
        st.metric("Closed Strategies", len(closed_strategies))
    with col_2:
        st.metric("Total Realized Options P/L", format_price(total_realized))

    preferred_cols = [
        "Name", "Underlying", "Strategy", "Expiration", "Entry Type", "Net Entry", "Close Value",
        "Realized P/L", "Progress", "Target %", "Closed At", "Updated",
    ]
    display_df = _format_option_strategy_summary_df(closed_strategies, preferred_cols)
    st.dataframe(display_df, use_container_width=True, hide_index=True)
    st.caption("Closed strategies remain in local history and are not refreshed by option snapshots.")


def render_options_data_quality_notes():
    with st.expander("Options data quality notes", expanded=False):
        st.markdown(
            """
**Estimated P/L** is only as good as the premium source for each leg.

- **Bid/Ask available / OK**: best available tracker estimate; still confirm with broker before trading.
- **Wide spread**: bid/ask is available but noisy; P/L estimate can jump a lot.
- **Last trade only**: no full quote; latest trade may be stale.
- **No premium / No live premium**: Alpaca did not return a usable premium; enter a manual premium or refresh later.
- **Manual override**: you entered the premium manually; use broker fills as the final source of truth.

With `ALPACA_OPTIONS_FEED=indicative`, missing put/call premium is expected sometimes. MarketAgentPro should track the trade even when Alpaca data is incomplete.
"""
        )


def render_options_tab():
    st.subheader("Options Strategies")
    st.caption(
        "Options v2 focuses on open strategy management, manual broker-price tracking, close/realized P&L, and separate data tools. "
        "Alpaca option snapshots are used as estimates, not as the final source of truth."
    )

    if ALPACA_OPTIONS_FEED == "indicative":
        st.info(
            "Options feed: indicative. Put/call premiums can be missing, delayed, or incomplete. "
            "Use Refresh Option Snapshots for estimates and manual broker fill prices for realized P/L."
        )

    render_options_data_quality_notes()

    tab_open, tab_add, tab_tools, tab_closed = st.tabs(
        ["Open Strategies", "Add / Build Strategy", "Option Data Tools", "Closed / Realized P&L"]
    )

    with tab_open:
        render_options_open_strategies_panel()
        st.divider()
        render_option_strategy_details(default_filter="Open only")

    with tab_add:
        add_tab_builder, add_tab_manual = st.tabs(["Strategy Builder", "Manual Entry"])
        with add_tab_builder:
            render_options_strategy_builder()
        with add_tab_manual:
            render_add_option_strategy_form()

    with tab_tools:
        st.caption(
            "These tools are for research/reference. They do not change open strategy P/L unless you explicitly save or refresh a strategy."
        )
        render_option_chain_picker()
        st.divider()
        render_option_volume_reference()

    with tab_closed:
        render_options_closed_strategies_panel()

def render_portfolio_page():
    st.title("💼 Portfolio")

    render_portfolio_profile_selector()

    auto_save_daily_snapshot()

    st.caption(
        "Portfolio manages holdings, alerts, transactions, realized P/L, options strategies, and snapshot history locally. "
        "Dashboard now focuses on charts, alert status, and AI analysis."
    )

    tab_summary, tab_holdings, tab_transactions, tab_realized, tab_options, tab_history = st.tabs(
        ["Summary", "Holdings", "Transactions", "Realized P/L", "Options Strategies", "History"]
    )

    with tab_summary:
        render_portfolio_summary_tab()

    with tab_holdings:
        render_holdings_tab()

    with tab_transactions:
        render_transaction_tab()

    with tab_realized:
        render_realized_pl_tab()

    with tab_options:
        render_options_tab()

    with tab_history:
        render_history_tab()
