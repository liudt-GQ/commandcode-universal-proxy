import { createServer } from 'node:http'

const CATALOG = `# Command Code Models

| Id (use EXACTLY this) | Name | Context | Efforts | $/1M in/out · cache read | Min plan | Best for |
|---|---|---|---|---|---|---|
| \`deepseek/deepseek-v4-flash\` | DeepSeek V4 Flash | 1M | low, high, max | $0 | Go and above | fast |
| \`claude-opus-4-8\` | Claude Opus 4.8 | 1M | low, high | $0 | Max | strong |
| \`gpt-5.6-sol\` | GPT-5.6 Sol | 1.05M | low, medium, high | $0 | GOAT and above | balanced |
`

const USAGE = {
  inputTokens: 10,
  outputTokens: 5,
  inputTokenDetails: { cacheReadTokens: 2, noCacheTokens: 8 },
  outputTokenDetails: { reasoningTokens: 2, textTokens: 3 },
}

const EVENTS = [
  { type: 'reasoning-start' },
  { type: 'reasoning-delta', text: 'Let me think.' },
  { type: 'reasoning-end' },
  { type: 'text-start' },
  { type: 'text-delta', text: 'Hello' },
  { type: 'text-delta', text: ' world' },
  { type: 'text-end' },
  { type: 'tool-call', toolCallId: 'call_abc', toolName: 'get_weather', input: { city: 'Paris' } },
  { type: 'finish-step', usage: USAGE },
  { type: 'finish', totalUsage: USAGE, finishReason: 'tool_calls' },
]

const MODELS = [
  { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', context_length: 1_000_000 },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', context_length: 1_000_000 },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', context_length: 1_050_000 },
]

export async function startFakeUpstream() {
  const state = { lastRequest: null, requests: 0 }
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/provider/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      res.end(JSON.stringify({ data: MODELS }))
      return
    }
    if (req.method === 'GET' && req.url === '/catalog.md') {
      res.writeHead(200, { 'content-type': 'text/markdown', connection: 'close' })
      res.end(CATALOG)
      return
    }
    if (req.method === 'POST' && req.url === '/alpha/generate') {
      let raw = ''
      for await (const chunk of req) raw += chunk
      state.requests += 1
      state.lastRequest = raw.length > 0 ? JSON.parse(raw) : null
      res.writeHead(200, { 'content-type': 'application/x-ndjson', connection: 'close' })
      for (const event of EVENTS) res.write(`${JSON.stringify(event)}\n`)
      res.end()
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
