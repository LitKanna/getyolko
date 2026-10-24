import json
import re

import requests

from marketagent.config import (
    ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL,
    ANTHROPIC_MODEL,
    DEFAULT_AI_PROVIDER,
    OLLAMA_BASE_URL,
    OPENAI_API_KEY,
    OPENAI_BASE_URL,
    OPENAI_MODEL,
)
from marketagent.indicators import classify_rsi, classify_trend
from marketagent.utils import format_pct, format_price


DASHBOARD_AI_PROMPT_VERSION = "dashboard_analyst_v11_capability_prompt_profiles"


AI_PROVIDER_LABELS = {
    "off": "Off / No AI",
    "ollama": "Ollama Local",
    "openai": "OpenAI (GPT)",
    "anthropic": "Anthropic (Claude)",
}

LANGUAGE_MODE_LABELS = {
    "english_only": "English only",
    "chinese": "Chinese summary",
    "bilingual": "Bilingual",
}

DASHBOARD_AI_MODE_LABELS = {
    "fast": "Fast / Compact",
    "balanced": "Balanced",
    "detailed": "Detailed Analyst",
}

AI_STREAMING_LABELS = {
    "auto": "Auto",
    "on": "Streaming On",
    "off": "Streaming Off",
}

DASHBOARD_OUTPUT_LENGTH_LABELS = {
    "short": "Short",
    "medium": "Medium",
    "long": "Long",
}

OUTPUT_LENGTH_NUM_PREDICT = {
    "short": 350,
    "medium": 600,
    "long": 900,
}

MODE_DEFAULT_NEWS_LIMIT = {
    "fast": 3,
    "balanced": 5,
    "detailed": 8,
}


def _normalize_dashboard_ai_mode(value: str | None) -> str:
    mode = str(value or "balanced").strip().lower()
    if mode in {"quick", "compact", "lite"}:
        mode = "fast"
    if mode in {"full", "deep", "analyst"}:
        mode = "detailed"
    if mode not in DASHBOARD_AI_MODE_LABELS:
        mode = "balanced"
    return mode


def _normalize_streaming_mode(value: str | None) -> str:
    mode = str(value or "auto").strip().lower()
    if mode in {"true", "yes", "1"}:
        mode = "on"
    if mode in {"false", "no", "0"}:
        mode = "off"
    if mode not in AI_STREAMING_LABELS:
        mode = "auto"
    return mode


def _normalize_output_length(value: str | None) -> str:
    length = str(value or "medium").strip().lower()
    if length not in DASHBOARD_OUTPUT_LENGTH_LABELS:
        length = "medium"
    return length


def get_dashboard_ai_capabilities(ai_settings: dict | None = None) -> dict:
    """Return provider/prompt settings used by Dashboard AI.

    This is the compatibility layer that lets published users switch between
    Off, small local models, qwen2.5:14b-style local models, and future cloud
    providers without rewriting the Dashboard logic.
    """
    ai_settings = ai_settings or {}
    provider = get_ai_provider(ai_settings)
    mode = _normalize_dashboard_ai_mode(ai_settings.get("dashboard_ai_mode"))
    streaming_mode = _normalize_streaming_mode(ai_settings.get("ai_streaming"))
    output_length = _normalize_output_length(ai_settings.get("dashboard_output_length"))

    try:
        max_news_items = int(ai_settings.get("dashboard_max_news_items") or MODE_DEFAULT_NEWS_LIMIT.get(mode, 5))
    except Exception:
        max_news_items = MODE_DEFAULT_NEWS_LIMIT.get(mode, 5)
    if max_news_items not in {3, 5, 8}:
        max_news_items = MODE_DEFAULT_NEWS_LIMIT.get(mode, 5)

    supports_streaming = provider in {"ollama", "openai", "anthropic"}
    if streaming_mode == "on":
        use_streaming = supports_streaming
    elif streaming_mode == "off":
        use_streaming = False
    else:
        # Auto: local Ollama streams so the UI does not look stuck. Future cloud
        # providers can choose their own adapter behavior.
        use_streaming = supports_streaming

    num_predict = OUTPUT_LENGTH_NUM_PREDICT.get(output_length, 900)
    if mode == "fast":
        num_predict = min(num_predict, 420)
        max_news_items = min(max_news_items, 3)
    elif mode == "balanced":
        max_news_items = min(max_news_items, 3)
    elif mode == "detailed":
        num_predict = max(num_predict, 900)

    return {
        "provider": provider,
        "dashboard_ai_mode": mode,
        "dashboard_ai_mode_label": DASHBOARD_AI_MODE_LABELS.get(mode, "Balanced"),
        "ai_streaming": streaming_mode,
        "supports_streaming": supports_streaming,
        "use_streaming": use_streaming,
        "dashboard_max_news_items": max_news_items,
        "dashboard_output_length": output_length,
        "num_predict": int(num_predict),
    }


