import pandas as pd
import streamlit as st

try:
    import plotly.graph_objects as go
    from plotly.subplots import make_subplots
    HAS_PLOTLY = True
except Exception:
    HAS_PLOTLY = False

from marketagent.utils import format_pct, format_price, format_volume, nullable_float


TWO_DAY_OFFSET_KEY = "two_day_window_offset"
TWO_DAY_VIEW_MODE_KEY = "two_day_view_mode"


TWO_DAY_VIEW_MODES = ["Overlay Comparison", "Split View"]
MONTHLY_CHART_STYLE_KEY = "month_week_chart_style"
MONTHLY_CHART_STYLES = ["Candlestick", "Line"]




def _should_remove_non_trading_gaps(chart_view: str | None) -> bool:
    """Return True for longer daily views where calendar gaps make charts look disconnected."""
    return chart_view in {"Month", "52 Weeks"}


def _use_trading_day_category_axis(chart_view: str | None) -> bool:
    """Compress Month / 52 Weeks to actual trading rows only.

    Plotly date axes leave calendar gaps by default. Weekend rangebreaks remove
    only Saturdays/Sundays, but market holidays and some missing daily rows can
    still leave visible spaces. For daily trading views, a category axis is more
    like many broker charts: every available trading day is one equal step, with
    no weekend/holiday gaps.
    """
    return _should_remove_non_trading_gaps(chart_view)


def _make_trading_day_plot_data(chart_data: pd.DataFrame, chart_view: str | None) -> pd.DataFrame:
    """Return plotting data with compressed trading-day labels for long daily charts."""
    if chart_data is None or chart_data.empty or not _use_trading_day_category_axis(chart_view):
        return chart_data

    plot_data = chart_data.copy()

    if isinstance(plot_data.index, pd.DatetimeIndex):
        plot_data.index = plot_data.index.strftime("%Y-%m-%d")
    else:
        plot_data.index = plot_data.index.astype(str)

    return plot_data


def _apply_daily_trading_axis(fig, chart_view: str | None):
    """Compress daily Month / 52 Weeks charts to available trading days only."""
    if not _use_trading_day_category_axis(chart_view):
        return

    fig.update_xaxes(type="category")

def get_trading_dates(data: pd.DataFrame) -> list:
    if data is None or data.empty or not isinstance(data.index, pd.DatetimeIndex):
        return []

    return sorted(list(pd.Series(data.index.date).dropna().unique()))


def get_two_day_window(data: pd.DataFrame, offset: int = 0) -> dict:
    """
    Returns a rolling two-trading-day window.

    offset = 0 means latest available pair: previous trading day + latest trading day.
    offset = 1 means one pair earlier.
    """
    empty_result = {
        "left_data": pd.DataFrame(),
        "right_data": pd.DataFrame(),
        "left_date": None,
        "right_date": None,
        "offset": 0,
        "max_offset": 0,
        "dates_count": 0,
    }

    if data is None or data.empty or not isinstance(data.index, pd.DatetimeIndex):
        return empty_result

    dates = get_trading_dates(data)

    if not dates:
        return empty_result

    if len(dates) == 1:
        latest_date = dates[-1]
        return {
            "left_data": pd.DataFrame(),
            "right_data": data[data.index.date == latest_date],
            "left_date": None,
            "right_date": latest_date,
            "offset": 0,
            "max_offset": 0,
            "dates_count": len(dates),
        }

    max_offset = max(len(dates) - 2, 0)
    safe_offset = min(max(int(offset or 0), 0), max_offset)

    right_index = len(dates) - 1 - safe_offset
    left_index = right_index - 1

    left_date = dates[left_index]
    right_date = dates[right_index]

    return {
        "left_data": data[data.index.date == left_date],
        "right_data": data[data.index.date == right_date],
        "left_date": left_date,
        "right_date": right_date,
        "offset": safe_offset,
        "max_offset": max_offset,
        "dates_count": len(dates),
    }


