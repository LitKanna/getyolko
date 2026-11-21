# MarketAgentPro Windows EXE

This project can be packaged as a Windows `.exe` with PyInstaller.

## Build

Open PowerShell in the project folder and run:

```powershell
.\build_exe.ps1
```

The output file will be:

```text
dist\MarketAgentPro.exe
```

## How It Works

The exe includes Python, Streamlit, the app code, and required Python packages.
When the user double-clicks `MarketAgentPro.exe`, it starts a local Streamlit
server on `127.0.0.1` and opens the app in the default browser. The launcher
writes an empty Streamlit email file so the console does not wait for an
address. Sign in with username `faz` and password `23532259`.

User data is stored in a `data` folder next to the exe.

## Configuration

Put a `.env` file next to `MarketAgentPro.exe` for optional settings such as:

```text
AI_PROVIDER=off
MARKET_DATA_PROVIDER=yfinance
OLLAMA_BASE_URL=http://localhost:11434
```

Ollama is not bundled. If AI summaries use Ollama, the user's machine still
needs Ollama installed and running, or the app should be configured with
`AI_PROVIDER=off`.

### Alpaca API keys (bring-your-own)

Demo users do **not** need to edit `.env` to use their own Alpaca keys. In the
app, open the sidebar expander **Alpaca / Market Data** and:

1. Choose **Alpaca (my own keys)** as the Market Data Provider.
2. Paste their Alpaca API Key ID and Secret Key (free keys work with the
   `iex` data feed).
3. Click **Test** to verify the connection, then **Save & Activate**.

Keys are stored in `data/marketagentpro_settings.json` next to the exe (the
same local data folder the app already uses) and take effect immediately,
without restarting.

Alternatively, a `.env` file next to the exe still works as a fallback:

```text
MARKET_DATA_PROVIDER=alpaca
ALPACA_API_KEY=PK...
ALPACA_SECRET_KEY=...
ALPACA_DATA_FEED=iex
```
