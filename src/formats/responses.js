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
import { HttpError, responsesError } from '../errors.js'
import { gatewayEvents, normalizedEvents } from '../gateway.js'
import {
  isRecord,
  joinText,
  log,
  newId,
  nonEmptyString,
  nowSeconds,
  sendJson,
  stringifyArguments,
} from '../util.js'

export function parseResponsesRequest(body, config) {
  if (!isRecord(body)) throw new HttpError(400, 'request body must be a JSON object')
  const model = nonEmptyString(body.model)
  if (!model) throw new HttpError(400, 'model is required')

  let system = joinText(body.instructions)
  const messages = []
  const pendingAssistant = []
  const toolNames = new Map()

  const flushAssistant = () => {
    if (pendingAssistant.length > 0) {
      messages.push(assistantMessage(pendingAssistant.splice(0)))
    }
  }

  const input = body.input
  const items = typeof input === 'string'
    ? [{ role: 'user', content: input }]
    : Array.isArray(input) ? input : []

  for (const item of items) {
    if (typeof item === 'string') {
      flushAssistant()
      const msg = userMessage([textPart(item)])
      if (msg) messages.push(msg)
      continue
    }
    if (!isRecord(item)) continue

    if (item.type === 'function_call') {
      const id = item.call_id ?? item.id
      const name = item.name
      if (nonEmptyString(id)) toolNames.set(id, name)
      pendingAssistant.push(toolCallPart(id, name, typeof item.arguments === 'string' ? safeJson(item.arguments) : item.arguments))
      continue
    }
    if (item.type === 'function_call_output') {
      flushAssistant()
      messages.push(toolResultMessage(item.call_id, toolNames.get(item.call_id), joinText(item.output), false))
      continue
    }
    if (item.type === 'reasoning') {
      const text = reasoningText(item)
      if (text.length > 0) pendingAssistant.push(reasoningPart(text))
      continue
    }

    const role = item.role || (item.type === 'message' ? 'user' : undefined)
    if (!role) continue
    const parts = responseContentParts(item.content)
    if (role === 'system' || role === 'developer') {
      flushAssistant()
      system += (system ? '\n\n' : '') + parts.filter((part) => part.type === 'text').map((part) => part.text).join('')
      continue
    }
    if (role === 'assistant') {
      for (const part of parts) {
        if (part.type === 'text') pendingAssistant.push(part)
      }
      continue
    }
    flushAssistant()
    const msg = userMessage(parts)
    if (msg) messages.push(msg)
  }
  flushAssistant()

  const tools = []
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    if (!isRecord(tool)) continue
    const fn = tool.type === 'function' && isRecord(tool.function) ? tool.function : tool
    if (!nonEmptyString(fn.name)) continue
    tools.push(toCcTool(fn.name, fn.description, fn.parameters))
  }

  return {
    model,
    system,
    messages,
    tools,
    maxTokens: firstNumber(body.max_output_tokens) ?? config.maxTokens,
    temperature: firstNumber(body.temperature),
    topP: firstNumber(body.top_p),
    reasoningEffort: isRecord(body.reasoning) ? firstString(body.reasoning.effort) : undefined,
    stream: body.stream === true,
  }
}

function reasoningText(item) {
  if (Array.isArray(item.summary)) {
    return item.summary.map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('')
  }
  if (Array.isArray(item.content)) return joinText(item.content)
  return typeof item.text === 'string' ? item.text : ''
}

function responseContentParts(content) {
  if (typeof content === 'string') return content.length > 0 ? [textPart(content)] : []
  if (!Array.isArray(content)) return []
  const parts = []
  for (const part of content) {
    if (typeof part === 'string') {
      if (part.length > 0) parts.push(textPart(part))
      continue
    }
    if (!isRecord(part)) continue
    if ((part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
      parts.push(textPart(part.text))
    } else if (part.type === 'input_image') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
      if (typeof url === 'string' && url.length > 0) parts.push(imagePartFromDataUrl(url))
    } else if (part.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
      if (typeof url === 'string' && url.length > 0) parts.push(imagePartFromDataUrl(url))
    }
  }
  return parts
}