def get_ai_provider(ai_settings: dict | None = None) -> str:
    provider = str((ai_settings or {}).get("provider") or DEFAULT_AI_PROVIDER or "off").strip().lower()
    if provider in {"ollama local", "ollama_local", "local"}:
        provider = "ollama"
    if provider in {"gpt", "chatgpt", "openai_api"}:
        provider = "openai"
    if provider in {"claude", "anthropic_api"}:
        provider = "anthropic"
    if provider not in AI_PROVIDER_LABELS:
        provider = "off"
    return provider


def get_ai_model_name(ai_settings: dict | None = None) -> str:
    """Return the active model name for the selected provider (UI display)."""
    ai_settings = ai_settings or {}
    provider = get_ai_provider(ai_settings)
    if provider == "openai":
        return str(ai_settings.get("openai_model") or OPENAI_MODEL or "gpt-4o-mini")
    if provider == "anthropic":
        return str(ai_settings.get("anthropic_model") or ANTHROPIC_MODEL or "claude-3-5-sonnet-latest")
    return str(ai_settings.get("ollama_model") or "qwen2.5:14b")


def is_ai_enabled(ai_settings: dict | None = None) -> bool:
    return get_ai_provider(ai_settings) != "off"


def ai_provider_label(ai_settings: dict | None = None) -> str:
    return AI_PROVIDER_LABELS.get(get_ai_provider(ai_settings), "Off / No AI")


def language_mode_label(ai_settings: dict | None = None) -> str:
    mode = str((ai_settings or {}).get("language_mode") or "english_only").strip().lower()
    return LANGUAGE_MODE_LABELS.get(mode, "English only")


def is_weak_dashboard_ai_summary(text: str) -> bool:
    """Detect Dashboard AI answers that are too generic for an analyst-style brief."""
    if not text:
        return True
    cleaned = text.strip()
    lower = cleaned.lower()

    # Very short answers or simple sentiment labels are not useful enough for this panel.
    if len(cleaned) < 850:
        return True
    if ("tone:" in lower or "tone：" in lower) and len(cleaned) < 1400:
        return True

    required_markers = [
        "一句话结论",
        "新闻综合",
        "关键新闻",
        "技术",
        "一致",
        "接下来",
    ]
    marker_hits = sum(1 for marker in required_markers if marker in cleaned)

    english_markers = [
        "one-line conclusion",
        "news synthesis",
        "key news",
        "technical",
        "watch next",
    ]
    english_hits = sum(1 for marker in english_markers if marker in lower)

    # When news is available, the model should cite article numbers such as [1].
    citation_hits = len(re.findall(r"\[\d+\]", cleaned))

    generic_phrases = [
        "需要关注市场变化",
        "投资者应谨慎",
        "仅供参考",
        "无法确定",
        "综合来看",
    ]
    generic_hits = sum(1 for phrase in generic_phrases if phrase in cleaned)

    too_few_sections = marker_hits < 4 and english_hits < 4
    too_few_citations = citation_hits < 1
    mostly_generic = generic_hits >= 3 and citation_hits == 0
    return too_few_sections or too_few_citations or mostly_generic


def build_strict_news_retry_prompt(original_prompt: str) -> str:
    """Ask the model to retry when it ignored the evidence-based analyst format."""
    return (
        original_prompt
        + "\n\n【强制重写要求】\n"
        + "上一版回答太笼统，或者没有真正引用新闻证据。请重新输出完整分析。\n"
        + "硬性要求：\n"
        + "1. 必须引用至少 2 条新闻编号，例如 [1], [2]；如果只有 1 条有效新闻，就明确说明只有 [1] 可用。\n"
        + "2. 每一条新闻判断都要解释：发生了什么、为什么影响股价、短期/中期影响是什么。\n"
        + "3. 必须把新闻信号和 1H / Daily RSI、EMA20、EMA50 对照。\n"
        + "4. 不准只写 Tone、Negative、Positive、Neutral，不准只写泛泛而谈的风险提示。\n"
        + "5. 至少 7 个 section，每个 section 至少 1-3 个具体 bullet。\n"
        + "6. 结论必须具体到：当前 setup 偏多/偏空/混合/不明确，信心等级，以及最关键的验证条件。"
    )


