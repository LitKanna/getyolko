import streamlit as st

from marketagent.config import (
    ALPACA_DATA_FEED,
    ANTHROPIC_BASE_URL,
    ANTHROPIC_MODEL,
    DEFAULT_DASHBOARD_AI_MAX_NEWS_ITEMS,
    DEFAULT_DASHBOARD_AI_MODE,
    DEFAULT_DASHBOARD_AI_OUTPUT_LENGTH,
    DEFAULT_AI_STREAMING,
    DEFAULT_OLLAMA_MODEL,
    DEFAULT_OLLAMA_NUM_CTX,
    DEFAULT_OLLAMA_TEMPERATURE,
    DEFAULT_WATCHLIST,
    ENV_FILE,
    ENV_FILE_LOADED,
    MARKET_DATA_PROVIDER,
    OPENAI_BASE_URL,
    OPENAI_MODEL,
    SETTINGS_FILE,
)
from marketagent.ai_agent import (
    AI_PROVIDER_LABELS,
    AI_STREAMING_LABELS,
    DASHBOARD_AI_MODE_LABELS,
    DASHBOARD_OUTPUT_LENGTH_LABELS,
    LANGUAGE_MODE_LABELS,
    get_dashboard_ai_capabilities,
    get_ai_model_name,
    is_ai_enabled,
    list_ollama_models,
    test_ai_provider,
)
from marketagent.market_data import (
    clear_quote_cache,
    get_current_market_data_provider_health,
    get_current_market_data_provider_name,
)
from marketagent.providers.alpaca_provider import AlpacaProvider
from marketagent.providers.registry import reset_market_data_provider
from marketagent.storage import sanitize_ai_settings, sanitize_api_settings, save_app_settings
from marketagent.utils import format_price, normalize_symbol


def _ai_settings_signature(settings: dict | None) -> tuple:
    """Small immutable signature so UI changes can invalidate old AI output immediately."""
    settings = sanitize_ai_settings(settings or {})
    return (
        settings.get("provider"),
        settings.get("language_mode"),
        settings.get("ollama_model"),
        int(settings.get("ollama_num_ctx") or 0),
        round(float(settings.get("ollama_temperature") or 0.0), 4),
        settings.get("dashboard_ai_mode"),
        settings.get("ai_streaming"),
        int(settings.get("dashboard_max_news_items") or 0),
        settings.get("dashboard_output_length"),
    )


def _clear_ai_outputs_after_settings_change():
    """Avoid showing an old Off-mode summary after switching to Ollama, or vice versa."""
    st.session_state.ai_summary_by_symbol = {}
    st.session_state.ai_summary_meta_by_symbol = {}
    st.session_state.last_ai_risk_key_by_symbol = {}
    for key in list(st.session_state.keys()):
        if str(key).endswith("_dashboard_ai_prompt_version"):
            st.session_state.pop(key, None)


