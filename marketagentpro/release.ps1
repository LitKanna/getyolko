<#
.SYNOPSIS
    一键发布 MarketAgentPro：构建 EXE -> 推送代码 -> 创建 GitHub Release 并上传 EXE。

.DESCRIPTION
    脚本会按顺序执行：
      1. 检查 GitHub CLI (gh) 已安装并已登录；
      2. 检查工作区是否干净（有未提交改动时中止，除非 -AllowDirty）；
      3. 推送当前分支到远端；
      4. 构建 EXE（build_exe.ps1，可用 -SkipBuild 跳过）；
      5. 生成/确认版本号并创建 GitHub Release，把 EXE 作为下载资产上传。

.EXAMPLE
    .\release.ps1
    # 自动取最新 tag 的 patch+1（例如 v1.0.0 -> v1.0.1），构建并发布

.EXAMPLE
    .\release.ps1 -Version v1.0.1 -Title "MarketAgentPro v1.0.1" -Draft
    # 指定版本，创建草稿 Release（确认后再手动发布）

.EXAMPLE
    .\release.ps1 -SkipBuild -AllowDirty
    # 不重新构建、允许未提交改动，直接用现有 dist\MarketAgentPro.exe 发布
#>
[CmdletBinding()]
param(
    [string]$Version,
    [string]$Title,
    [string]$Notes,
    [switch]$Draft,
    [switch]$SkipBuild,
    [switch]$AllowDirty
)

$ErrorActionPreference = "Stop"
$ProjectRoot = $PSScriptRoot
Set-Location $ProjectRoot

Write-Host "==> 1/6 检查 GitHub CLI ..."
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw "未找到 GitHub CLI (gh)。请先安装：winget install --id GitHub.cli"
}
& gh auth status *> $null
if ($LASTEXITCODE -ne 0) {
    throw "gh 未登录。请先运行：gh auth login（或 gh auth login --with-token）"
}

Write-Host "==> 2/6 检查 git 工作区 ..."
if (-not (Test-Path ".git")) {
    throw "当前目录不是 git 仓库。"
}
$dirty = git status --porcelain
if ($dirty -and -not $AllowDirty) {
    throw "工作区有未提交改动。请先提交，或使用 -AllowDirty 跳过检查。`n$dirty"
}
$branch = git branch --show-current
if (-not $branch) {
    throw "无法确定当前分支。"
}
if (-not (git remote)) {
    throw "未配置 git remote (origin)。请先添加远端。"
}

Write-Host "==> 3/6 推送代码到远端 ($branch) ..."
git push 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "推送远端失败。请检查网络或凭据。"
}

Write-Host "==> 4/6 确定版本号 ..."
if (-not $Version) {
    $latest = (& gh release list --limit 1 --json tagName --jq '.[0].tagName' 2>$null) | Select-Object -First 1
    if ($latest -match '^v?(\d+)\.(\d+)\.(\d+)$') {
        $Version = "v{0}.{1}.{2}" -f $matches[1], $matches[2], ([int]$matches[3] + 1)
    } else {
        $Version = "v1.0.0"
    }
    Write-Host "    未指定版本，自动使用: $Version"
} else {
    if ($Version -notmatch '^v') { $Version = "v$Version" }
    Write-Host "    使用指定版本: $Version"
}

Write-Host "==> 5/6 构建 EXE ..."
if (-not $SkipBuild) {
    & "$ProjectRoot\build_exe.ps1"
    if ($LASTEXITCODE -ne 0) {
        throw "构建失败。请查看上方日志。"
    }
} else {
    Write-Host "    已跳过构建 (-SkipBuild)。"
}
$exe = Join-Path $ProjectRoot "dist\MarketAgentPro.exe"
if (-not (Test-Path $exe)) {
    throw "未找到 $exe，请先构建（去掉 -SkipBuild）。"
}
$exeSizeMB = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host "    EXE 就绪: $exe ($exeSizeMB MB)"

if (-not $Title) { $Title = "MarketAgentPro $Version" }
if (-not $Notes) {
    $date = Get-Date -Format "yyyy-MM-dd"
    $Notes = @"
## MarketAgentPro $Version

- 发布日期：$date
- 双击 EXE 运行；Alpaca / OpenAI / Claude 等 API key 在应用内填写，只保存在本地。
- 源码与使用说明见仓库 README。

> 本工具仅供研究参考，不构成投资建议。
"@
}

Write-Host "==> 6/6 创建 GitHub Release ..."
$ghArgs = @(
    "release", "create", $Version,
    $exe,
    "--target", $branch,
    "--title", $Title,
    "--notes", $Notes
)
if ($Draft) { $ghArgs += "--draft" }
& gh @ghArgs
if ($LASTEXITCODE -ne 0) {
    throw "创建 Release 失败（版本 $Version 可能已存在）。"
}

Write-Host ""
Write-Host "发布完成: https://github.com/Lazyend123/marketagentpro_modular/releases/tag/$Version"
if ($Draft) {
    Write-Host "（这是草稿 Release，请到发布页确认后点击 Publish release。）"
}
