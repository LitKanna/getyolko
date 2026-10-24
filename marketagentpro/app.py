import streamlit as st

st.set_page_config(page_title="MarketAgentPro", page_icon="📈", layout="wide")

try:
    from streamlit_autorefresh import st_autorefresh
    HAS_AUTOREFRESH = True
except Exception:
    st_autorefresh = None
    HAS_AUTOREFRESH = False

from marketagent.pages.dashboard import render_dashboard_page
from marketagent.pages.portfolio_page import render_portfolio_page
from marketagent.pages.news_page import render_news_page
from marketagent.storage import init_session_state
from marketagent.ui.login import render_account_box, render_login
from marketagent.ui.sidebar import render_sidebar
from marketagent.utils import now_et_string


def main():
    if not render_login():
        return

    init_session_state()
    render_account_box()

    sidebar_state = render_sidebar(has_autorefresh=HAS_AUTOREFRESH)

    if sidebar_state["main_page"] == "Portfolio":
        render_portfolio_page()
    elif sidebar_state["main_page"] == "News":
        render_news_page(ai_settings=sidebar_state["ai_settings"])
    else:
        render_dashboard_page(
            auto_refresh=sidebar_state["auto_refresh"],
            auto_ai_on_risk_change=sidebar_state["auto_ai_on_risk_change"],
            ai_settings=sidebar_state["ai_settings"],
            ollama_model=sidebar_state["ollama_model"],
            has_autorefresh=HAS_AUTOREFRESH,
            st_autorefresh_func=st_autorefresh,
        )

    st.caption(
        f"Last page update: {now_et_string()}. "
        "This app is for research and reference only, not financial advice."
    )


if __name__ == "__main__":
    main()