def _target_language_instruction(language_mode: str | None) -> str:
    mode = str(language_mode or "chinese").strip().lower()
    if mode == "english_only":
        return "Answer in English. Keep the same section structure and cite news items as [1], [2]."
    if mode == "bilingual":
        return "Answer mainly in Chinese, but keep ticker symbols, indicator names, event types, and important headlines in English when clearer."
    return "用中文回答。保留 ticker、RSI、EMA20、EMA50、price level、event type 等英文/数字术语。"


def build_ai_prompt(
    symbol: str,
    current_price,
    chart_view: str,
    chart_config: dict,
    signal_data: dict,
    news_items: list,
    news_sentiment: dict,
    risk_analysis: dict,
    alerts: dict,
    volume_context: dict | None = None,
    stock_news_context_text: str | None = None,
    stock_news_overall_text: str | None = None,
    language_mode: str | None = "chinese",
    dashboard_ai_mode: str | None = "balanced",
    output_length: str | None = "medium",
) -> str:
    """Build a specific, evidence-first Dashboard analyst prompt.

    v6 deliberately avoids a broad "AI summary" request. It gives the model an
    analyst-brief contract, forces numbered news citations, and asks for concrete
    technical/news alignment so the output is not just a tone label.
    """
    hourly = signal_data.get("1H", {}).get("snapshot", {})
    daily = signal_data.get("Daily", {}).get("snapshot", {})
    position = risk_analysis.get("position", {})
    news_titles = "\n".join([f"- {item.get('title', '')}" for item in news_items[:8]])
    volume_context = volume_context or {}
    volume_summary = volume_context.get("summary", "Volume context is unavailable.")
    stock_news_context_text = stock_news_context_text or "- No recent stock-specific news context found."
    stock_news_overall_text = stock_news_overall_text or "- No aggregate news snapshot available."

    h_close = hourly.get("close")
    d_close = daily.get("close")
    h_trend = classify_trend(current_price or h_close, hourly.get("ema20"), hourly.get("ema50"))
    d_trend = classify_trend(current_price or d_close, daily.get("ema20"), daily.get("ema50"))
    h_rsi_label = classify_rsi(hourly.get("rsi"))
    d_rsi_label = classify_rsi(daily.get("rsi"))
    language_instruction = _target_language_instruction(language_mode)
    dashboard_ai_mode = _normalize_dashboard_ai_mode(dashboard_ai_mode)
    output_length = _normalize_output_length(output_length)

    is_english = str(language_mode or "").strip().lower() == "english_only"

    if dashboard_ai_mode == "fast":
        if is_english:
            mode_instruction = (
                "Mode: Fast / Compact. Output only the most critical conclusions, "
                "prefer 1-3 news citations, avoid long paragraphs, best for small/slow local models."
            )
            length_instruction = "Keep it within 350-650 words."
        else:
            mode_instruction = (
                "Mode: Fast / Compact. 只输出最关键的结论，优先使用 1-3 条新闻证据，"
                "避免长段落，适合本地小模型或慢模型。"
            )
            length_instruction = "控制在 350-650 中文字以内。"
    elif dashboard_ai_mode == "detailed":
        if is_english:
            mode_instruction = (
                "Mode: Detailed Analyst. Write a fuller analyst note; you may use more news "
                "evidence, but it must stay specific, structured, and non-generic."
            )
            length_instruction = "Keep it within 1000-1600 words."
        else:
            mode_instruction = (
                "Mode: Detailed Analyst. 输出更完整的 analyst note，可以使用更多新闻证据，"
                "但仍然必须具体、结构化、避免空泛。"
            )
            length_instruction = "控制在 1000-1600 中文字以内。"
    else:
        if is_english:
            mode_instruction = (
                "Mode: Balanced. Balance speed and depth; suitable for qwen2.5:14b or similar local models."
            )
            length_instruction = "Keep it within 650-1100 words."
        else:
            mode_instruction = (
                "Mode: Balanced. 在速度和分析深度之间平衡，适合 qwen2.5:14b 或类似本地模型。"
            )
            length_instruction = "控制在 650-1100 中文字以内。"

    if output_length == "short":
        length_instruction += (
            " User selected Short output; prioritize brevity."
            if is_english
            else " 用户选择 Short 输出，优先简洁。"
        )
    elif output_length == "long":
        length_instruction += (
            " User selected Long output; you may expand key evidence appropriately."
            if is_english
            else " 用户选择 Long 输出，可以适当展开关键证据。"
        )

    if is_english:
        opening_line = (
            f"You are MarketAgentPro's Dashboard AI Analyst. Analyze {symbol} in a short, "
            "specific, evidence-driven way."
        )
        hard_rules = (
            "- Always cite news numbers like [1], [2]; if evidence is insufficient, say so directly.\n"
            "- Do not only output Tone / Negative / Positive / Neutral.\n"
            "- Tie every judgment to concrete news, RSI, EMA20/EMA50, risk level, alerts, or price conditions.\n"
            "- Never give guaranteed buy/sell advice; give setup judgment, risk, and watch conditions."
        )
        output_instruction = "Output exactly the Markdown structure below. Follow the mode and length requirements above:"
        section_template = """## 0. One-line conclusion
- Setup: bullish / bearish / mixed / unclear
- Confidence: High / Medium / Low
- Core reason: mention news citation + 1H/Daily technicals together.

## 1. News synthesis
- Overall recent-news lean: positive / negative / mixed / insufficient evidence.
- Key news: use 2-3 bullets citing [1], [2]; explain "what happened + why it moves the stock".
- Confidence limits: which items are headline-only and which need source confirmation.

## 2. Technical verification
- 1H: explain short-term strength with EMA20/EMA50/RSI.
- Daily: explain medium-term trend with EMA20/EMA50/RSI.
- Does the technical picture confirm the news direction? supporting / conflicting / unconfirmed.

## 3. Position & risk
- If there is a position, explain risk with average cost, unrealized P/L, and alerts.
- If no position, state this is a watchlist-only analysis.

## 4. Watch next
- Give 3 concrete watch items: one price/technical condition, one news/event condition, one risk condition."""
    else:
        opening_line = f"你是 MarketAgentPro 的 Dashboard AI Analyst。请用短、具体、证据驱动的方式分析 {symbol}。"
        hard_rules = (
            "- 必须引用新闻编号，例如 [1], [2]；如果新闻证据不足，直接说明。\n"
            "- 不要只输出 Tone / Negative / Positive / Neutral。\n"
            "- 每个判断都要绑定具体新闻、RSI、EMA20/EMA50、risk level、alerts 或价格条件。\n"
            "- 不给保证性买卖建议；只给 setup 判断、风险和观察条件。"
        )
        output_instruction = "请严格按以下 Markdown 输出。遵守上面的模式和长度要求："
        section_template = """## 0. 一句话结论
- Setup: 偏多 / 偏空 / 混合 / 不明确
- Confidence: High / Medium / Low
- 核心原因：必须同时提到新闻编号 + 1H/Daily 技术面。

## 1. 新闻综合判断
- 最近新闻整体偏向：利好 / 利空 / 混合 / 证据不足。
- 关键新闻：用 2-3 个 bullet 引用 [1], [2]，说明"发生了什么 + 为什么影响股价"。
- 信心限制：哪些只是 headline-only，哪些需要原文确认。

## 2. 技术面验证
- 1H：结合 EMA20/EMA50/RSI 说明短线强弱。
- Daily：结合 EMA20/EMA50/RSI 说明中期趋势。
- 技术面是否确认新闻方向：支持 / 冲突 / 尚未确认。

## 3. 仓位与风险
- 如果有持仓，结合 average cost、unrealized P/L、alerts 说明风险。
- 如果没有持仓，说明这是 watchlist-only analysis。

## 4. 接下来关注
- 给出 3 个具体 watch items：一个价格/技术条件、一个新闻/事件条件、一个风险条件。"""

    return f"""
{opening_line}

{language_instruction}
{mode_instruction}
{length_instruction}

Hard rules:
{hard_rules}

【Stock / Price】
- Symbol: {symbol}
- Current Price: {format_price(current_price)}
- Chart View: {chart_view}; Interval: {chart_config.get("interval")}; Session: {chart_config.get("session_label")}

【Technicals】
- 1H: Close {format_price(h_close)}, EMA20 {format_price(hourly.get("ema20"))}, EMA50 {format_price(hourly.get("ema50"))}, RSI {hourly.get("rsi")} ({h_rsi_label}), Trend {h_trend}
- Daily: Open {format_price(daily.get("open"))}, Close {format_price(d_close)}, EMA20 {format_price(daily.get("ema20"))}, EMA50 {format_price(daily.get("ema50"))}, RSI {daily.get("rsi")} ({d_rsi_label}), Trend {d_trend}
- Volume: {volume_summary}

【Position / Risk】
- Shares: {position.get("shares")}; Avg Cost: {format_price(position.get("cost_price"))}; Unrealized P/L: {format_price(position.get("unrealized_pl"))} ({format_pct(position.get("unrealized_pl_pct"))})
- Risk Level: {risk_analysis.get("risk_level")}; Risk Points: {risk_analysis.get("risk_points")}
- Risk Reasons: {risk_analysis.get("reasons")}
- Alerts Triggered: {alerts.get("triggered")}
- Alerts Watching: {alerts.get("watching")}

【Aggregate News Snapshot】
{stock_news_overall_text}

【Numbered News Evidence】
{stock_news_context_text}

{output_instruction}

{section_template}
""".strip()