def get_visible_chart_data(chart_data: pd.DataFrame, chart_view: str) -> pd.DataFrame:
    """Return the exact data currently shown on the chart.

    For 2 Days, raw history fetches 10d, but the UI only shows one rolling
    two-day window. This function returns only that displayed window.
    """
    if chart_data is None or chart_data.empty:
        return pd.DataFrame()

    if chart_view != "2 Days":
        return chart_data

    window_info = get_two_day_window(
        chart_data,
        offset=st.session_state.get(TWO_DAY_OFFSET_KEY, 0),
    )

    pieces = []
    left_data = window_info.get("left_data")
    right_data = window_info.get("right_data")

    if left_data is not None and not left_data.empty:
        pieces.append(left_data)

    if right_data is not None and not right_data.empty:
        pieces.append(right_data)

    if not pieces:
        return pd.DataFrame()

    return pd.concat(pieces).sort_index()


def _format_time_axis(data: pd.DataFrame) -> pd.Series:
    """Normalize timestamps to the same dummy date so sessions share x values."""
    if data is None or data.empty:
        return pd.Series(dtype="datetime64[ns]")

    return pd.Series(
        [pd.Timestamp.combine(pd.Timestamp("2000-01-01").date(), ts.time()) for ts in data.index],
        index=data.index,
    )


def _format_original_time(data: pd.DataFrame) -> list:
    if data is None or data.empty:
        return []

    labels = []
    for ts in data.index:
        try:
            labels.append(ts.strftime("%Y-%m-%d %H:%M:%S ET"))
        except Exception:
            labels.append(str(ts))

    return labels


def get_displayed_price_levels(chart_data: pd.DataFrame, chart_style: str | None = "Line") -> dict:
    """High/low of the data that is actually drawn on the chart.

    Line mode draws Close, so headline levels use Close high/low.
    Candlestick mode draws OHLC, so headline levels use High/Low wick values.
    """
    if chart_data is None or chart_data.empty:
        return {"displayed_high": None, "displayed_low": None}

    style = (chart_style or "Line").strip().lower()

    if style == "candlestick" and {"High", "Low"}.issubset(set(chart_data.columns)):
        high = pd.to_numeric(chart_data["High"], errors="coerce").dropna()
        low = pd.to_numeric(chart_data["Low"], errors="coerce").dropna()

        if not high.empty and not low.empty:
            return {
                "displayed_high": nullable_float(high.max()),
                "displayed_low": nullable_float(low.min()),
            }

    if "Close" not in chart_data.columns:
        return {"displayed_high": None, "displayed_low": None}

    close = pd.to_numeric(chart_data["Close"], errors="coerce").dropna()
    if close.empty:
        return {"displayed_high": None, "displayed_low": None}

    return {
        "displayed_high": nullable_float(close.max()),
        "displayed_low": nullable_float(close.min()),
    }


def get_displayed_line_levels(chart_data: pd.DataFrame) -> dict:
    """Backward-compatible helper for line chart Close high/low."""
    return get_displayed_price_levels(chart_data, chart_style="Line")


def can_render_candlestick(chart_data: pd.DataFrame) -> bool:
    if chart_data is None or chart_data.empty:
        return False
    required = {"Open", "High", "Low", "Close"}
    return required.issubset(set(chart_data.columns))


def _get_volume_series(chart_data: pd.DataFrame) -> pd.Series:
    if chart_data is None or chart_data.empty or "Volume" not in chart_data.columns:
        return pd.Series(dtype="float64")

    volume = pd.to_numeric(chart_data["Volume"], errors="coerce").dropna()
    volume = volume[volume >= 0]
    return volume




