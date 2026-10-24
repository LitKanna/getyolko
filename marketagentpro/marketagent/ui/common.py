import streamlit as st


def render_indicator_brackets():
    with st.expander("RSI / EMA20 / EMA50 Brackets - How to Read"):
        st.markdown(
            """
### RSI Bracket

RSI means **Relative Strength Index**. In this app, AI analysis uses **1H RSI** and **Daily RSI**, not the chart interval.

| RSI Range | Meaning |
|---:|---|
| Below 30 | Oversold / very weak |
| 30 - 35 | Weak, possible rebound area |
| 35 - 45 | Weak momentum |
| 45 - 60 | Neutral |
| 60 - 70 | Strong momentum |
| 70 - 75 | Overbought, pullback risk increasing |
| Above 75 | Very high, short-term risk elevated |

### EMA20 / EMA50

EMA means **Exponential Moving Average**. It gives more weight to recent prices.

| Indicator | Meaning in 1H Signal | Meaning in Daily Signal |
|---|---|---|
| EMA20 | Approx. short-term 20-hour trend | Approx. 20-trading-day trend |
| EMA50 | Approx. medium-term 50-hour trend | Approx. 50-trading-day trend |

### How We Interpret EMA

| Condition | Interpretation |
|---|---|
| Price > EMA20 and Price > EMA50 | Trend is positive |
| EMA20 > EMA50 | Short-term trend is stronger than medium-term trend |
| Price < EMA20 | Short-term weakness warning |
| Price < EMA50 | Deeper trend weakness |
| EMA20 < EMA50 | Trend structure weakening |

### Important Rule

The chart can be 1 min, 5 min, or daily. But **AI risk analysis always uses 1H + Daily EMA20 / EMA50 / RSI**.
            """
        )
