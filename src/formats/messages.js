import {
  assistantMessage,
  imagePartFromDataUrl,
  reasoningPart,
  textPart,
  toCcTool,
  toolCallPart,
  toolResultMessage,
  userMessage,
} from '../cc.js'
import { HttpError, anthropicError } from '../errors.js'
import { gatewayEvents, normalizedEvents } from '../gateway.js'
import {
  isRecord,
  joinText,
  log,
  newId,
  nonEmptyString,
  pseudoThinkingSignature,
  sendJson,
  stringifyArguments,
} from '../util.js'

export function parseMessagesRequest(body, config) {
  if (!isRecord(body)) throw new HttpError(400, 'request body must be a JSON object')
  const model = nonEmptyString(body.model)
  if (!model) throw new HttpError(400, 'model is required')
  const rawMessages = Array.isArray(body.messages) ? body.messages : []
  if (rawMessages.length === 0) throw new HttpError(400, 'messages is required')

  const system = joinText(body.system)
  const toolNames = buildMessagesToolNameMap(rawMessages)
  const messages = []

  for (const message of rawMessages) {
    if (!isRecord(message)) continue
    if (message.role === 'assistant') {
      const parts = []
      for (const block of blocksOf(message.content)) {
        if (block.type === 'text') parts.push(textPart(block.text))
        else if (block.type === 'thinking' && typeof block.thinking === 'string') parts.push(reasoningPart(block.thinking))
        else if (block.type === 'tool_use') parts.push(toolCallPart(block.id, block.name, block.input))
      }
      if (parts.length > 0) messages.push(assistantMessage(parts))
      continue
    }

    const toolMessages = []
    const userParts = []
    for (const block of blocksOf(message.content)) {
      if (block.type === 'tool_result') {
        toolMessages.push(toolResultMessage(
          block.tool_use_id,
          toolNames.get(block.tool_use_id),
          joinText(block.content),
          block.is_error === true,
        ))
      } else if (block.type === 'text') {
        userParts.push(textPart(block.text))
      } else if (block.type === 'image' && isRecord(block.source)) {
        if (block.source.type === 'base64' && typeof block.source.data === 'string') {
          userParts.push(imagePartFromDataUrl(`data:${block.source.media_type || 'image/png'};base64,${block.source.data}`))
        } else if (block.source.type === 'url' && typeof block.source.url === 'string') {
          userParts.push(imagePartFromDataUrl(block.source.url))
        }
      }
    }
    messages.push(...toolMessages)
    const user = userMessage(userParts)
    if (user) messages.push(user)
  }

  const tools = []
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    if (!isRecord(tool) || !nonEmptyString(tool.name)) continue
    tools.push(toCcTool(tool.name, tool.description, tool.input_schema))
  }

  return {
    model,
    system,
    messages,
    tools,
    maxTokens: firstNumber(body.max_tokens) ?? config.maxTokens,
    temperature: firstNumber(body.temperature),
    topP: firstNumber(body.top_p),
    reasoningEffort: effortOf(body),
    stream: body.stream === true,
  }
}

function effortOf(body) {
  const effort = firstString(
    isRecord(body.thinking) ? body.thinking.effort : undefined,
    isRecord(body.output_config) ? body.output_config.effort : undefined,
  )
  if (effort) return effort
  const budget = isRecord(body.thinking) ? firstNumber(body.thinking.budget_tokens) : undefined
  if (budget === undefined) return undefined
  if (budget >= 32000) return 'max'
  if (budget >= 16000) return 'high'
  if (budget >= 8000) return 'medium'
  return 'low'
}

function blocksOf(content) {
  if (typeof content === 'string') return content.length > 0 ? [{ type: 'text', text: content }] : []
  return Array.isArray(content) ? content.filter(isRecord) : []
}

function buildMessagesToolNameMap(rawMessages) {
  const map = new Map()
  for (const message of rawMessages) {
    if (!isRecord(message) || message.role !== 'assistant') continue
    for (const block of blocksOf(message.content)) {
      if (block.type === 'tool_use' && nonEmptyString(block.id)) map.set(block.id, block.name)
    }
  }
  return map
}