def _get_volume_direction_parts(chart_data: pd.DataFrame) -> dict:
    """Split displayed volume into up/down/flat bars using candle direction.

    This is not true order-flow buy/sell volume. It is the common broker-style
    visual convention: green when Close >= Open, red when Close < Open.
    """
    if chart_data is None or chart_data.empty or "Volume" not in chart_data.columns:
        return {"available": False}

    if not {"Open", "Close"}.issubset(set(chart_data.columns)):
        return {"available": False}

    volume = pd.to_numeric(chart_data["Volume"], errors="coerce").fillna(0)
    open_price = pd.to_numeric(chart_data["Open"], errors="coerce")
    close_price = pd.to_numeric(chart_data["Close"], errors="coerce")

    up_mask = close_price >= open_price
    down_mask = close_price < open_price
    flat_mask = open_price.isna() | close_price.isna()

    up_volume = float(volume.where(up_mask & ~flat_mask, 0).sum())
    down_volume = float(volume.where(down_mask & ~flat_mask, 0).sum())
    unknown_volume = float(volume.where(flat_mask, 0).sum())
    total_volume = float(volume.sum())

    return {
        "available": True,
        "up_volume": up_volume,
        "down_volume": down_volume,
        "unknown_volume": unknown_volume,
        "total_volume": total_volume,
        "up_share": up_volume / total_volume if total_volume > 0 else None,
        "down_share": down_volume / total_volume if total_volume > 0 else None,
    }


def _get_volume_bar_colors(chart_data: pd.DataFrame) -> list[str]:
    if chart_data is None or chart_data.empty:
        return []

    default_color = "#A0A0A0"
    if not {"Open", "Close"}.issubset(set(chart_data.columns)):
        return [default_color for _ in range(len(chart_data))]

    open_price = pd.to_numeric(chart_data["Open"], errors="coerce")
    close_price = pd.to_numeric(chart_data["Close"], errors="coerce")
    colors = []
    for open_value, close_value in zip(open_price, close_price):
        if pd.isna(open_value) or pd.isna(close_value):
            colors.append(default_color)
        elif close_value >= open_value:
            colors.append("#00A36C")
        else:
            colors.append("#EF553B")
    return colors


def build_volume_context(chart_data: pd.DataFrame, chart_view: str | None = None) -> dict:
    """Build a compact volume context for AI analysis and chart captions.

    This intentionally does not feed Dashboard headline metrics. Volume is used
    as chart context and optional AI context only.
    """
    volume = _get_volume_series(chart_data)

    if volume.empty:
        return {
            "available": False,
            "chart_view": chart_view,
            "summary": "Volume data is unavailable for the displayed chart window.",
        }

    total_volume = float(volume.sum())
    latest_bar_volume = float(volume.iloc[-1])
    average_bar_volume = float(volume.mean()) if len(volume) else None
    latest_vs_avg = None

    if average_bar_volume and average_bar_volume > 0:
        latest_vs_avg = latest_bar_volume / average_bar_volume

    direction = "normal"
    if latest_vs_avg is not None:
        if latest_vs_avg >= 2.0:
            direction = "elevated"
        elif latest_vs_avg <= 0.5:
            direction = "light"

    summary_parts = [
        f"Displayed volume: {format_volume(total_volume)}",
        f"latest bar volume: {format_volume(latest_bar_volume)}",
    ]

    direction_parts = _get_volume_direction_parts(chart_data)
    if direction_parts.get("available") and direction_parts.get("total_volume", 0) > 0:
        up_volume = direction_parts.get("up_volume", 0.0)
        down_volume = direction_parts.get("down_volume", 0.0)
        up_share = direction_parts.get("up_share")
        down_share = direction_parts.get("down_share")
        summary_parts.append(
            f"green/up-candle volume: {format_volume(up_volume)} "
            f"({format_pct(up_share * 100) if up_share is not None else 'N/A'})"
        )
        summary_parts.append(
            f"red/down-candle volume: {format_volume(down_volume)} "
            f"({format_pct(down_share * 100) if down_share is not None else 'N/A'})"
        )

    if latest_vs_avg is not None:
        summary_parts.append(f"latest vs average: {latest_vs_avg:.2f}x ({direction})")

    return {
        "available": True,
        "chart_view": chart_view,
        "total_volume": total_volume,
        "latest_bar_volume": latest_bar_volume,
        "average_bar_volume": average_bar_volume,
        "latest_vs_avg": latest_vs_avg,
        "volume_state": direction,
        "up_candle_volume": direction_parts.get("up_volume") if direction_parts.get("available") else None,
        "down_candle_volume": direction_parts.get("down_volume") if direction_parts.get("available") else None,
        "summary": "; ".join(summary_parts) + ".",
    }