def render_api_settings_panel():
    """Let demo users bring their own Alpaca keys (BYOK) without editing .env.

    Values are stored in data/marketagentpro_settings.json and take effect
    immediately: the provider cache and Streamlit data caches are reset so the
    next fetch uses the new keys / provider.
    """
    current_settings = sanitize_api_settings(st.session_state.get("api_settings", {}))

    with st.sidebar.expander("Alpaca / Market Data", expanded=False):
        st.caption(
            "Bring your own free Alpaca keys for live quotes and options. "
            "Keys are saved only in your local data folder and never shared."
        )

        provider_options = ["yfinance", "alpaca"]
        provider_labels = {
            "yfinance": "yfinance (no API key)",
            "alpaca": "Alpaca (my own keys)",
        }
        current_provider = current_settings.get("market_data_provider") or "yfinance"
        if current_provider not in provider_options:
            current_provider = "yfinance"
        selected_label = st.radio(
            "Market Data Provider",
            options=[provider_labels[opt] for opt in provider_options],
            index=provider_options.index(current_provider),
            key="api_provider_select",
            help=(
                "yfinance needs no API key. Alpaca uses your own API keys for "
                "live quotes and options; historical charts still use yfinance."
            ),
        )
        selected_provider = next(
            key for key, label in provider_labels.items() if label == selected_label
        )

        st.caption("Alpaca credentials (leave blank to keep the current values):")
        api_key_input = st.text_input(
            "API Key ID",
            value="",
            placeholder="e.g. PK...",
            key="api_key_input",
        ).strip()
        secret_input = st.text_input(
            "Secret Key",
            type="password",
            value="",
            placeholder="Only fill in when changing keys",
            key="api_secret_input",
        ).strip()

        feed_options = ["iex", "sip"]
        current_feed = current_settings.get("alpaca_data_feed") or "iex"
        if current_feed not in feed_options:
            current_feed = "iex"
        selected_feed = st.selectbox(
            "Data Feed",
            options=feed_options,
            index=feed_options.index(current_feed),
            key="api_data_feed_select",
            help="iex is free and enough for most users; sip requires a paid Alpaca plan.",
        )

        options_feed_options = ["indicative", "opra"]
        current_options_feed = current_settings.get("alpaca_options_feed") or "indicative"
        if current_options_feed not in options_feed_options:
            current_options_feed = "indicative"
        selected_options_feed = st.selectbox(
            "Options Feed",
            options=options_feed_options,
            index=options_feed_options.index(current_options_feed),
            key="api_options_feed_select",
            help="indicative works on free/basic plans; opra requires paid OPRA access.",
        )

        if current_settings.get("alpaca_api_key"):
            st.caption("Saved API key: `configured` (hidden). Enter new values above to replace it.")
        else:
            st.caption("Saved API key: not configured yet.")

        test_col, save_col = st.columns(2)

        with test_col:
            if st.button("Test", use_container_width=True, key="api_test_button"):
                test_key = api_key_input or current_settings.get("alpaca_api_key", "")
                test_secret = secret_input or current_settings.get("alpaca_secret_key", "")
                if not test_key or not test_secret:
                    st.warning("Enter an API Key ID and Secret Key first.")
                else:
                    with st.spinner("Testing Alpaca connection..."):
                        test_provider = AlpacaProvider(
                            api_key=test_key,
                            secret_key=test_secret,
                            data_feed=selected_feed,
                            options_feed=selected_options_feed,
                        )
                        result = test_provider.health_check(test_symbol="AAPL")
                    status = result.get("status")
                    if status == "ok":
                        st.success(f"OK: AAPL @ {format_price(result.get('price'))}")
                    elif status == "not_configured":
                        st.error("Keys missing. Enter both API Key ID and Secret Key.")
                    else:
                        st.error(f"Failed: {result.get('error') or status}")
                        st.caption(
                            "Check the keys, your Alpaca plan's feed access, or network connection."
                        )

        with save_col:
            if st.button("Save & Activate", use_container_width=True, key="api_save_button"):
                new_settings = sanitize_api_settings(
                    {
                        "market_data_provider": selected_provider,
                        "alpaca_api_key": api_key_input or current_settings.get("alpaca_api_key", ""),
                        "alpaca_secret_key": secret_input or current_settings.get("alpaca_secret_key", ""),
                        "alpaca_data_feed": selected_feed,
                        "alpaca_options_feed": selected_options_feed,
                    }
                )
                st.session_state.api_settings = new_settings
                save_app_settings()
                reset_market_data_provider()
                clear_quote_cache()
                st.cache_data.clear()
                st.session_state.pop("api_key_input", None)
                st.session_state.pop("api_secret_input", None)
                st.success("Saved and activated. Data caches were reset.")
                st.rerun()

        if (
            selected_provider == "alpaca"
            and not current_settings.get("alpaca_api_key")
            and not api_key_input
        ):
            st.caption("Tip: without keys, Alpaca mode falls back to yfinance prices.")


