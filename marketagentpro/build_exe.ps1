$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

if (-not (Test-Path ".venv")) {
    py -m venv .venv
}

& ".\.venv\Scripts\python.exe" -m pip install --upgrade pip
& ".\.venv\Scripts\python.exe" -m pip install -r requirements.txt
& ".\.venv\Scripts\python.exe" -m pip install -r requirements-build.txt

& ".\.venv\Scripts\pyinstaller.exe" `
    --noconfirm `
    --clean `
    --onefile `
    --name "MarketAgentPro" `
    --add-data "app.py;." `
    --add-data "marketagent;marketagent" `
    --collect-all streamlit `
    --collect-all streamlit_autorefresh `
    --collect-all yfinance `
    --hidden-import streamlit.web.cli `
    --hidden-import streamlit.runtime.scriptrunner.magic_funcs `
    desktop_launcher.py

Write-Host ""
Write-Host "Build complete: $ProjectRoot\dist\MarketAgentPro.exe"
Write-Host "Put a .env file next to the exe if you want to configure API keys or Ollama."