def _add_volume_trace(fig, chart_data: pd.DataFrame, row: int, col: int = 1, name: str = "Volume"):
    if chart_data is None or chart_data.empty or "Volume" not in chart_data.columns:
        return

    volume = pd.to_numeric(chart_data["Volume"], errors="coerce")
    if volume.dropna().empty:
        return

    colors = _get_volume_bar_colors(chart_data)
    custom_data = None
    if {"Open", "Close"}.issubset(set(chart_data.columns)):
        custom_data = pd.concat(
            [
                pd.to_numeric(chart_data["Open"], errors="coerce"),
                pd.to_numeric(chart_data["Close"], errors="coerce"),
            ],
            axis=1,
        ).to_numpy()

    fig.add_trace(
        go.Bar(
            x=chart_data.index,
            y=volume,
            name=name,
            marker_color=colors if colors else None,
            customdata=custom_data,
            hovertemplate=(
                "%{x}<br>Volume: %{y:,.0f}"
                "<br>Open: %{customdata[0]:.2f}"
                "<br>Close: %{customdata[1]:.2f}"
                "<extra></extra>"
            ) if custom_data is not None else "%{x}<br>Volume: %{y:,.0f}<extra></extra>",
        ),
        row=row,
        col=col,
    )


def _render_volume_summary(chart_data: pd.DataFrame, chart_view: str | None = None):
    context = build_volume_context(chart_data, chart_view=chart_view)
    if context.get("available"):
        st.caption(f"Volume context: {context.get('summary')}")


def _total_volume(chart_data: pd.DataFrame):
    volume = _get_volume_series(chart_data)
    if volume.empty:
        return None
    return float(volume.sum())


def _render_two_day_volume_summary(window_info: dict):
    left_data = window_info.get("left_data")
    right_data = window_info.get("right_data")
    left_date = window_info.get("left_date")
    right_date = window_info.get("right_date")

    left_volume = _total_volume(left_data)
    right_volume = _total_volume(right_data)

    if left_volume is None and right_volume is None:
        return

    parts = []
    if left_volume is not None:
        parts.append(f"{left_date}: {format_volume(left_volume)}")
    if right_volume is not None:
        parts.append(f"{right_date}: {format_volume(right_volume)}")

    if left_volume is not None and right_volume is not None and left_volume > 0:
        diff_pct = (right_volume - left_volume) / left_volume * 100
        parts.append(f"difference: {format_pct(diff_pct)}")

    st.caption("2 Days volume summary: " + " · ".join(parts))


def _add_displayed_high_low_lines(fig, chart_data: pd.DataFrame, row=None, col=None, chart_style: str | None = "Line"):
    levels = get_displayed_price_levels(chart_data, chart_style=chart_style)
    displayed_high = levels.get("displayed_high")
    displayed_low = levels.get("displayed_low")

    if displayed_high is not None:
        fig.add_hline(
            y=displayed_high,
            line_dash="dot",
            annotation_text=f"Displayed High {format_price(displayed_high)}",
            annotation_position="top left",
            row=row,
            col=col,
        )

    if displayed_low is not None:
        fig.add_hline(
            y=displayed_low,
            line_dash="dot",
            annotation_text=f"Displayed Low {format_price(displayed_low)}",
            annotation_position="bottom left",
            row=row,
            col=col,
        )


def _build_price_trace(chart_data: pd.DataFrame, chart_style: str | None = "Line"):
    style = (chart_style or "Line").strip().lower()

    if style == "candlestick" and can_render_candlestick(chart_data):
        return go.Candlestick(
            x=chart_data.index,
            open=chart_data["Open"],
            high=chart_data["High"],
            low=chart_data["Low"],
            close=chart_data["Close"],
            name="OHLC",
            increasing_line_color="#00A36C",
            decreasing_line_color="#EF553B",
            increasing_fillcolor="#00A36C",
            decreasing_fillcolor="#EF553B",
        )

    return go.Scatter(
        x=chart_data.index,
        y=chart_data["Close"],
        mode="lines",
        name="Close",
        hovertemplate="%{x}<br>Close: %{y:.2f}<extra></extra>",
    )