def render_provider_status_panel():
    st.sidebar.divider()
    st.sidebar.caption("Data Provider Status")

    selected_provider = get_current_market_data_provider_name()
    saved_api = sanitize_api_settings(st.session_state.get("api_settings", {}))
    key_source = "saved settings" if saved_api.get("alpaca_api_key") else "env / .env"
    st.sidebar.write(f"Active provider: `{selected_provider}`")
    st.sidebar.write(f"API key source: `{key_source}`")
    st.sidebar.write(f"Env default: `{MARKET_DATA_PROVIDER}`")
    st.sidebar.write(f"Env file loaded: `{ENV_FILE_LOADED}`")
    st.sidebar.caption(f"Env path: `{ENV_FILE}`")

    if selected_provider == "alpaca":
        st.sidebar.write(f"Feed: `{saved_api.get('alpaca_data_feed') or ALPACA_DATA_FEED}`")

    with st.sidebar.expander("Connection Test", expanded=False):
        test_symbol = st.text_input(
            "Test Symbol",
            value="AAPL",
            key="provider_test_symbol",
        )

        status = get_current_market_data_provider_health(test_symbol)
        status_label = status.get("status", "unknown")

        if status_label == "ok":
            st.success("Provider test OK")
        elif status_label == "not_configured":
            st.warning("Provider not configured")
        else:
            st.error(f"Provider test: {status_label}")

        st.write(f"Provider: `{status.get('provider', 'unknown')}`")
        st.write(f"Symbol: `{status.get('test_symbol', test_symbol)}`")
        st.write(f"Configured: `{status.get('configured')}`")
        st.write(f"Source: `{status.get('source', 'N/A')}`")
        st.write(f"Feed: `{status.get('feed', 'N/A')}`")
        st.write(f"Price: {format_price(status.get('price'))}")

        bid = status.get("bid")
        ask = status.get("ask")

        if bid is not None or ask is not None:
            st.write(f"Bid / Ask: {format_price(bid)} / {format_price(ask)}")

        st.write(f"Timestamp: `{status.get('timestamp') or 'N/A'}`")

        if status.get("error"):
            st.caption(f"Error: {status.get('error')}")

        st.caption(
            "This test checks the selected provider. Alpaca health checks test native Alpaca access directly; "
            "dashboard quotes still fall back to yfinance if needed."
        )