def list_ollama_models(timeout: int = 3) -> list[str]:
    """Return local Ollama model names, if the Ollama server is running."""
    try:
        response = requests.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=timeout)
        response.raise_for_status()
        models = response.json().get("models", [])
        names = []
        for model in models:
            name = model.get("name")
            if name:
                names.append(name)
        return sorted(list(dict.fromkeys(names)))
    except Exception:
        return []


def test_ollama_model(model: str, num_ctx: int = 4096, temperature: float = 0.3) -> dict:
    """Run a tiny Ollama test prompt and return a UI-friendly status payload."""
    if not model:
        return {"ok": False, "message": "No model selected."}

    try:
        response = requests.post(
            f"{OLLAMA_BASE_URL}/api/generate",
            json={
                "model": model,
                "prompt": "Reply with exactly: OK",
                "stream": False,
                "options": {
                    "num_ctx": int(num_ctx or 4096),
                    "temperature": float(temperature if temperature is not None else 0.3),
                },
            },
            timeout=45,
        )
        response.raise_for_status()
        text = response.json().get("response", "").strip()
        return {"ok": True, "message": text or "Model responded successfully."}
    except Exception as e:
        return {"ok": False, "message": str(e)}




def test_ai_provider(ai_settings: dict | None = None) -> dict:
    """Test the selected AI provider and return a UI-friendly status payload."""
    ai_settings = ai_settings or {}
    provider = get_ai_provider(ai_settings)
    if provider == "off":
        return {
            "ok": True,
            "message": (
                "AI is Off. Core app, English source news, rule-based summaries, "
                "portfolio, and options remain available."
            ),
        }
    if provider == "ollama":
        return test_ollama_model(
            model=ai_settings.get("ollama_model") or "qwen2.5:14b",
            num_ctx=int(ai_settings.get("ollama_num_ctx") or 4096),
            temperature=float(ai_settings.get("ollama_temperature") or 0.3),
        )
    if provider == "openai":
        return test_openai_model(
            api_key=ai_settings.get("openai_api_key"),
            model=ai_settings.get("openai_model"),
            base_url=ai_settings.get("openai_base_url"),
        )
    if provider == "anthropic":
        return test_anthropic_model(
            api_key=ai_settings.get("anthropic_api_key"),
            model=ai_settings.get("anthropic_model"),
            base_url=ai_settings.get("anthropic_base_url"),
        )
    return {"ok": False, "message": f"Unsupported AI provider: {provider}"}