export async function handleMessages({ body, config, apiKey, signal, res }) {
  const request = parseMessagesRequest(body, config)
  const id = newId('msg_')
  const iterator = normalizedEvents(gatewayEvents(request, { ...config, apiKey }, signal))[Symbol.asyncIterator]()

  if (!request.stream) {
    try {
      const result = await collectMessages(iterator, request, id)
      sendJson(res, 200, result)
    } catch (error) {
      sendJson(res, error.status ?? 502, anthropicError(error))
    } finally {
      await iterator.return?.().catch(() => {})
    }
    return
  }

  let first
  try {
    first = await iterator.next()
  } catch (error) {
    sendJson(res, error.status ?? 502, anthropicError(error))
    await iterator.return?.().catch(() => {})
    return
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })

  const state = { index: -1, open: null, thinking: '' }
  await emit(res, 'message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: request.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })

  let current = first
  let finishReason = 'stop'
  let usage
  try {
    while (!current.done) {
      const event = current.value
      if (event.type === 'text') {
        if (state.open !== 'text') await openAnthropicBlock(res, state, 'text')
        await emit(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: state.index,
          delta: { type: 'text_delta', text: event.text },
        })
      } else if (event.type === 'reasoning') {
        if (state.open !== 'thinking') await openAnthropicBlock(res, state, 'thinking')
        state.thinking += event.text
        await emit(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: state.index,
          delta: { type: 'thinking_delta', thinking: event.text },
        })
      } else if (event.type === 'tool_call') {
        await openAnthropicBlock(res, state, 'tool', {
          type: 'tool_use',
          id: event.id,
          name: event.name,
          input: {},
        })
        await emit(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: state.index,
          delta: { type: 'input_json_delta', partial_json: stringifyArguments(event.input) },
        })
        await closeAnthropicBlock(res, state)
      } else if (event.type === 'usage') {
        usage = event.usage
      } else if (event.type === 'finish') {
        finishReason = event.reason
      }
      current = await iterator.next()
    }

    await closeAnthropicBlock(res, state)
    await emit(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: anthropicStopReason(finishReason), stop_sequence: null },
      usage: { output_tokens: usage?.outputTokens ?? 0 },
    })
    await emit(res, 'message_stop', { type: 'message_stop' })
  } catch (error) {
    log('messages stream error:', error.message)
    await emit(res, 'error', anthropicError(error))
  } finally {
    res.end()
    await iterator.return?.().catch(() => {})
  }
}

async function collectMessages(iterator, request, id) {
  const content = []
  let text = ''
  let thinking = ''
  let finishReason = 'stop'
  let usage

  for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
    if (event.type === 'text') text += event.text
    else if (event.type === 'reasoning') thinking += event.text
    else if (event.type === 'tool_call') {
      if (thinking.length > 0) {
        content.push({ type: 'thinking', thinking, signature: pseudoThinkingSignature(thinking) })
        thinking = ''
      }
      if (text.length > 0) {
        content.push({ type: 'text', text })
        text = ''
      }
      content.push({ type: 'tool_use', id: event.id, name: event.name, input: event.input ?? {} })
    } else if (event.type === 'usage') usage = event.usage
    else if (event.type === 'finish') finishReason = event.reason
  }

  if (thinking.length > 0) content.push({ type: 'thinking', thinking, signature: pseudoThinkingSignature(thinking) })
  if (text.length > 0) content.push({ type: 'text', text })

  return {
    id,
    type: 'message',
    role: 'assistant',
    model: request.model,
    content,
    stop_reason: anthropicStopReason(finishReason),
    stop_sequence: null,
    usage: {
      input_tokens: usage?.inputTokens ?? 0,
      output_tokens: usage?.outputTokens ?? 0,
    },
  }
}

async function openAnthropicBlock(res, state, type, block) {
  await closeAnthropicBlock(res, state)
  state.index += 1
  state.open = type
  state.thinking = ''
  const contentBlock = block ?? (type === 'text'
    ? { type: 'text', text: '' }
    : type === 'thinking'
      ? { type: 'thinking', thinking: '' }
      : { type: 'tool_use', id: '', name: '', input: {} })
  await emit(res, 'content_block_start', {
    type: 'content_block_start',
    index: state.index,
    content_block: contentBlock,
  })
}

async function closeAnthropicBlock(res, state) {
  if (state.open === null) return
  if (state.open === 'thinking') {
    await emit(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: state.index,
      delta: { type: 'signature_delta', signature: pseudoThinkingSignature(state.thinking) },
    })
  }
  await emit(res, 'content_block_stop', { type: 'content_block_stop', index: state.index })
  state.open = null
}

function anthropicStopReason(reason) {
  if (reason === 'tool_calls') return 'tool_use'
  if (reason === 'length') return 'max_tokens'
  return 'end_turn'
}

async function emit(res, event, payload) {
  if (res.destroyed || res.writableEnded) return
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
  if (!res.write(frame)) await new Promise((resolve) => res.once('drain', resolve))
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