def render_ai_settings_panel() -> dict:
    """Render publish-ready AI settings: Off mode plus local Ollama mode."""
    current_settings = sanitize_ai_settings(st.session_state.get("ai_settings", {}))

    with st.sidebar.expander("AI Settings", expanded=False):
        st.caption("AI is optional. With AI Off, the app still shows charts, technicals, portfolio, options, and English source news.")

        provider_options = ["off", "ollama", "openai", "anthropic"]
        current_provider = current_settings.get("provider") or "off"
        if current_provider not in provider_options:
            current_provider = "off"

        selected_provider_label = st.selectbox(
            "AI Provider",
            options=[AI_PROVIDER_LABELS[p] for p in provider_options],
            index=provider_options.index(current_provider),
            key="ai_provider_select",
            help=(
                "Ollama Local uses your local model server (the default when a .env file exists). "
                "OpenAI (GPT) / Anthropic (Claude) let you bring your own API key; "
                "keys are stored only in the local data folder."
            ),
        )
        selected_provider = next(key for key, label in AI_PROVIDER_LABELS.items() if label == selected_provider_label)

        language_options = ["english_only", "chinese", "bilingual"]
        current_language = current_settings.get("language_mode") or "english_only"
        if current_language not in language_options:
            current_language = "english_only"
        selected_language_label = st.selectbox(
            "Language Mode",
            options=[LANGUAGE_MODE_LABELS[p] for p in language_options],
            index=language_options.index(current_language),
            key="ai_language_mode_select",
            help="AI Off always shows English source news only. Chinese/Bilingual requires a connected AI provider.",
        )
        selected_language = next(key for key, label in LANGUAGE_MODE_LABELS.items() if label == selected_language_label)

        current_model = current_settings.get("ollama_model") or DEFAULT_OLLAMA_MODEL
        selected_model = current_model
        selected_ctx = int(current_settings.get("ollama_num_ctx") or DEFAULT_OLLAMA_NUM_CTX)
        selected_temperature = float(current_settings.get("ollama_temperature", DEFAULT_OLLAMA_TEMPERATURE))
        selected_openai_api_key = str(current_settings.get("openai_api_key") or "")
        selected_openai_model = str(current_settings.get("openai_model") or OPENAI_MODEL)
        selected_openai_base_url = str(current_settings.get("openai_base_url") or OPENAI_BASE_URL)
        selected_anthropic_api_key = str(current_settings.get("anthropic_api_key") or "")
        selected_anthropic_model = str(current_settings.get("anthropic_model") or ANTHROPIC_MODEL)
        selected_anthropic_base_url = str(current_settings.get("anthropic_base_url") or ANTHROPIC_BASE_URL)
        selected_dashboard_mode = current_settings.get("dashboard_ai_mode") or DEFAULT_DASHBOARD_AI_MODE
        selected_streaming = current_settings.get("ai_streaming") or DEFAULT_AI_STREAMING
        selected_max_news_items = int(current_settings.get("dashboard_max_news_items") or DEFAULT_DASHBOARD_AI_MAX_NEWS_ITEMS)
        selected_output_length = current_settings.get("dashboard_output_length") or DEFAULT_DASHBOARD_AI_OUTPUT_LENGTH

        if selected_provider == "off":
            st.info("AI Provider is Off. News remains English/source-only and Dashboard uses rule-based fallback summaries.")
        elif selected_provider == "ollama":
            st.write("Provider: `Ollama Local`")
            local_models = list_ollama_models(timeout=2)

            if local_models:
                options = local_models.copy()
                if current_model not in options:
                    options.insert(0, current_model)
                options.append("Manual / custom")
                selected_model = st.selectbox(
                    "Ollama Model",
                    options=options,
                    index=options.index(current_model) if current_model in options else 0,
                    key="ai_settings_model_select",
                )
                if selected_model == "Manual / custom":
                    selected_model = st.text_input(
                        "Manual model name",
                        value=current_model,
                        key="ai_settings_model_manual",
                    ).strip()
            else:
                st.caption("Could not read Ollama model list. Make sure Ollama is running, or type the model manually.")
                selected_model = st.text_input(
                    "Ollama Model",
                    value=current_model,
                    key="ai_settings_model_text",
                    placeholder="Example: qwen2.5:14b",
                ).strip()

            context_options = [2048, 4096, 8192, 16384, 32768, 65536]
            if selected_ctx not in context_options:
                context_options.append(selected_ctx)
                context_options = sorted(context_options)

            selected_ctx = st.selectbox(
                "Context Length",
                options=context_options,
                index=context_options.index(selected_ctx),
                help="Higher context can handle longer news/reports, but uses more VRAM/RAM and may be slower.",
                key="ai_settings_num_ctx",
            )
        elif selected_provider == "openai":
            st.write("Provider: `OpenAI (GPT)`")
            st.caption(
                "Bring your own OpenAI API key. Keys are saved only in the local data folder "
                "and never uploaded. Leave blank to keep the current key / .env value."
            )
            api_key_input = st.text_input(
                "OpenAI API Key",
                type="password",
                value="",
                placeholder="sk-... (leave blank to keep current)",
                key="ai_openai_api_key_input",
            ).strip()
            if api_key_input:
                selected_openai_api_key = api_key_input
            selected_openai_model = st.text_input(
                "Model",
                value=selected_openai_model,
                key="ai_openai_model_input",
                placeholder="Example: gpt-4o-mini",
            ).strip() or OPENAI_MODEL
            selected_openai_base_url = st.text_input(
                "API Base URL",
                value=selected_openai_base_url,
                key="ai_openai_base_url_input",
                placeholder="https://api.openai.com/v1",
            ).strip() or OPENAI_BASE_URL
            if selected_openai_api_key:
                st.caption("API key: `configured` (hidden).")
            else:
                st.caption("API key not configured yet. Enter one above to enable GPT summaries.")
        elif selected_provider == "anthropic":
            st.write("Provider: `Anthropic (Claude)`")
            st.caption(
                "Bring your own Anthropic API key. Keys are saved only in the local data folder "
                "and never uploaded. Leave blank to keep the current key / .env value."
            )
            api_key_input = st.text_input(
                "Anthropic API Key",
                type="password",
                value="",
                placeholder="sk-ant-... (leave blank to keep current)",
                key="ai_anthropic_api_key_input",
            ).strip()
            if api_key_input:
                selected_anthropic_api_key = api_key_input
            selected_anthropic_model = st.text_input(
                "Model",
                value=selected_anthropic_model,
                key="ai_anthropic_model_input",
                placeholder="Example: claude-3-5-sonnet-latest",
            ).strip() or ANTHROPIC_MODEL
            selected_anthropic_base_url = st.text_input(
                "API Base URL",
                value=selected_anthropic_base_url,
                key="ai_anthropic_base_url_input",
                placeholder="https://api.anthropic.com/v1",
            ).strip() or ANTHROPIC_BASE_URL
            if selected_anthropic_api_key:
                st.caption("API key: `configured` (hidden).")
            else:
                st.caption("API key not configured yet. Enter one above to enable Claude summaries.")

        if selected_provider != "off":
            selected_temperature = st.slider(
                "Temperature",
                min_value=0.0,
                max_value=1.0,
                value=selected_temperature,
                step=0.05,
                help="Lower is more stable/structured. 0.2-0.4 is usually good for market summaries.",
                key="ai_settings_temperature",
            )

        st.markdown("**Dashboard AI behavior**")
        dashboard_mode_options = ["fast", "balanced", "detailed"]
        if selected_dashboard_mode not in dashboard_mode_options:
            selected_dashboard_mode = "balanced"
        selected_dashboard_mode_label = st.selectbox(
            "Dashboard AI Mode",
            options=[DASHBOARD_AI_MODE_LABELS[p] for p in dashboard_mode_options],
            index=dashboard_mode_options.index(selected_dashboard_mode),
            key="ai_dashboard_mode_select",
            help="Fast is best for small/slow local models; Balanced is good for qwen2.5:14b; Detailed is intended for stronger models/cloud APIs later.",
        )
        selected_dashboard_mode = next(key for key, label in DASHBOARD_AI_MODE_LABELS.items() if label == selected_dashboard_mode_label)

        streaming_options = ["auto", "on", "off"]
        if selected_streaming not in streaming_options:
            selected_streaming = "auto"
        selected_streaming_label = st.selectbox(
            "Streaming",
            options=[AI_STREAMING_LABELS[p] for p in streaming_options],
            index=streaming_options.index(selected_streaming),
            key="ai_streaming_select",
            help="Auto uses streaming when the selected provider supports it, so the UI can show text while generating.",
        )
        selected_streaming = next(key for key, label in AI_STREAMING_LABELS.items() if label == selected_streaming_label)

        news_item_options = [3, 5, 8]
        if selected_max_news_items not in news_item_options:
            selected_max_news_items = 5
        selected_max_news_items = st.selectbox(
            "Max News Items",
            options=news_item_options,
            index=news_item_options.index(selected_max_news_items),
            key="ai_dashboard_max_news_items",
            help="Controls how many recent stock-news items are sent to Dashboard AI. Lower is faster and less likely to overwhelm local models.",
        )

        output_length_options = ["short", "medium", "long"]
        if selected_output_length not in output_length_options:
            selected_output_length = "medium"
        selected_output_length_label = st.selectbox(
            "Output Length",
            options=[DASHBOARD_OUTPUT_LENGTH_LABELS[p] for p in output_length_options],
            index=output_length_options.index(selected_output_length),
            key="ai_dashboard_output_length",
        )
        selected_output_length = next(key for key, label in DASHBOARD_OUTPUT_LENGTH_LABELS.items() if label == selected_output_length_label)

        new_settings = sanitize_ai_settings(
            {
                "provider": selected_provider,
                "language_mode": selected_language,
                "ollama_model": selected_model or DEFAULT_OLLAMA_MODEL,
                "ollama_num_ctx": selected_ctx,
                "ollama_temperature": selected_temperature,
                "openai_api_key": selected_openai_api_key,
                "openai_model": selected_openai_model,
                "openai_base_url": selected_openai_base_url,
                "anthropic_api_key": selected_anthropic_api_key,
                "anthropic_model": selected_anthropic_model,
                "anthropic_base_url": selected_anthropic_base_url,
                "dashboard_ai_mode": selected_dashboard_mode,
                "ai_streaming": selected_streaming,
                "dashboard_max_news_items": selected_max_news_items,
                "dashboard_output_length": selected_output_length,
            }
        )

        previous_settings = sanitize_ai_settings(st.session_state.get("ai_settings", {}))
        previous_signature = _ai_settings_signature(previous_settings)
        new_signature = _ai_settings_signature(new_settings)

        # Apply sidebar changes immediately, even before Save AI is clicked.
        # Save AI only persists the settings to data/marketagentpro_settings.json.
        st.session_state.ai_settings = new_settings

        if previous_signature != new_signature:
            _clear_ai_outputs_after_settings_change()
            st.session_state["last_ai_settings_signature"] = new_signature
            st.caption("AI settings changed. Old Dashboard AI summaries were cleared so the next run uses the selected provider.")

        button_col_1, button_col_2 = st.columns(2)
        with button_col_1:
            if st.button("Test AI", use_container_width=True, key="ai_settings_test_model"):
                with st.spinner("Testing selected AI provider..."):
                    result = test_ai_provider(new_settings)
                if result.get("ok"):
                    st.success(result.get("message"))
                else:
                    st.error(f"AI test failed: {result.get('message')}")

        with button_col_2:
            if st.button("Save AI", use_container_width=True, key="ai_settings_save"):
                save_app_settings()
                st.success("AI settings saved.")

        status = "enabled" if is_ai_enabled(new_settings) else "off"
        st.caption(
            f"Active now: `{AI_PROVIDER_LABELS.get(new_settings['provider'])}` · "
            f"language `{LANGUAGE_MODE_LABELS.get(new_settings['language_mode'])}` · "
            f"AI `{status}`"
        )
        st.caption("Changes apply immediately. Click Save AI only if you want to persist them after restart.")
        if new_settings["provider"] == "ollama":
            st.caption(
                f"Ollama: `{new_settings['ollama_model']}` · "
                f"ctx `{new_settings['ollama_num_ctx']}` · "
                f"temp `{new_settings['ollama_temperature']:.2f}`"
            )
        elif new_settings["provider"] in {"openai", "anthropic"}:
            provider_key_field = new_settings["provider"] + "_api_key"
            st.caption(
                f"Cloud model: `{get_ai_model_name(new_settings)}` · "
                f"temp `{new_settings['ollama_temperature']:.2f}` · "
                f"key `{'configured' if new_settings.get(provider_key_field) else 'missing'}`"
            )

        capability = get_dashboard_ai_capabilities(new_settings)
        st.caption(
            f"Dashboard AI: `{capability['dashboard_ai_mode_label']}` · "
            f"stream `{capability['ai_streaming']}` → active `{capability['use_streaming']}` · "
            f"news `{capability['dashboard_max_news_items']}` · "
            f"output `{capability['dashboard_output_length']}` · "
            f"num_predict `{capability['num_predict']}`"
        )

    return sanitize_ai_settings(st.session_state.get("ai_settings", {}))