def call_ai_model(prompt: str, ai_settings: dict | None = None) -> str:
    """Provider-aware non-streaming AI call. v11 uses capability settings."""
    ai_settings = ai_settings or {}
    provider = get_ai_provider(ai_settings)
    capabilities = get_dashboard_ai_capabilities(ai_settings)
    if provider == "off":
        return (
            "AI provider is Off. Connect Ollama Local or another provider in "
            "AI Settings to enable generated AI summaries."
        )
    if provider == "ollama":
        return call_ollama(
            prompt=prompt,
            model=ai_settings.get("ollama_model") or "qwen2.5:14b",
            num_ctx=int(ai_settings.get("ollama_num_ctx") or 16384),
            temperature=float(ai_settings.get("ollama_temperature") or 0.3),
            num_predict=int(capabilities.get("num_predict") or 900),
        )
    if provider == "openai":
        return call_openai(
            prompt=prompt,
            api_key=ai_settings.get("openai_api_key"),
            model=ai_settings.get("openai_model"),
            base_url=ai_settings.get("openai_base_url"),
            temperature=float(ai_settings.get("ollama_temperature") or 0.3),
            num_predict=int(capabilities.get("num_predict") or 900),
        )
    if provider == "anthropic":
        return call_anthropic(
            prompt=prompt,
            api_key=ai_settings.get("anthropic_api_key"),
            model=ai_settings.get("anthropic_model"),
            base_url=ai_settings.get("anthropic_base_url"),
            temperature=float(ai_settings.get("ollama_temperature") or 0.3),
            num_predict=int(capabilities.get("num_predict") or 900),
        )
    return f"Unsupported AI provider: {provider}"


