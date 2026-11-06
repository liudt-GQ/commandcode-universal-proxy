import {
  assistantMessage,
  buildToolNameMap,
  imagePartFromDataUrl,
  reasoningPart,
  safeParseJson,
  textPart,
  toCcTool,
  toolCallPart,
  toolResultMessage,
  userMessage,
} from '../cc.js'
import { HttpError, openAIError } from '../errors.js'
import { gatewayEvents, normalizedEvents } from '../gateway.js'
import {
  isRecord,
  joinText,
  log,
  newId,
  nonEmptyString,
  nowSeconds,
  sendJson,
  sse,
  stringifyArguments,
} from '../util.js'

export function parseChatRequest(body, config) {
  if (!isRecord(body)) throw new HttpError(400, 'request body must be a JSON object')
  const model = nonEmptyString(body.model)
  if (!model) throw new HttpError(400, 'model is required')
  const rawMessages = Array.isArray(body.messages) ? body.messages : []
  if (rawMessages.length === 0) throw new HttpError(400, 'messages is required')

  let system = ''
  const toolNames = buildChatToolNameMap(rawMessages)
  const messages = []

  for (const message of rawMessages) {
    if (!isRecord(message)) continue
    const role = message.role
    if (role === 'system' || role === 'developer') {
      system += (system ? '\n\n' : '') + joinText(message.content)
      continue
    }
    if (role === 'user') {
      const msg = userMessage(chatUserParts(message.content))
      if (msg) messages.push(msg)
      continue
    }
    if (role === 'assistant') {
      const parts = []
      if (typeof message.content === 'string') {
        if (message.content.length > 0) parts.push(textPart(message.content))
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (isRecord(part) && typeof part.text === 'string' && (part.type === 'text' || part.type === 'output_text')) {
            parts.push(textPart(part.text))
          }
        }
      }
      if (typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0) {
        parts.push(reasoningPart(message.reasoning_content))
      }
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          if (!isRecord(call)) continue
          const fn = isRecord(call.function) ? call.function : {}
          parts.push(toolCallPart(call.id, fn.name, safeParseJson(fn.arguments)))
        }
      }
      if (parts.length > 0) messages.push(assistantMessage(parts))
      continue
    }
    if (role === 'tool') {
      const callId = message.tool_call_id
      const value = joinText(message.content)
      messages.push(toolResultMessage(callId, message.name ?? toolNames.get(callId), value, false))
    }
  }

  const tools = []
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    if (!isRecord(tool)) continue
    const fn = tool.type === 'function' && isRecord(tool.function) ? tool.function : tool
    if (!nonEmptyString(fn.name)) continue
    tools.push(toCcTool(fn.name, fn.description, fn.parameters))
  }

  const maxTokens = firstNumber(body.max_tokens, body.max_completion_tokens) ?? config.maxTokens
  const reasoningEffort = firstString(
    body.reasoning_effort,
    isRecord(body.reasoning) ? body.reasoning.effort : undefined,
    isRecord(body.thinking) ? body.thinking.effort : undefined,
  )

  return {
    model,
    system,
    messages,
    tools,
    maxTokens,
    temperature: firstNumber(body.temperature),
    topP: firstNumber(body.top_p),
    reasoningEffort,
    stream: body.stream === true,
    includeUsage: isRecord(body.stream_options) && body.stream_options.include_usage === true,
  }
}

