import { dataUrlMediaType, isRecord, nonEmptyString } from './util.js'

const EMPTY_SCHEMA = { type: 'object', properties: {} }

export function toCcTool(name, description, parameters) {
  const tool = { name: String(name ?? '') }
  if (nonEmptyString(description)) tool.description = description
  tool.input_schema = isRecord(parameters) ? parameters : EMPTY_SCHEMA
  return tool
}

export function userMessage(parts) {
  if (parts.length === 0) return undefined
  if (parts.every((part) => part.type === 'text')) {
    return { role: 'user', content: parts.map((part) => part.text).join('') }
  }
  return { role: 'user', content: parts }
}

export function imagePartFromDataUrl(url) {
  const value = typeof url === 'string' ? url : ''
  const mimeType = dataUrlMediaType(value)
  const part = { type: 'image', image: value }
  if (mimeType) part.mimeType = mimeType
  return part
}

export function toolResultMessage(toolCallId, toolName, output, isError) {
  return {
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId: String(toolCallId ?? ''),
      toolName: String(toolName ?? 'unknown'),
      output: {
        type: isError ? 'error-text' : 'text',
        value: typeof output === 'string' && output.length > 0 ? output : isError ? 'Execution denied' : '(no output)',
      },
    }],
  }
}

export function assistantMessage(parts) {
  return { role: 'assistant', content: parts }
}

export function textPart(text) {
  return { type: 'text', text: String(text ?? '') }
}

export function reasoningPart(text) {
  return { type: 'reasoning', text: String(text ?? '') }
}

export function toolCallPart(id, name, input) {
  return {
    type: 'tool-call',
    toolCallId: String(id ?? ''),
    toolName: String(name ?? ''),
    input: input ?? {},
  }
}

export function buildToolNameMap(messages) {
  const names = new Map()
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type !== 'tool-call') continue
      names.set(block.toolCallId, block.toolName)
    }
  }
  return names
}

export function safeParseJson(raw) {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}