def call_ai_model_stream(prompt: str, ai_settings: dict | None = None):
    """Yield text chunks from the selected AI provider using capability settings."""
    ai_settings = ai_settings or {}
    provider = get_ai_provider(ai_settings)
    capabilities = get_dashboard_ai_capabilities(ai_settings)
    if provider == "off":
        yield (
            "AI provider is Off. Connect Ollama Local or another provider in "
            "AI Settings to enable generated AI summaries."
        )
        return
    if provider == "ollama":
        yield from call_ollama_stream(
            prompt=prompt,
            model=ai_settings.get("ollama_model") or "qwen2.5:14b",
            num_ctx=int(ai_settings.get("ollama_num_ctx") or 8192),
            temperature=float(ai_settings.get("ollama_temperature") or 0.3),
            num_predict=int(capabilities.get("num_predict") or 900),
        )
        return
    if provider == "openai":
        yield from call_openai_stream(
            prompt=prompt,
            api_key=ai_settings.get("openai_api_key"),
            model=ai_settings.get("openai_model"),
            base_url=ai_settings.get("openai_base_url"),
            temperature=float(ai_settings.get("ollama_temperature") or 0.3),
            num_predict=int(capabilities.get("num_predict") or 900),
        )
        return
    if provider == "anthropic":
        yield from call_anthropic_stream(
            prompt=prompt,
            api_key=ai_settings.get("anthropic_api_key"),
            model=ai_settings.get("anthropic_model"),
            base_url=ai_settings.get("anthropic_base_url"),
            temperature=float(ai_settings.get("ollama_temperature") or 0.3),
            num_predict=int(capabilities.get("num_predict") or 900),
        )
        return
    yield f"Unsupported AI provider: {provider}"


def test_openai_model(
    api_key: str | None = None,
    model: str | None = None,
    base_url: str | None = None,
) -> dict:
    """Run a tiny OpenAI chat completion to verify the key and model."""
    api_key = (api_key or OPENAI_API_KEY or "").strip()
    model = (model or OPENAI_MODEL or "gpt-4o-mini").strip()
    base_url = (base_url or OPENAI_BASE_URL or "https://api.openai.com/v1").strip().rstrip("/")
    if not api_key:
        return {"ok": False, "message": "No OpenAI API key provided. Enter it in AI Settings."}
    try:
        response = requests.post(
            f"{base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
                "max_tokens": 4,
                "temperature": 0,
            },
            timeout=45,
        )
        response.raise_for_status()
        text = (
            (response.json().get("choices") or [{}])[0]
            .get("message", {})
            .get("content", "")
            .strip()
        )
        return {"ok": True, "message": text or f"OpenAI connection OK (model {model})."}
    except Exception as exc:
        return {"ok": False, "message": str(exc)}


def test_anthropic_model(
    api_key: str | None = None,
    model: str | None = None,
    base_url: str | None = None,
) -> dict:
    """Run a tiny Anthropic message request to verify the key and model."""
    api_key = (api_key or ANTHROPIC_API_KEY or "").strip()
    model = (model or ANTHROPIC_MODEL or "claude-3-5-sonnet-latest").strip()
    base_url = (base_url or ANTHROPIC_BASE_URL or "https://api.anthropic.com/v1").strip().rstrip("/")
    if not api_key:
        return {"ok": False, "message": "No Anthropic API key provided. Enter it in AI Settings."}
    try:
        response = requests.post(
            f"{base_url}/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
                "max_tokens": 8,
                "temperature": 0,
            },
            timeout=45,
        )
        response.raise_for_status()
        parts = response.json().get("content") or []
        text = "".join(p.get("text", "") for p in parts if p.get("type") == "text").strip()
        return {"ok": True, "message": text or f"Anthropic connection OK (model {model})."}
    except Exception as exc:
        return {"ok": False, "message": str(exc)}


def call_openai(
    prompt: str,
    api_key: str | None = None,
    model: str | None = None,
    base_url: str | None = None,
    temperature: float = 0.3,
    num_predict: int | None = None,
) -> str:
    """Non-streaming OpenAI chat completion. Returns text or an error string."""
    api_key = (api_key or OPENAI_API_KEY or "").strip()
    model = (model or OPENAI_MODEL or "gpt-4o-mini").strip()
    base_url = (base_url or OPENAI_BASE_URL or "https://api.openai.com/v1").strip().rstrip("/")
    if not api_key:
        return "OpenAI AI summary failed: missing API key. Enter your OpenAI API key in AI Settings."
    try:
        response = requests.post(
            f"{base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": float(temperature if temperature is not None else 0.3),
                **({"max_tokens": int(num_predict)} if num_predict else {}),
            },
            timeout=(10, 300),
        )
        response.raise_for_status()
        text = (
            (response.json().get("choices") or [{}])[0]
            .get("message", {})
            .get("content", "")
            .strip()
        )
        if not text:
            return "OpenAI AI summary failed: empty response from OpenAI."
        return text
    except Exception as exc:
        return f"OpenAI AI summary failed: {exc}"