def render_single_price_chart(chart_data: pd.DataFrame, title: str, height: int = 430, show_volume: bool = True, chart_view: str | None = None, chart_style: str | None = "Line"):
    if chart_data is None or chart_data.empty:
        st.warning(f"No chart data available for {title}.")
        return

    # For Month / 52 Weeks, plot with a category x-axis so each actual trading
    # row is one equal step. This removes weekends, holidays, and other missing
    # daily-session gaps. Calculations still use the original date-indexed data.
    plot_data = _make_trading_day_plot_data(chart_data, chart_view)

    has_volume = show_volume and "Volume" in chart_data.columns and not _get_volume_series(chart_data).empty

    if HAS_PLOTLY:
        if has_volume:
            fig = make_subplots(
                rows=2,
                cols=1,
                shared_xaxes=True,
                row_heights=[0.72, 0.28],
                vertical_spacing=0.04,
                specs=[[{"type": "scatter"}], [{"type": "bar"}]],
            )
            price_row = 1
            volume_row = 2
        else:
            fig = go.Figure()
            price_row = None
            volume_row = None

        effective_style = chart_style if can_render_candlestick(chart_data) else "Line"
        price_trace = _build_price_trace(plot_data, effective_style)

        if has_volume:
            fig.add_trace(price_trace, row=price_row, col=1)
            _add_volume_trace(fig, plot_data, row=volume_row, col=1)
            _add_displayed_high_low_lines(fig, chart_data, row=price_row, col=1, chart_style=effective_style)
            fig.update_yaxes(title_text="Price", row=price_row, col=1)
            fig.update_yaxes(title_text="Volume", row=volume_row, col=1)
            fig.update_xaxes(title_text="", row=volume_row, col=1)
        else:
            fig.add_trace(price_trace)
            _add_displayed_high_low_lines(fig, chart_data, chart_style=effective_style)
            fig.update_yaxes(title_text="Price")

        fig.update_layout(
            title=title,
            height=height,
            margin=dict(l=20, r=20, t=45, b=20),
            xaxis_title="",
            hovermode="x unified" if effective_style != "Candlestick" else "x",
            showlegend=True,
        )

        fig.update_xaxes(rangeslider_visible=False)
        _apply_daily_trading_axis(fig, chart_view)

        st.plotly_chart(fig, use_container_width=True)
        if effective_style == "Candlestick":
            st.caption("Candlestick mode uses OHLC candles. Displayed High/Low uses candle wick High/Low for the visible chart window.")
        if _use_trading_day_category_axis(chart_view):
            st.caption("Month / 52 Weeks use a compressed trading-day axis: weekends and market-holiday gaps are removed. These views use regular daily data only, not pre-market or after-hours.")
        if has_volume:
            st.caption("Volume bars use broker-style candle coloring: green when Close >= Open, red when Close < Open. This is not true bid/ask order-flow buy/sell volume.")
            _render_volume_summary(chart_data, chart_view=chart_view)
    else:
        st.markdown(f"**{title}**")
        st.line_chart(chart_data["Close"])
        if has_volume:
            st.bar_chart(chart_data["Volume"])
            _render_volume_summary(chart_data, chart_view=chart_view)

