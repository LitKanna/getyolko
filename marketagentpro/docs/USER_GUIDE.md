# MarketAgentPro 使用说明（中文）

MarketAgentPro 是一个本地运行的美股研究工具：自选股看板、K 线、技术指标、
持仓管理、期权策略、新闻聚合，以及 AI 分析师摘要。

> 本项目仅用于研究和参考，不构成投资建议。

---

## 一、运行方式

### 方式 1：源码运行

```powershell
py -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
streamlit run app.py
```

浏览器打开 `http://127.0.0.1:8501`。

### 方式 2：EXE 运行

1. 先构建：`.\build_exe.ps1`，生成 `dist\MarketAgentPro.exe`。
2. 双击 EXE，会自动启动本地服务并打开浏览器。
3. 用户数据保存在 EXE 旁边的 `data` 文件夹。

> 分发 EXE 前请删除 `dist\.env`，里面可能有你自己的 API key。

---

## 二、页面说明

| 页面 | 功能 |
| --- | --- |
| **Dashboard** | 多股票图表（Today / 2 Days / Month / 52 Weeks）、成交量、EMA20/50、RSI、风险等级、警报、AI 分析师摘要、新闻证据 |
| **Portfolio** | 持仓、交易记录、盈亏、止盈止损警报、期权策略（Alpaca 期权快照/链） |
| **News** | 市场新闻 + 个股新闻（Google News），本地缓存，可选 AI 翻译和影响标记 |

---

## 三、侧边栏

### 自选股管理

- **Add Symbol**：输入代码（如 `MU`）添加自选股。
- **Delete Selected Symbol**：删除自选股（不影响持仓）。
- **Display Stocks**：选择要在 Dashboard 显示的股票。

### AI 设置（AI Settings）

支持 4 种模式：

| 模式 | 说明 |
| --- | --- |
| Off / No AI | 不调用大模型，仅规则摘要 |
| Ollama Local | 本地 Ollama 模型（有 `.env` 时默认） |
| OpenAI (GPT) | 填入你自己的 OpenAI API Key |
| Anthropic (Claude) | 填入你自己的 Anthropic API Key |

云服务商（OpenAI / Claude）配置步骤：

1. 在 **AI Provider** 选择 OpenAI 或 Anthropic；
2. 填入 **API Key**（密码框，留空则保留已保存/`.env` 的值）；
3. 可修改模型名和 API Base URL；
4. 点 **Test AI** 验证连接；
5. 点 **Save AI** 保存到本地 `data` 文件夹。

Key 只保存在本机 `data/marketagentpro_settings.json`，不会上传。

### Alpaca / Market Data 面板

让用户使用自己的 Alpaca 免费 key：

1. 展开侧边栏 **Alpaca / Market Data**；
2. 选择 `Alpaca (my own keys)`；
3. 输入 API Key ID 和 Secret Key；
4. 选 Data Feed（免费用户用 `iex`）、Options Feed（免费用户用 `indicative`）；
5. 点 **Test** 验证，再点 **Save & Activate** 立即生效。

不填 key 时默认用 yfinance，无需任何账号。

---

## 四、AI Summary 使用

在 Dashboard 的个股区域展开 **AI Summary** 面板：

1. 在侧边栏 AI Settings 选择语言模式：`English only` / `Chinese summary` /
   `Bilingual`；
2. 点击 **Run / Refresh Detailed AI Analyst Summary**；
3. 等待生成（本地 Ollama 通常 5~60 秒；云端取决于网络和模型）；
4. 摘要基于本地缓存的新闻 + 1H/Daily 技术面，使用缓存新闻，不实时抓取头条。

### 常见状态

- `ok`：生成成功。
- `weak_saved`：已生成，但被判定可能偏泛，仍会显示。
- `interrupted`：上一次运行被页面刷新打断；新版会自动重试一次。
- `error` / `empty`：模型调用失败或返回空，检查 AI 设置和网络。

### 常见问题

| 现象 | 处理 |
| --- | --- |
| 摘要显示两遍 | 已修复（生成完会清空临时显示框），重新打包 EXE 后生效 |
| 点 Run 跑一半变 interrupted | 已修复（点击后不再挂载 auto-refresh 定时器 + 自动重试一次） |
| English only 仍输出中文 | 已修复（英文模式下章节结构全部切换为英文） |
| 图表无数据、AI 区域不显示 | 检查网络 / Alpaca key / 行情源 |
| EXE 读不到 `.env` | 已修复（EXE 会读取自身目录下的 `.env`） |

---

## 五、数据与隐私

- 所有设置、持仓、交易、新闻缓存都保存在本地 `data/` 目录（已被 git 忽略）。
- `.env` 包含密钥，永远不会提交到 Git。
- 在界面里填写的 API key 只保存在本机。
- 删除 `data/` 等于重置应用数据。

---

## 六、常见配置（.env）

复制 `.env.example` 为 `.env` 后按需修改：

```text
MARKET_DATA_PROVIDER=yfinance        # yfinance 或 alpaca
ALPACA_API_KEY=
ALPACA_SECRET_KEY=
ALPACA_DATA_FEED=iex

AI_PROVIDER=ollama                    # off / ollama / openai / anthropic
OLLAMA_MODEL=qwen2.5:14b
OPENAI_MODEL=gpt-4o-mini
ANTHROPIC_MODEL=claude-3-5-sonnet-latest
```