function safeJson(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

export async function handleResponses({ body, config, apiKey, signal, res }) {
  const request = parseResponsesRequest(body, config)
  const responseId = newId('resp_')
  const createdAt = nowSeconds()
  const iterator = normalizedEvents(gatewayEvents(request, { ...config, apiKey }, signal))[Symbol.asyncIterator]()

  if (!request.stream) {
    try {
      const result = await collectResponses(iterator, request, responseId, createdAt)
      sendJson(res, 200, result)
    } catch (error) {
      sendJson(res, error.status ?? 502, responsesError(error))
    } finally {
      await iterator.return?.().catch(() => {})
    }
    return
  }

  let first
  try {
    first = await iterator.next()
  } catch (error) {
    sendJson(res, error.status ?? 502, responsesError(error))
    await iterator.return?.().catch(() => {})
    return
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })

  const emitter = new ResponsesEmitter(res, request.model, responseId, createdAt)
  try {
    await emitter.start()
    await emitter.consume({ [Symbol.asyncIterator]: () => iterator })
    await emitter.finish()
  } catch (error) {
    log('responses stream error:', error.message)
    await emitter.emit('error', responsesError(error))
  } finally {
    if (!res.writableEnded) res.end()
    await iterator.return?.().catch(() => {})
  }
}

async function collectResponses(iterator, request, responseId, createdAt) {
  const output = []
  let open = null
  let finishReason = 'stop'
  let usage

  for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
    if (event.type === 'text') {
      if (!open || open.kind !== 'text') {
        if (open) output.push(open.item)
        open = { kind: 'text', text: '', item: messageItem(newId('msg_')) }
      }
      open.text += event.text
    } else if (event.type === 'reasoning') {
      if (!open || open.kind !== 'reasoning') {
        if (open) output.push(open.item)
        open = { kind: 'reasoning', text: '', item: reasoningItem(newId('rs_')) }
      }
      open.text += event.text
    } else if (event.type === 'tool_call') {
      if (open) {
        output.push(completeOpen(open))
        open = null
      }
      output.push(functionCallItem(newId('fc_'), event))
    } else if (event.type === 'usage') {
      usage = event.usage
    } else if (event.type === 'finish') {
      finishReason = event.reason
    }
  }
  if (open) output.push(completeOpen(open))

  return responseObject(responseId, request.model, createdAt, output, usage, finishReason)
}

function completeOpen(open) {
  if (open.kind === 'text') {
    const part = { type: 'output_text', text: open.text, annotations: [] }
    return { ...open.item, status: 'completed', content: [part] }
  }
  return {
    ...open.item,
    status: 'completed',
    summary: [{ type: 'summary_text', text: open.text }],
  }
}

function messageItem(id) {
  return { id, type: 'message', status: 'in_progress', role: 'assistant', content: [] }
}

function reasoningItem(id) {
  return { id, type: 'reasoning', status: 'in_progress', summary: [] }
}

function functionCallItem(id, call) {
  return {
    id,
    type: 'function_call',
    status: 'completed',
    call_id: call.id,
    name: call.name,
    arguments: stringifyArguments(call.input),
  }
}

function responseObject(id, model, createdAt, output, usage, finishReason = 'stop') {
  return {
    id,
    object: 'response',
    created_at: createdAt,
    status: 'completed',
    model,
    output,
    output_text: output
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === 'output_text')
      .map((part) => part.text)
      .join(''),
    usage: responseUsage(usage),
    ...(finishReason === 'length' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
  }
}

function responseUsage(usage) {
  const input = usage?.inputTokens ?? 0
  const output = usage?.outputTokens ?? 0
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: usage?.cacheReadTokens ?? 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: usage?.reasoningTokens ?? 0 },
    total_tokens: input + output,
  }
}

class ResponsesEmitter {
  constructor(res, model, responseId, createdAt) {
    this.res = res
    this.model = model
    this.responseId = responseId
    this.createdAt = createdAt
    this.output = []
    this.open = null
    this.nextIndex = 0
    this.finishReason = 'stop'
    this.usage = undefined
    this.sequence = 0
  }

  async start() {
    await this.emit('response.created', {
      response: {
        id: this.responseId,
        object: 'response',
        created_at: this.createdAt,
        status: 'in_progress',
        model: this.model,
        output: [],
      },
    })
    await this.emit('response.in_progress', {
      response: {
        id: this.responseId,
        object: 'response',
        created_at: this.createdAt,
        status: 'in_progress',
        model: this.model,
        output: [],
      },
    })
  }