def call_openai_stream(
    prompt: str,
    api_key: str | None = None,
    model: str | None = None,
    base_url: str | None = None,
    temperature: float = 0.3,
    num_predict: int | None = None,
):
    """Stream OpenAI chat completion chunks (SSE)."""
    api_key = (api_key or OPENAI_API_KEY or "").strip()
    model = (model or OPENAI_MODEL or "gpt-4o-mini").strip()
    base_url = (base_url or OPENAI_BASE_URL or "https://api.openai.com/v1").strip().rstrip("/")
    if not api_key:
        yield "OpenAI AI summary failed: missing API key. Enter your OpenAI API key in AI Settings."
        return
    try:
        response = requests.post(
            f"{base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "stream": True,
                "temperature": float(temperature if temperature is not None else 0.3),
                **({"max_tokens": int(num_predict)} if num_predict else {}),
            },
            stream=True,
            timeout=(10, 300),
        )
        response.raise_for_status()
        for raw_line in response.iter_lines(decode_unicode=True):
            if not raw_line:
                continue
            line = raw_line.strip()
            if line.startswith("data:"):
                line = line[5:].strip()
            if not line or line == "[DONE]":
                continue
            try:
                payload = json.loads(line)
            except Exception:
                continue
            if payload.get("error"):
                yield f"\n\nOpenAI AI summary failed: {payload.get('error')}"
                return
            chunk = (payload.get("choices") or [{}])[0].get("delta", {}).get("content") or ""
            if chunk:
                yield chunk
    except Exception as exc:
        yield f"OpenAI AI summary failed: {exc}"


def call_anthropic(
    prompt: str,
    api_key: str | None = None,
    model: str | None = None,
    base_url: str | None = None,
    temperature: float = 0.3,
    num_predict: int | None = None,
) -> str:
    """Non-streaming Anthropic messages API call. Returns text or an error string."""
    api_key = (api_key or ANTHROPIC_API_KEY or "").strip()
    model = (model or ANTHROPIC_MODEL or "claude-3-5-sonnet-latest").strip()
    base_url = (base_url or ANTHROPIC_BASE_URL or "https://api.anthropic.com/v1").strip().rstrip("/")
    if not api_key:
        return "Anthropic AI summary failed: missing API key. Enter your Anthropic API key in AI Settings."
    try:
        response = requests.post(
            f"{base_url}/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": int(num_predict or 1024),
                "temperature": float(temperature if temperature is not None else 0.3),
            },
            timeout=(10, 300),
        )
        response.raise_for_status()
        parts = response.json().get("content") or []
        text = "".join(p.get("text", "") for p in parts if p.get("type") == "text").strip()
        if not text:
            return "Anthropic AI summary failed: empty response from Anthropic."
        return text
    except Exception as exc:
        return f"Anthropic AI summary failed: {exc}"


def call_anthropic_stream(
    prompt: str,
    api_key: str | None = None,
    model: str | None = None,
    base_url: str | None = None,
    temperature: float = 0.3,
    num_predict: int | None = None,
):
    """Stream Anthropic messages chunks (SSE content_block_delta events)."""
    api_key = (api_key or ANTHROPIC_API_KEY or "").strip()
    model = (model or ANTHROPIC_MODEL or "claude-3-5-sonnet-latest").strip()
    base_url = (base_url or ANTHROPIC_BASE_URL or "https://api.anthropic.com/v1").strip().rstrip("/")
    if not api_key:
        yield "Anthropic AI summary failed: missing API key. Enter your Anthropic API key in AI Settings."
        return
    try:
        response = requests.post(
            f"{base_url}/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": int(num_predict or 1024),
                "temperature": float(temperature if temperature is not None else 0.3),
                "stream": True,
            },
            stream=True,
            timeout=(10, 300),
        )
        response.raise_for_status()
        for raw_line in response.iter_lines(decode_unicode=True):
            if not raw_line:
                continue
            line = raw_line.strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                return
            try:
                payload = json.loads(data)
            except Exception:
                continue
            if payload.get("type") == "error":
                error = payload.get("error") or {}
                yield f"\n\nAnthropic AI summary failed: {error.get('message') or error}"
                return
            if payload.get("type") == "content_block_delta":
                text = (payload.get("delta") or {}).get("text") or ""
                if text:
                    yield text
            if payload.get("type") == "message_stop":
                return
    except Exception as exc:
        yield f"Anthropic AI summary failed: {exc}"