def render_two_day_controls(symbol: str, window_info: dict):
    current_offset = int(window_info.get("offset", 0))
    max_offset = int(window_info.get("max_offset", 0))
    left_date = window_info.get("left_date")
    right_date = window_info.get("right_date")

    if st.session_state.get(TWO_DAY_OFFSET_KEY, 0) != current_offset:
        st.session_state[TWO_DAY_OFFSET_KEY] = current_offset

    label = ""
    if left_date and right_date:
        label = f"Showing: {left_date} + {right_date}"
    elif right_date:
        label = f"Showing: {right_date}"
    else:
        label = "No two-day window available."

    control_col_1, control_col_2, control_col_3, control_col_4 = st.columns([2.5, 1.4, 1.4, 1.0])

    with control_col_1:
        st.caption(label)

    with control_col_2:
        previous_disabled = current_offset >= max_offset
        if st.button(
            "← Previous 2 Days",
            key=f"{symbol}_two_day_previous",
            disabled=previous_disabled,
            use_container_width=True,
        ):
            st.session_state[TWO_DAY_OFFSET_KEY] = min(current_offset + 1, max_offset)
            st.rerun()

    with control_col_3:
        next_disabled = current_offset <= 0
        if st.button(
            "Next 2 Days →",
            key=f"{symbol}_two_day_next",
            disabled=next_disabled,
            use_container_width=True,
        ):
            st.session_state[TWO_DAY_OFFSET_KEY] = max(current_offset - 1, 0)
            st.rerun()

    with control_col_4:
        latest_disabled = current_offset <= 0
        if st.button(
            "Latest",
            key=f"{symbol}_two_day_latest",
            disabled=latest_disabled,
            use_container_width=True,
        ):
            st.session_state[TWO_DAY_OFFSET_KEY] = 0
            st.rerun()


def render_two_day_overlay_chart(window_info: dict, symbol: str, show_volume: bool = True):
    left_data = window_info["left_data"]
    right_data = window_info["right_data"]
    left_date = window_info["left_date"]
    right_date = window_info["right_date"]

    pieces = []
    if left_data is not None and not left_data.empty:
        pieces.append(left_data)
    if right_data is not None and not right_data.empty:
        pieces.append(right_data)

    if not pieces:
        st.info("No two-day chart data available.")
        return

    fig = go.Figure()

    if left_data is not None and not left_data.empty:
        fig.add_trace(
            go.Scatter(
                x=_format_time_axis(left_data),
                y=left_data["Close"],
                customdata=_format_original_time(left_data),
                mode="lines",
                name=str(left_date),
                hovertemplate="%{customdata}<br>Close: %{y:.2f}<extra></extra>",
            )
        )

    if right_data is not None and not right_data.empty:
        fig.add_trace(
            go.Scatter(
                x=_format_time_axis(right_data),
                y=right_data["Close"],
                customdata=_format_original_time(right_data),
                mode="lines",
                name=str(right_date),
                hovertemplate="%{customdata}<br>Close: %{y:.2f}<extra></extra>",
            )
        )

    displayed_data = pd.concat(pieces).sort_index()
    _add_displayed_high_low_lines(fig, displayed_data)

    fig.update_xaxes(tickformat="%H:%M", title_text="Time of day")
    fig.update_yaxes(title_text="Price")
    fig.update_layout(
        title=f"{symbol} 2 Days Overlay Comparison",
        height=500,
        margin=dict(l=20, r=20, t=55, b=25),
        hovermode="x unified",
        showlegend=True,
    )

    st.plotly_chart(fig, use_container_width=True)
    st.caption("Overlay mode uses one shared time-of-day axis. Hovering a time point shows both days' close prices when matching timestamps exist.")