  async consume(iterator) {
    for await (const event of iterator) {
      if (event.type === 'text') await this.text(event.text)
      else if (event.type === 'reasoning') await this.reasoning(event.text)
      else if (event.type === 'tool_call') await this.toolCall(event)
      else if (event.type === 'usage') this.usage = event.usage
      else if (event.type === 'finish') this.finishReason = event.reason
    }
  }

  async text(delta) {
    if (!this.open || this.open.kind !== 'text') {
      await this.closeOpen()
      const id = newId('msg_')
      const index = this.nextIndex++
      this.open = { kind: 'text', id, index, text: '', partStarted: false }
      await this.emit('response.output_item.added', {
        output_index: index,
        item: messageItem(id),
      })
      await this.emit('response.content_part.added', {
        item_id: id,
        output_index: index,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      })
    }
    this.open.text += delta
    await this.emit('response.output_text.delta', {
      item_id: this.open.id,
      output_index: this.open.index,
      content_index: 0,
      delta,
    })
  }

  async reasoning(delta) {
    if (!this.open || this.open.kind !== 'reasoning') {
      await this.closeOpen()
      const id = newId('rs_')
      const index = this.nextIndex++
      this.open = { kind: 'reasoning', id, index, text: '' }
      await this.emit('response.output_item.added', {
        output_index: index,
        item: reasoningItem(id),
      })
      await this.emit('response.reasoning_summary_part.added', {
        item_id: id,
        output_index: index,
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      })
    }
    this.open.text += delta
    await this.emit('response.reasoning_summary_text.delta', {
      item_id: this.open.id,
      output_index: this.open.index,
      summary_index: 0,
      delta,
    })
  }

  async toolCall(call) {
    await this.closeOpen()
    const id = newId('fc_')
    const index = this.nextIndex++
    const item = functionCallItem(id, call)
    await this.emit('response.output_item.added', {
      output_index: index,
      item: { ...item, status: 'in_progress', arguments: '' },
    })
    await this.emit('response.function_call_arguments.delta', {
      item_id: id,
      output_index: index,
      delta: item.arguments,
    })
    await this.emit('response.function_call_arguments.done', {
      item_id: id,
      output_index: index,
      arguments: item.arguments,
    })
    await this.emit('response.output_item.done', { output_index: index, item })
    this.output.push(item)
  }

  async closeOpen() {
    if (!this.open) return
    const open = this.open
    this.open = null
    if (open.kind === 'text') {
      const part = { type: 'output_text', text: open.text, annotations: [] }
      await this.emit('response.output_text.done', {
        item_id: open.id,
        output_index: open.index,
        content_index: 0,
        text: open.text,
      })
      await this.emit('response.content_part.done', {
        item_id: open.id,
        output_index: open.index,
        content_index: 0,
        part,
      })
      const item = { ...messageItem(open.id), status: 'completed', content: [part] }
      await this.emit('response.output_item.done', { output_index: open.index, item })
      this.output.push(item)
    } else {
      const part = { type: 'summary_text', text: open.text }
      await this.emit('response.reasoning_summary_text.done', {
        item_id: open.id,
        output_index: open.index,
        summary_index: 0,
        text: open.text,
      })
      await this.emit('response.reasoning_summary_part.done', {
        item_id: open.id,
        output_index: open.index,
        summary_index: 0,
        part,
      })
      const item = { ...reasoningItem(open.id), status: 'completed', summary: [part] }
      await this.emit('response.output_item.done', { output_index: open.index, item })
      this.output.push(item)
    }
  }

  async finish() {
    await this.closeOpen()
    await this.emit('response.completed', {
      response: responseObject(this.responseId, this.model, this.createdAt, this.output, this.usage, this.finishReason),
    })
  }

  async emit(type, payload) {
    if (this.res.destroyed || this.res.writableEnded) return
    const frame = `event: ${type}\ndata: ${JSON.stringify({ type, ...payload, sequence_number: this.sequence++ })}\n\n`
    if (!this.res.write(frame)) await new Promise((resolve) => this.res.once('drain', resolve))
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
