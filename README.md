# commandcode-universal-proxy

一个**零依赖、协议通用**的 Command Code 代理。把 Command Code 私有的 `POST /alpha/generate` 网关翻译成下游 harness 直接可用的标准端点：

| 端点 | 协议 | 典型客户端 |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions（SSE + 非流式） | opencode、Cline、Cherry Studio、各类 OpenAI SDK |
| `POST /v1/messages` | Anthropic Messages（SSE + 非流式） | Claude Code、各类 Anthropic SDK |
| `POST /v1/responses` | OpenAI Responses（SSE + 非流式） | Codex CLI、Responses API 客户端 |
| `GET /v1/models` | 动态模型目录 | 所有支持模型列表的客户端 |
| `GET /health` | 健康检查 | 监控 / 容器探针 |

核心特点：

- **不依赖 DSH**：任何能配置 OpenAI 或 Anthropic 兼容端点的工具都能接。
- **走 `/alpha/generate`**：Go / GOAT / Pro 等没有 Provider API 权限的订阅也能用。
- **不按计划过滤模型**：默认显示模型目录里的全部模型。想要按计划收敛时再显式设置 `CC_MODEL_FILTER`。
- **零运行时依赖**：只用 Node.js 内置模块，`node src/server.js` 即可运行。
- **流式优先**：上游 NDJSON 逐行解析，文本 / reasoning / tool call 实时转发。

---

## 快速开始

要求 Node.js `>= 22`。

```bash
# 1. 准备配置（任选其一）
cp .env.example .env
# 编辑 .env，填入 COMMANDCODE_API_KEY=user_xxxx

# 2. 启动
npm start
```

不写 `.env` 也可以直接用环境变量：

```powershell
$env:COMMANDCODE_API_KEY = "user_xxxx"
npm start
```

```bash
COMMANDCODE_API_KEY=user_xxxx npm start
```

也可以复制 `config.example.json` 为 `config.json`（查找顺序：`CC_CONFIG` 指定的路径 → 当前目录 `config.json`）。

启动后默认监听 `http://127.0.0.1:3000`。

### Docker（推荐部署方式）

```bash
# 1. 生成配置
cp .env.example .env
# 编辑 .env：设置 PROXY_AUTH_TOKEN（至少 16 位随机串）和 COMMANDCODE_API_KEY

# 2. 构建并后台启动
docker compose up -d --build

# 3. 查看状态 / 日志
docker compose ps
docker compose logs -f
```

`docker-compose.yml` 默认：

- 只发布到 `127.0.0.1:${PROXY_PORT:-3000}`，不直接暴露公网
- 强制要求 `PROXY_AUTH_TOKEN`
- 只读根文件系统 + `tmpfs /tmp` + `cap_drop: ALL` + `no-new-privileges` + 非 root 用户
- 内置 `/health` 健康检查与 `restart: unless-stopped`

容器内监听 `0.0.0.0:3000`，所以 `PROXY_AUTH_TOKEN` 是必填项。客户端请求时除上游 Key 外还要带：

```bash
curl http://127.0.0.1:3000/v1/models \
  -H "x-proxy-token: $PROXY_AUTH_TOKEN"
```

#### 不用 compose

```bash
docker build -t commandcode-universal-proxy .
docker run -d --name ccu-proxy \
  -p 127.0.0.1:3000:3000 \
  -e PROXY_AUTH_TOKEN="$(openssl rand -hex 16)" \
  -e COMMANDCODE_API_KEY="user_xxxx" \
  --read-only --tmpfs /tmp --cap-drop ALL \
  --security-opt no-new-privileges:true --init \
  --restart unless-stopped \
  commandcode-universal-proxy
```

#### 公网 / 反向代理

不要把代理端口直接暴露到公网。推荐拓扑：

```
Internet → Caddy / nginx / Cloudflare Tunnel（TLS） → 127.0.0.1:3000
```

- Caddy 示例见 [`deploy/Caddyfile`](deploy/Caddyfile)，已关闭 SSE 响应缓冲
- 或使用 Cloudflare Tunnel / Tailscale / WireGuard，完全不开放公网入站端口
- 公网场景务必保留 `PROXY_AUTH_TOKEN`，并让反代只访问本机端口

#### 客户端如何带 `x-proxy-token`