def render_two_day_split_chart(window_info: dict, symbol: str, show_volume: bool = True):
    left_data = window_info["left_data"]
    right_data = window_info["right_data"]
    left_date = window_info["left_date"]
    right_date = window_info["right_date"]

    if not HAS_PLOTLY:
        left_chart, right_chart = st.columns(2)
        with left_chart:
            if left_data is not None and not left_data.empty:
                render_single_price_chart(left_data, f"{symbol} Left Day - {left_date}", height=420, show_volume=False, chart_view="2 Days")
            else:
                st.info("No left-day data available.")
        with right_chart:
            if right_data is not None and not right_data.empty:
                render_single_price_chart(right_data, f"{symbol} Right Day - {right_date}", height=420, show_volume=False, chart_view="2 Days")
            else:
                st.info("No right-day data available.")
        return

    if (left_data is None or left_data.empty) and (right_data is None or right_data.empty):
        st.info("No two-day chart data available.")
        return

    fig = make_subplots(
        rows=1,
        cols=2,
        shared_xaxes=True,
        subplot_titles=(
            f"Left Day - {left_date}" if left_date else "Left Day",
            f"Right Day - {right_date}" if right_date else "Right Day",
        ),
    )

    if left_data is not None and not left_data.empty:
        fig.add_trace(
            go.Scatter(
                x=_format_time_axis(left_data),
                y=left_data["Close"],
                customdata=_format_original_time(left_data),
                mode="lines",
                name=str(left_date),
                hovertemplate="%{customdata}<br>Close: %{y:.2f}<extra></extra>",
            ),
            row=1,
            col=1,
        )
        _add_displayed_high_low_lines(fig, left_data, row=1, col=1)

    if right_data is not None and not right_data.empty:
        fig.add_trace(
            go.Scatter(
                x=_format_time_axis(right_data),
                y=right_data["Close"],
                customdata=_format_original_time(right_data),
                mode="lines",
                name=str(right_date),
                hovertemplate="%{customdata}<br>Close: %{y:.2f}<extra></extra>",
            ),
            row=1,
            col=2,
        )
        _add_displayed_high_low_lines(fig, right_data, row=1, col=2)

    fig.update_xaxes(tickformat="%H:%M", title_text="Time of day", matches="x")
    fig.update_yaxes(title_text="Price")
    fig.update_layout(
        title=f"{symbol} 2 Days Split View",
        height=440,
        margin=dict(l=20, r=20, t=65, b=25),
        hovermode="x unified",
        showlegend=True,
    )

    st.plotly_chart(fig, use_container_width=True)
    st.caption("Split view is for separate visual inspection. Use Overlay Comparison for synced same-time hover.")


def render_two_day_price_chart(chart_data: pd.DataFrame, symbol: str, show_volume: bool = True):
    if TWO_DAY_OFFSET_KEY not in st.session_state:
        st.session_state[TWO_DAY_OFFSET_KEY] = 0

    if TWO_DAY_VIEW_MODE_KEY not in st.session_state:
        st.session_state[TWO_DAY_VIEW_MODE_KEY] = TWO_DAY_VIEW_MODES[0]

    window_info = get_two_day_window(
        chart_data,
        offset=st.session_state.get(TWO_DAY_OFFSET_KEY, 0),
    )

    if (window_info["left_data"] is None or window_info["left_data"].empty) and (window_info["right_data"] is None or window_info["right_data"].empty):
        st.info("No two-day chart data available.")
        render_two_day_controls(symbol, window_info)
        return

    view_mode = st.radio(
        "2 Days View Mode",
        options=TWO_DAY_VIEW_MODES,
        horizontal=True,
        key=f"{symbol}_{TWO_DAY_VIEW_MODE_KEY}",
        index=TWO_DAY_VIEW_MODES.index(st.session_state.get(TWO_DAY_VIEW_MODE_KEY, TWO_DAY_VIEW_MODES[0]))
        if st.session_state.get(TWO_DAY_VIEW_MODE_KEY, TWO_DAY_VIEW_MODES[0]) in TWO_DAY_VIEW_MODES
        else 0,
    )
    st.session_state[TWO_DAY_VIEW_MODE_KEY] = view_mode

    if view_mode == "Overlay Comparison":
        render_two_day_overlay_chart(window_info, symbol, show_volume=show_volume)
    else:
        render_two_day_split_chart(window_info, symbol, show_volume=show_volume)

    if show_volume:
        _render_two_day_volume_summary(window_info)

    render_two_day_controls(symbol, window_info)


def render_price_chart(chart_data: pd.DataFrame, symbol: str, chart_view: str, show_volume: bool = True, chart_style: str | None = "Line"):
    if chart_data is None or chart_data.empty:
        st.warning("No chart data available.")
        return

    if chart_view == "2 Days":
        render_two_day_price_chart(chart_data, symbol, show_volume=show_volume)
    else:
        effective_style = chart_style if chart_view in ["Month", "52 Weeks"] else "Line"
        render_single_price_chart(
            chart_data,
            f"{symbol} Price Chart - {chart_view}",
            height=600 if show_volume else 560,
            show_volume=show_volume,
            chart_view=chart_view,
            chart_style=effective_style,
        )