def call_ollama_stream(
    prompt: str,
    model: str = "qwen2.5:14b",
    num_ctx: int = 8192,
    temperature: float = 0.3,
    num_predict: int = 900,
):
    """Stream Ollama /api/generate chunks.

    This prevents Streamlit from showing only an endless spinner while a local
    model is working. We also cap dashboard generation length with num_predict,
    because the brief should be useful rather than extremely long.
    """
    try:
        response = requests.post(
            f"{OLLAMA_BASE_URL}/api/generate",
            json={
                "model": model,
                "prompt": prompt,
                "stream": True,
                "options": {
                    "num_ctx": int(num_ctx or 8192),
                    "temperature": float(temperature if temperature is not None else 0.3),
                    "num_predict": int(num_predict or 900),
                },
            },
            stream=True,
            timeout=(10, 300),
        )
        response.raise_for_status()
        for raw_line in response.iter_lines(decode_unicode=True):
            if not raw_line:
                continue
            try:
                payload = json.loads(raw_line)
            except Exception:
                continue
            if payload.get("error"):
                yield f"\n\nOllama AI summary failed: {payload.get('error')}"
                return
            chunk = payload.get("response") or ""
            if chunk:
                yield chunk
            if payload.get("done"):
                return
    except Exception as e:
        yield f"Ollama AI summary failed: {e}"

def call_ollama(prompt: str, model: str = "qwen2.5:14b", num_ctx: int = 16384, temperature: float = 0.3, num_predict: int | None = None) -> str:
    try:
        response = requests.post(
            f"{OLLAMA_BASE_URL}/api/generate",
            json={
                "model": model,
                "prompt": prompt,
                "stream": False,
                "options": {
                    "num_ctx": int(num_ctx or 4096),
                    "temperature": float(temperature if temperature is not None else 0.3),
                    **({"num_predict": int(num_predict)} if num_predict else {}),
                },
            },
            timeout=300,
        )
        response.raise_for_status()
        text = response.json().get("response", "").strip()
        if not text:
            return "Ollama AI summary failed: empty response from Ollama."
        return text
    except Exception as e:
        return f"Ollama AI summary failed: {e}"


def build_rule_based_summary(symbol, current_price, signal_data, news_sentiment, risk_analysis, alerts) -> str:
    hourly = signal_data.get("1H", {}).get("snapshot", {})
    daily = signal_data.get("Daily", {}).get("snapshot", {})
    h_trend = classify_trend(current_price or hourly.get("close"), hourly.get("ema20"), hourly.get("ema50"))
    d_trend = classify_trend(current_price or daily.get("close"), daily.get("ema20"), daily.get("ema50"))
    h_rsi_label = classify_rsi(hourly.get("rsi"))
    d_rsi_label = classify_rsi(daily.get("rsi"))
    alert_count = len(alerts.get("triggered", []))

    return (
        f"{symbol} current risk is {risk_analysis.get('risk_level')}. "
        f"1H trend is {h_trend} with RSI status {h_rsi_label}. "
        f"Daily trend is {d_trend} with RSI status {d_rsi_label}. "
        f"Recent news tone is {news_sentiment.get('label')}. "
        f"Triggered alerts: {alert_count}. "
        f"This is a reference summary, not financial advice."
    )


def build_no_ai_dashboard_summary(symbol, current_price, signal_data, news_sentiment, risk_analysis, alerts, stock_news_context=None) -> str:
    """English source-only fallback shown when AI Provider is Off."""
    base = build_rule_based_summary(symbol, current_price, signal_data, news_sentiment, risk_analysis, alerts)
    stock_news_context = stock_news_context or []
    news_count = len(stock_news_context)
    top_titles = []
    for article in stock_news_context[:3]:
        title = article.get("original_title") or article.get("translated_title_zh") or "Untitled"
        event = article.get("event_type") or "General"
        impact = article.get("impact") or "Unclear"
        top_titles.append(f"- {title} ({event}, {impact})")
    news_block = "\n".join(top_titles) if top_titles else "- No stock-specific news evidence found yet."
    return (
        "**AI Provider: Off — source-only fallback**\n\n"
        + base
        + "\n\n"
        + f"Recent source-news items detected: {news_count}. No translation or LLM analysis was generated.\n"
        + news_block
        + "\n\nConnect Ollama Local in AI Settings to enable Chinese translation and news-integrated analyst summaries."
    )