- 能自定义请求头的客户端：直接加 `x-proxy-token: <token>`
- opencode：在 provider 的 `options.headers` 里加 `"x-proxy-token": "<token>"`
- Claude Code / Codex：可让反向代理注入该头，或把 `PROXY_AUTH_TOKEN` 留空并仅监听回环地址（仅限本机）

### 预构建镜像（GHCR）

仓库内置 `.github/workflows/docker.yml`，推送到 `main`、打 `v*` tag 或手动触发时会自动构建多架构镜像：

```
ghcr.io/liudt-gq/commandcode-universal-proxy:latest
ghcr.io/liudt-gq/commandcode-universal-proxy:main
ghcr.io/liudt-gq/commandcode-universal-proxy:sha-<short>
ghcr.io/liudt-gq/commandcode-universal-proxy:<version>   # 打 vX.Y.Z tag 时
```

直接运行：

```bash
docker run -d --name ccu-proxy \
  -p 127.0.0.1:3000:3000 \
  -e PROXY_AUTH_TOKEN="$(openssl rand -hex 16)" \
  -e COMMANDCODE_API_KEY="user_xxxx" \
  --read-only --tmpfs /tmp --cap-drop ALL \
  --security-opt no-new-privileges:true --init \
  --restart unless-stopped \
  ghcr.io/liudt-gq/commandcode-universal-proxy:latest
```

> 首次发布后，GHCR 包默认可能是私有。到 GitHub 仓库 → Packages → 该镜像 → Package settings 把可见性改为 Public，匿名 `docker pull` 才可用。

### 第一次请求

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer user_xxxx" \
  -H "content-type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"你好"}]}'
```

API Key 也可以只放在代理的环境变量里，客户端随便填一个占位值即可。

---

## 客户端接入

### opencode

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "commandcode": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Command Code",
      "options": {
        "baseURL": "http://127.0.0.1:3000/v1",
        "apiKey": "user_xxxx"
      },
      "models": {
        "deepseek/deepseek-v4-flash": { "name": "DeepSeek V4 Flash" },
        "gpt-5.6-sol": { "name": "GPT-5.6 Sol" }
      }
    }
  }
}
```

模型 id 直接用 `GET /v1/models` 返回的 `id`。

### Claude Code

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:3000"
export ANTHROPIC_AUTH_TOKEN="user_xxxx"
export ANTHROPIC_MODEL="deepseek/deepseek-v4-flash"
claude
```

### Codex CLI

```bash
export OPENAI_BASE_URL="http://127.0.0.1:3000/v1"
export OPENAI_API_KEY="user_xxxx"
codex -m deepseek/deepseek-v4-flash
```

### 任意 OpenAI SDK

把 `base_url` / `baseURL` 指向 `http://127.0.0.1:3000/v1` 即可；`/v1/chat/completions` 与 `/v1/responses` 都支持流式。

---

## 模型目录

模型列表**不再写死，也不按 Go 计划过滤**。启动后第一次请求 `/v1/models` 时：

1. 拉取 `${CC_BASE_URL}/provider/v1/models` 的实时目录（无需鉴权）。
2. 从官方 CLI catalog（默认 unpkg 上的 `command-code@latest/.../reference/models.md`）合并名称、上下文长度、Reasoning Effort、Min plan。
3. 若 Provider API 不可用（Go 计划常见 403），**自动回退到 catalog 全量模型**，而不是失败或只保留 Go 模型。
4. 结果缓存 `CC_MODEL_REFRESH_MS`（默认 5 分钟）。

返回的每个模型除标准字段外还带：

```json
{
  "id": "claude-opus-4-8",
  "object": "model",
  "name": "Claude Opus 4.8",
  "context_length": 1000000,
  "context_window": 1000000,
  "reasoning_efforts": ["low", "high", "xhigh", "max"],
  "min_plan": "Max"
}
```

### 按计划收敛（可选）

默认 `CC_MODEL_FILTER=none`，显示全部模型。若你只想看到某个计划可用的模型：

```bash
CC_MODEL_FILTER=go   # 只显示 Min plan 为 Go 的模型
CC_MODEL_FILTER=goat # Go + GOAT
CC_MODEL_FILTER=pro  # Go + GOAT + Pro
CC_MODEL_FILTER=max  # 全部
```

这只是**显示层过滤**，不影响请求；模型是否可用最终由上游决定。

---

## Reasoning Effort

代理会把下游的推理档位透传给网关，只转发网关认识的 `low` / `medium` / `high` / `xhigh` / `max`：