function buildChatToolNameMap(rawMessages) {
  const map = new Map()
  for (const message of rawMessages) {
    if (!isRecord(message) || message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue
    for (const call of message.tool_calls) {
      if (!isRecord(call) || !nonEmptyString(call.id)) continue
      const name = isRecord(call.function) ? call.function.name : undefined
      map.set(call.id, name)
    }
  }
  return map
}

function chatUserParts(content) {
  if (typeof content === 'string') return content.length > 0 ? [textPart(content)] : []
  if (!Array.isArray(content)) return []
  const parts = []
  for (const part of content) {
    if (typeof part === 'string') {
      if (part.length > 0) parts.push(textPart(part))
      continue
    }
    if (!isRecord(part)) continue
    if ((part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') && typeof part.text === 'string') {
      parts.push(textPart(part.text))
      continue
    }
    if (part.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
      if (typeof url === 'string' && url.length > 0) parts.push(imagePartFromDataUrl(url))
      continue
    }
    if (part.type === 'image') {
      if (isRecord(part.source) && part.source.type === 'base64' && typeof part.source.data === 'string') {
        const mediaType = part.source.media_type || 'image/png'
        parts.push(imagePartFromDataUrl(`data:${mediaType};base64,${part.source.data}`))
      } else if (typeof part.image === 'string') {
        parts.push(imagePartFromDataUrl(part.image))
      }
    }
  }
  return parts
}

export async function handleChat({ body, config, apiKey, signal, res }) {
  const request = parseChatRequest(body, config)
  const id = newId('chatcmpl-')
  const created = nowSeconds()
  const iterator = normalizedEvents(gatewayEvents(request, { ...config, apiKey }, signal))[Symbol.asyncIterator]()

  if (!request.stream) {
    try {
      const result = await collectChat(iterator, request, id, created)
      sendJson(res, 200, result)
    } catch (error) {
      const status = error.status ?? 502
      sendJson(res, status, openAIError(error))
    } finally {
      await iterator.return?.().catch(() => {})
    }
    return
  }

  let first
  try {
    first = await iterator.next()
  } catch (error) {
    sendJson(res, error.status ?? 502, openAIError(error))
    await iterator.return?.().catch(() => {})
    return
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  await write(res, sse({
    id,
    object: 'chat.completion.chunk',
    created,
    model: request.model,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  }))

  let current = first
  let toolIndex = 0
  let finishReason = 'stop'
  let usage
  try {
    while (!current.done) {
      const event = current.value
      if (event.type === 'text') {
        await write(res, sse(chatChunk(id, created, request.model, { content: event.text })))
      } else if (event.type === 'reasoning') {
        await write(res, sse(chatChunk(id, created, request.model, { reasoning_content: event.text })))
      } else if (event.type === 'tool_call') {
        await write(res, sse(chatChunk(id, created, request.model, {
          tool_calls: [{
            index: toolIndex++,
            id: event.id,
            type: 'function',
            function: { name: event.name, arguments: stringifyArguments(event.input) },
          }],
        })))
      } else if (event.type === 'usage') {
        usage = event.usage
      } else if (event.type === 'finish') {
        finishReason = event.reason
      }
      current = await iterator.next()
    }
    await write(res, sse({
      id,
      object: 'chat.completion.chunk',
      created,
      model: request.model,
      choices: [{ index: 0, delta: {}, finish_reason: openAIFinishReason(finishReason) }],
      usage: openAIUsage(usage),
    }))
    await write(res, 'data: [DONE]\n\n')
  } catch (error) {
    log('chat stream error:', error.message)
    await write(res, sse(openAIError(error)))
    await write(res, 'data: [DONE]\n\n')
  } finally {
    res.end()
    await iterator.return?.().catch(() => {})
  }
}

async function collectChat(iterator, request, id, created) {
  let text = ''
  let reasoning = ''
  const toolCalls = []
  let finishReason = 'stop'
  let usage

  for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
    if (event.type === 'text') text += event.text
    else if (event.type === 'reasoning') reasoning += event.text
    else if (event.type === 'tool_call') {
      toolCalls.push({
        id: event.id,
        type: 'function',
        function: { name: event.name, arguments: stringifyArguments(event.input) },
      })
    } else if (event.type === 'usage') usage = event.usage
    else if (event.type === 'finish') finishReason = event.reason
  }

  const message = { role: 'assistant', content: text.length > 0 ? text : toolCalls.length > 0 ? null : '' }
  if (reasoning.length > 0) message.reasoning_content = reasoning
  if (toolCalls.length > 0) message.tool_calls = toolCalls

  return {
    id,
    object: 'chat.completion',
    created,
    model: request.model,
    choices: [{ index: 0, message, finish_reason: openAIFinishReason(finishReason) }],
    usage: openAIUsage(usage),
  }
}

function chatChunk(id, created, model, delta) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: null }],
  }
}

function openAIFinishReason(reason) {
  if (reason === 'tool_calls') return 'tool_calls'
  if (reason === 'length') return 'length'
  return 'stop'
}

function openAIUsage(usage) {
  const input = usage?.inputTokens ?? 0
  const output = usage?.outputTokens ?? 0
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
    prompt_tokens_details: { cached_tokens: usage?.cacheReadTokens ?? 0 },
    completion_tokens_details: { reasoning_tokens: usage?.reasoningTokens ?? 0 },
  }
}

function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

async function write(res, data) {
  if (res.destroyed || res.writableEnded) return
  if (!res.write(data)) {
    await new Promise((resolve) => res.once('drain', resolve))
  }
}