def apply_pending_navigation():
    """Apply navigation requests from page buttons before sidebar widgets are created.

    Streamlit widget-backed session_state keys should be changed before the
    corresponding widget is instantiated. Dashboard buttons therefore write
    pending navigation keys, then this sidebar helper applies them at the top
    of the next run.
    """
    pending_page = st.session_state.pop("_pending_main_page", None)
    if pending_page in ["Dashboard", "Portfolio", "News"]:
        st.session_state.main_page_selector = pending_page

    pending_news_view = st.session_state.pop("_pending_news_view", None)
    if pending_news_view in ["Market News", "Stock News", "News History", "Settings / Notes"]:
        st.session_state.news_view_selector = pending_news_view

    pending_news_symbol = st.session_state.pop("_pending_news_symbol", None)
    if pending_news_symbol:
        symbol = normalize_symbol(pending_news_symbol)
        if symbol:
            st.session_state.news_focus_symbol = symbol
            # Pre-fill the widget state. The News page will validate the symbol
            # against the current displayed-symbol list before rendering.
            st.session_state.stock_news_symbol = symbol


def render_sidebar(has_autorefresh: bool):
    apply_pending_navigation()
    st.sidebar.title("MarketAgentPro")

    if "main_page_selector" not in st.session_state:
        st.session_state.main_page_selector = "Dashboard"
    if st.session_state.main_page_selector not in ["Dashboard", "Portfolio", "News"]:
        st.session_state.main_page_selector = "Dashboard"

    main_page = st.sidebar.radio(
        "Page",
        options=["Dashboard", "Portfolio", "News"],
        key="main_page_selector",
    )

    st.sidebar.divider()
    st.sidebar.caption("Watchlist Manager")

    add_col, add_button_col = st.sidebar.columns([2, 1])

    with add_col:
        new_symbol = st.text_input(
            "Add Symbol",
            value="",
            placeholder="Example: MU",
            key="add_symbol_input",
        )

    with add_button_col:
        st.write("")
        st.write("")
        add_clicked = st.button("Add", use_container_width=True)

    if add_clicked:
        symbol_to_add = normalize_symbol(new_symbol)

        if symbol_to_add and symbol_to_add not in st.session_state.watchlist:
            st.session_state.watchlist.append(symbol_to_add)
            st.session_state.watchlist = sorted(st.session_state.watchlist)

            if symbol_to_add not in st.session_state.display_symbols:
                st.session_state.display_symbols.append(symbol_to_add)

            save_app_settings()
            st.rerun()

        elif symbol_to_add in st.session_state.watchlist:
            st.sidebar.info(f"{symbol_to_add} is already in watchlist.")

    delete_symbol = st.sidebar.selectbox(
        "Delete Symbol",
        options=st.session_state.watchlist,
        index=0 if st.session_state.watchlist else None,
        placeholder="No symbols yet",
    )

    delete_clicked = st.sidebar.button("Delete Selected Symbol", use_container_width=True)
    st.sidebar.caption("Deleting a watchlist symbol does not delete Portfolio holdings. Manage positions in Portfolio > Holdings.")

    if delete_clicked and delete_symbol:
        st.session_state.watchlist = [
            item for item in st.session_state.watchlist if item != delete_symbol
        ]

        st.session_state.display_symbols = [
            item for item in st.session_state.display_symbols if item != delete_symbol
        ]

        save_app_settings()
        st.rerun()

    st.sidebar.divider()
    st.sidebar.caption("Display Stocks")

    selected_display_symbols = st.sidebar.multiselect(
        "Choose stocks to display",
        options=st.session_state.watchlist,
        default=[
            item for item in st.session_state.display_symbols
            if item in st.session_state.watchlist
        ],
    )

    display_clicked = st.sidebar.button("Display Selected Stocks", use_container_width=True)
    show_all_clicked = st.sidebar.button("Display All Watchlist", use_container_width=True)

    if display_clicked:
        if selected_display_symbols:
            st.session_state.display_symbols = selected_display_symbols
            save_app_settings()
            st.rerun()
        else:
            st.sidebar.warning("Please select at least one stock.")

    if show_all_clicked:
        st.session_state.display_symbols = st.session_state.watchlist.copy()
        save_app_settings()
        st.rerun()

    st.sidebar.divider()

    auto_refresh = st.sidebar.checkbox(
        "Auto refresh chart data",
        value=True,
    )

    ai_settings = render_ai_settings_panel()

    render_api_settings_panel()

    auto_ai_on_risk_change = st.sidebar.checkbox(
        "Auto AI summary when risk changes",
        value=False,
        help=(
            "When enabled, regenerates the Dashboard AI brief only if this symbol's "
            "risk level or risk-point bucket changes. It does not re-run on news refresh, "
            "chart auto-refresh, or settings tweaks."
        ),
    )

    st.sidebar.caption(
        "EMA20 / EMA50 / RSI are based on 1H + Daily signals, not chart interval."
    )

    if auto_refresh and not has_autorefresh:
        st.sidebar.warning(
            "Auto refresh needs streamlit-autorefresh. "
            "Install it with: pip install streamlit-autorefresh"
        )

    render_provider_status_panel()

    st.sidebar.divider()

    if st.sidebar.button("Save Settings Now", use_container_width=True):
        save_app_settings()
        st.sidebar.success("Settings saved.")

    st.sidebar.caption(f"Settings file: `{SETTINGS_FILE}`")

    return {
        "main_page": main_page,
        "auto_refresh": auto_refresh,
        "ai_settings": ai_settings,
        "ollama_model": ai_settings.get("ollama_model"),
        "ollama_num_ctx": ai_settings.get("ollama_num_ctx"),
        "ollama_temperature": ai_settings.get("ollama_temperature"),
        "auto_ai_on_risk_change": auto_ai_on_risk_change,
    }
