import { arch, platform } from 'node:os'
import { isRecord, log, nonEmptyString } from './util.js'

export const DEFAULT_MAX_TOKENS = 64000
export const GATEWAY_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

export class ProxyError extends Error {
  constructor(message, { status = 502, code = 'upstream_error', retryable = false } = {}) {
    super(message)
    this.name = 'ProxyError'
    this.status = status
    this.code = code
    this.retryable = retryable
  }
}

export function buildEnvelope(request) {
  const params = {
    model: request.model,
    messages: request.messages,
    tools: request.tools ?? [],
    system: request.system ?? '',
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
  }
  if (request.temperature !== undefined) params.temperature = request.temperature
  if (request.topP !== undefined) params.top_p = request.topP
  if (request.reasoningEffort !== undefined && GATEWAY_EFFORTS.has(request.reasoningEffort)) {
    params.reasoning_effort = request.reasoningEffort
  }

  return {
    config: {
      workingDir: process.cwd(),
      date: new Date().toISOString().slice(0, 10),
      environment: `${platform()}-${arch()}`,
      structure: [],
      isGitRepo: false,
      currentBranch: '',
      mainBranch: '',
      gitStatus: '',
      recentCommits: [],
    },
    memory: '',
    taste: '',
    skills: null,
    permissionMode: 'standard',
    params,
  }
}

export async function* gatewayEvents(request, config, signal) {
  const url = `${config.baseURL}/alpha/generate`
  const headers = {
    authorization: `Bearer ${config.apiKey}`,
    'content-type': 'application/json',
    'x-command-code-version': config.version,
    'x-cli-environment': 'production',
    'x-co-flag': 'false',
    'x-project-slug': config.projectSlug,
    'user-agent': 'cli',
  }

  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildEnvelope(request)),
      signal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new ProxyError(`transport error: ${error?.cause?.message || error.message}`, {
      status: 502,
      code: 'transport_error',
      retryable: true,
    })
  }

  if (!response.ok) {
    const raw = await response.text().catch(() => '')
    throw new ProxyError(`gateway answered HTTP ${response.status}${raw ? `: ${trim(raw)}` : ''}`, {
      status: mapStatus(response.status, raw),
      code: mapStatus(response.status, raw) === 401 ? 'auth_error' : 'upstream_error',
      retryable: response.status >= 500 || response.status === 429,
    })
  }
  if (!response.body) {
    throw new ProxyError('gateway returned an empty response body', { status: 502, code: 'empty_response' })
  }

  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      const event = parseLine(line, request.model)
      if (event !== undefined) yield event
    }
  }
  buffer += decoder.decode()
  const tail = parseLine(buffer.trim(), request.model)
  if (tail !== undefined) yield tail
}

function parseLine(line, model) {
  if (line.length === 0 || line === '[DONE]' || line.startsWith(':')) return undefined
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    log('ignoring non-JSON gateway line', line.slice(0, 200))
    return undefined
  }
  if (!isRecord(parsed) || typeof parsed.type !== 'string') return undefined
  if (parsed.type === 'error') {
    const detail = streamErrorDetail(parsed)
    throw new ProxyError(`${detail.message} [model=${model}]`, {
      status: mapStatus(detail.status ?? 500, detail.message),
      code: detail.code ?? 'upstream_error',
      retryable: detail.retryable,
    })
  }
  return parsed
}

function streamErrorDetail(event) {
  const error = isRecord(event.error) ? event.error : event
  const body = nonEmptyString(error.responseBody)
  const message = nonEmptyString(error.message)
    ?? (body ? gatewayErrorDetail(body) : undefined)
    ?? JSON.stringify(event)
  return {
    message: trim(message),
    status: typeof error.statusCode === 'number' ? error.statusCode : undefined,
    code: nonEmptyString(error.code),
    retryable: error.isRetryable === true,
  }
}

function gatewayErrorDetail(raw) {
  const text = raw.trim()
  if (text.length === 0) return undefined
  try {
    const parsed = JSON.parse(text)
    const envelope = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : parsed
    return nonEmptyString(envelope?.message) ?? nonEmptyString(envelope?.detail) ?? text
  } catch {
    return text
  }
}

function mapStatus(status, body) {
  if (status === 402) return 429
  if (status === 403) return 401
  if (status === 422) return 400
  if (status >= 500) return 502
  return status
}

function trim(value) {
  return String(value).slice(0, 4000)
}

export function normalizeUsage(raw) {
  const usage = isRecord(raw) ? raw : {}
  const inputDetails = isRecord(usage.inputTokenDetails) ? usage.inputTokenDetails : {}
  const outputDetails = isRecord(usage.outputTokenDetails) ? usage.outputTokenDetails : {}
  const cacheRead = numberOrUndefined(inputDetails.cacheReadTokens)
  const totalInput = numberOrUndefined(usage.inputTokens)
  const noCache = numberOrUndefined(inputDetails.noCacheTokens)
  const inputTokens = noCache ?? (totalInput !== undefined && cacheRead !== undefined
    ? Math.max(0, totalInput - cacheRead)
    : totalInput) ?? 0
  const outputTokens = numberOrUndefined(usage.outputTokens) ?? numberOrUndefined(outputDetails.textTokens) ?? 0
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: cacheRead,
    reasoningTokens: numberOrUndefined(outputDetails.reasoningTokens),
  }
}

function numberOrUndefined(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function normalizeFinishReason(raw) {
  switch (raw) {
    case 'tool_calls':
    case 'tool-calls':
    case 'tool_use':
      return 'tool_calls'
    case 'length':
    case 'max_tokens':
    case 'max-output-tokens':
    case 'max_output_tokens':
      return 'length'
    case 'stop':
    case 'end_turn':
    case 'stop_sequence':
    case undefined:
    case null:
      return 'stop'
    default:
      return 'stop'
  }
}

export async function* normalizedEvents(rawEvents) {
  let usage
  for await (const event of rawEvents) {
    switch (event.type) {
      case 'text-delta':
        if (typeof event.text === 'string' && event.text.length > 0) {
          yield { type: 'text', text: event.text }
        }
        break
      case 'reasoning-delta':
        if (typeof event.text === 'string' && event.text.length > 0) {
          yield { type: 'reasoning', text: event.text }
        }
        break
      case 'tool-call': {
        const id = nonEmptyString(event.toolCallId) ?? nonEmptyString(event.id) ?? `call_${Math.random().toString(16).slice(2, 10)}`
        const name = nonEmptyString(event.toolName) ?? ''
        const input = event.input ?? event.args ?? event.arguments ?? {}
        yield { type: 'tool_call', id, name, input }
        break
      }
      case 'finish-step':
      case 'finish': {
        usage = normalizeUsage(event.totalUsage ?? event.usage ?? usage)
        if (event.type === 'finish') {
          yield { type: 'usage', usage }
          yield { type: 'finish', reason: normalizeFinishReason(event.finishReason ?? event.rawFinishReason) }
          return
        }
        break
      }
      case 'text-start':
      case 'text-end':
      case 'reasoning-start':
      case 'reasoning-end':
      case 'start':
      case 'start-step':
      case 'provider-metadata':
      case 'tool-input-start':
      case 'tool-input-delta':
      case 'tool-input-end':
      case 'tool-error':
        break
      default:
        break
    }
  }
  yield { type: 'usage', usage: usage ?? normalizeUsage(undefined) }
  yield { type: 'finish', reason: 'stop' }
}
