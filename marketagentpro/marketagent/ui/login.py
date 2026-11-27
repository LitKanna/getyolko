import streamlit as st

from marketagent.auth import check_credentials, normalize_username


def is_signed_in() -> bool:
    return bool(st.session_state.get("auth_user"))


def sign_out() -> None:
    st.session_state.pop("auth_user", None)


def render_login() -> bool:
    if is_signed_in():
        return True

    st.title("MarketAgentPro")
    st.write("Sign in to open the local research dashboard.")

    with st.form("mapro_login"):
        username = st.text_input("Username")
        password = st.text_input("Password", type="password")
        submitted = st.form_submit_button("Sign in")

    if submitted:
        if check_credentials(username, password):
            st.session_state.auth_user = normalize_username(username)
            st.rerun()
        st.error("Wrong username or password.")

    return False


def render_account_box() -> None:
    user = st.session_state.get("auth_user")
    if not user:
        return
    st.sidebar.caption(f"Signed in as {user}")
    if st.sidebar.button("Sign out"):
        sign_out()
        st.rerun()