| 下游协议 | 读取字段 |
|---|---|
| OpenAI Chat | `reasoning_effort`，或 `reasoning.effort` / `thinking.effort` |
| Anthropic Messages | `thinking.effort`、`output_config.effort`，或由 `thinking.budget_tokens` 映射 |
| OpenAI Responses | `reasoning.effort` |

Anthropic `budget_tokens` 映射规则：`>= 32000 → max`，`>= 16000 → high`，`>= 8000 → medium`，其余 `low`。

不传该字段表示让上游自行决定深度。

---

## 工具调用

三个协议都支持工具调用：

- OpenAI `tools[].function` / `tool_calls` / `role: "tool"`
- Anthropic `tools[]` / `tool_use` / `tool_result`
- Responses `tools[]` / `function_call` / `function_call_output`

上游每个 `tool-call` 事件会翻译成一个完整工具调用块。工具结果会带上从历史反查到的 `toolName`。

---

## 图片

`/alpha/generate` 是无状态网关。下游可以直接发送内联图片：

- OpenAI：`{"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}`
- Anthropic：`{"type":"image","source":{"type":"base64","media_type":"image/png","data":"..."}}`
- Responses：`{"type":"input_image","image_url":"data:image/png;base64,..."}`

推荐使用 `data:` URL / base64；代理不会替你下载远程图片。

---

## 配置

环境变量优先于 `config.json`。

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `COMMANDCODE_API_KEY` | 空 | 默认上游 Key；请求头里的 Key 优先 |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址；非回环地址必须设置 `PROXY_AUTH_TOKEN` |
| `CC_BASE_URL` | `https://api.commandcode.ai` | 上游网关，`/alpha/generate` 自动追加 |
| `CC_VERSION` | `1.74.0` | `x-command-code-version` 请求头 |
| `CC_MODEL_FILTER` | `none` | `none` / `go` / `goat` / `pro` / `max` |
| `CC_MODEL_REFRESH_MS` | `300000` | 模型目录缓存时间 |
| `CC_MODELS_URL` | 空 | 覆盖 Provider 模型列表地址 |
| `CC_CATALOG_URL` | unpkg `models.md` | 官方 catalog 地址 |
| `CC_DEFAULT_CONTEXT_WINDOW` | `262144` | catalog 没写上下文时的兜底 |
| `CC_MAX_TOKENS` | `64000` | 请求未带输出上限时的默认值 |
| `CC_MAX_BODY_MB` | `32` | 请求体上限 |
| `PROXY_AUTH_TOKEN` | 空 | 入站鉴权；设置后所有请求需带 `x-proxy-token` |
| `CORS_ALLOW_ORIGIN` | 空 | 允许的浏览器源；留空不发送 CORS 头 |
| `PROJECT_SLUG` | `commandcode-universal-proxy` | `x-project-slug` 请求头 |
| `CC_CONFIG` | 空 | 指定 `config.json` 路径 |

`config.json` 使用相同的字段名（`apiKey`、`baseURL`、`modelFilter`…）。

---

## 鉴权与安全

- 默认只绑定 `127.0.0.1`。
- 绑定非回环地址时，必须设置至少 16 位的 `PROXY_AUTH_TOKEN`，否则拒绝启动。
- 设置了 `PROXY_AUTH_TOKEN` 后，除 `/health` 外都要带 `x-proxy-token`。
- 上游 Key 按请求从 `Authorization: Bearer`、`x-api-key`、`cc-api-key` 读取，缺失时回退到 `COMMANDCODE_API_KEY`。
- 代理不落盘、不记录完整 Key。

公网部署建议放在 Caddy / nginx / Cloudflare Tunnel 后面，不要把端口直接暴露。

---

## 测试

```bash
npm test
```

测试会启动一个假上游，覆盖三种协议的流式与非流式，以及“不过滤 Max 计划模型”的行为。

---

## 与现有项目的关系

- 协议翻译参考了 [`jiesou/dsh-commandcode-go-provider`](https://github.com/jiesou/dsh-commandcode-go-provider)（MIT），去掉了 DSH 专有的 `LlmAdapter` 接口与 Go 计划过滤。
- 上游信封与流事件格式与 [`maple323/commandcode-proxy-rs`](https://github.com/maple323/commandcode-proxy-rs) 对齐，但本版是独立实现、零依赖、单进程 Node。

## License

MIT
