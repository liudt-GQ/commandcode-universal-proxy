import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { createProxyServer } from '../src/server.js'
import { clearModelCache } from '../src/models.js'
import { startFakeUpstream } from './fake-upstream.js'

let upstream
let proxy
let baseURL

before(async () => {
  upstream = await startFakeUpstream()
  clearModelCache()
  proxy = createProxyServer({
    baseURL: upstream.url,
    catalogURL: `${upstream.url}/catalog.md`,
    modelsURL: '',
    version: '1.74.0',
    modelRefreshMs: 60_000,
    modelFilter: '',
    defaultContextWindow: 262_144,
    maxBodyBytes: 10 * 1024 * 1024,
    maxTokens: 64_000,
    corsAllowOrigin: '',
    projectSlug: 'test',
  })
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  baseURL = `http://127.0.0.1:${proxy.address().port}`
})

after(async () => {
  await new Promise((resolve) => proxy.close(resolve))
  await upstream.close()
})

async function post(path, body) {
  const response = await fetch(baseURL + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer user_test',
      connection: 'close',
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { response, text }
}

describe('commandcode-universal-proxy', () => {
  it('lists every model without plan filtering', async () => {
    const response = await fetch(`${baseURL}/v1/models`, { headers: { connection: 'close' } })
    assert.equal(response.status, 200)
    const payload = await response.json()
    const ids = payload.data.map((model) => model.id)
    assert.deepEqual(ids, ['claude-opus-4-8', 'deepseek/deepseek-v4-flash', 'gpt-5.6-sol'])
    const opus = payload.data.find((model) => model.id === 'claude-opus-4-8')
    assert.equal(opus.min_plan, 'Max')
    assert.equal(opus.context_length, 1_000_000)
    assert.deepEqual(opus.reasoning_efforts, ['low', 'high'])
  })

  it('requires a client-supplied Command Code key', async () => {
    const response = await fetch(`${baseURL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ model: 'deepseek/deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(response.status, 401)
    const payload = await response.json()
    assert.match(payload.error.message, /missing Command Code API key/)
  })

  it('serves OpenAI chat completions non-stream', async () => {
    const { response, text } = await post('/v1/chat/completions', {
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
      reasoning_effort: 'high',
    })
    assert.equal(response.status, 200)
    const payload = JSON.parse(text)
    assert.equal(payload.object, 'chat.completion')
    assert.equal(payload.choices[0].message.content, 'Hello world')
    assert.equal(payload.choices[0].message.reasoning_content, 'Let me think.')
    assert.equal(payload.choices[0].message.tool_calls[0].function.name, 'get_weather')
    assert.equal(payload.choices[0].finish_reason, 'tool_calls')
    assert.equal(payload.usage.prompt_tokens, 8)
    assert.equal(payload.usage.completion_tokens, 5)

    assert.equal(upstream.state.lastRequest.params.model, 'deepseek/deepseek-v4-flash')
    assert.equal(upstream.state.lastRequest.params.reasoning_effort, 'high')
    assert.equal(upstream.state.lastRequest.params.tools[0].name, 'get_weather')
    assert.equal(upstream.state.lastRequest.params.messages[0].content, 'hi')
  })

  it('streams OpenAI chat completions as SSE', async () => {
    const { response, text } = await post('/v1/chat/completions', {
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/event-stream/)
    assert.match(text, /"content":"Hello"/)
    assert.match(text, /"content":" world"/)
    assert.match(text, /"tool_calls":\[\{"index":0/)
    assert.match(text, /data: \[DONE\]/)
  })

  it('serves Anthropic messages non-stream', async () => {
    const { response, text } = await post('/v1/messages', {
      model: 'claude-opus-4-8',
      max_tokens: 256,
      system: 'be nice',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })
    assert.equal(response.status, 200)
    const payload = JSON.parse(text)
    assert.equal(payload.type, 'message')
    assert.equal(payload.stop_reason, 'tool_use')
    assert.equal(payload.content.find((block) => block.type === 'text').text, 'Hello world')
    assert.equal(payload.content.find((block) => block.type === 'thinking').thinking, 'Let me think.')
    assert.equal(payload.content.find((block) => block.type === 'tool_use').name, 'get_weather')
  })

  it('streams Anthropic messages as SSE', async () => {
    const { response, text } = await post('/v1/messages', {
      model: 'claude-opus-4-8',
      max_tokens: 256,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    })
    assert.equal(response.status, 200)
    assert.match(text, /event: message_start/)
    assert.match(text, /event: content_block_start/)
    assert.match(text, /event: message_stop/)
  })

  it('serves OpenAI Responses non-stream', async () => {
    const { response, text } = await post('/v1/responses', {
      model: 'gpt-5.6-sol',
      input: 'hi',
    })
    assert.equal(response.status, 200)
    const payload = JSON.parse(text)
    assert.equal(payload.object, 'response')
    assert.equal(payload.output_text, 'Hello world')
    assert.equal(payload.output.find((item) => item.type === 'function_call').name, 'get_weather')
    assert.equal(payload.usage.input_tokens, 8)
  })

  it('streams OpenAI Responses as SSE', async () => {
    const { response, text } = await post('/v1/responses', {
      model: 'gpt-5.6-sol',
      input: 'hi',
      stream: true,
    })
    assert.equal(response.status, 200)
    assert.match(text, /event: response\.created/)
    assert.match(text, /event: response\.output_text\.delta/)
    assert.match(text, /event: response\.completed/)
  })
})
