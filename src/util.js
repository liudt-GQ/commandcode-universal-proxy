import { createHash, randomUUID } from 'node:crypto'

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

export function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

export function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

export function newId(prefix) {
  return `${prefix}${randomUUID().replace(/-/g, '')}`
}

export function sse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function pseudoThinkingSignature(text) {
  return createHash('sha256').update(text || 'commandcode-universal-proxy').digest('base64')
}

export function safeJsonParse(raw) {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

export function stringifyArguments(input) {
  if (input === undefined || input === null) return '{}'
  return typeof input === 'string' ? input : JSON.stringify(input)
}

export function dataUrlMediaType(url) {
  const match = /^data:([^;,]+)[;,]/.exec(typeof url === 'string' ? url : '')
  return match ? match[1] : undefined
}

export function joinText(value) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return value === undefined || value === null ? '' : String(value)
  return value
    .map((part) => {
      if (typeof part === 'string') return part
      if (!isRecord(part)) return ''
      if (typeof part.text === 'string') return part.text
      if (typeof part.content === 'string') return part.content
      return ''
    })
    .join('')
}

export function log(...args) {
  console.error(new Date().toISOString(), ...args)
}

export function setCors(res, origin) {
  if (origin) {
    res.setHeader('access-control-allow-origin', origin)
    res.setHeader('access-control-allow-headers', 'authorization, content-type, x-api-key, anthropic-version, anthropic-beta')
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
    res.setHeader('vary', 'origin')
  }
}

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

export async function readBody(req, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) {
      const error = new Error('request body too large')
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return ''
  return Buffer.concat(chunks).toString('utf8')
}

export async function readJsonBody(req, maxBytes) {
  const raw = await readBody(req, maxBytes)
  if (raw.trim().length === 0) return {}
  try {
    return JSON.parse(raw)
  } catch {
    const error = new Error('invalid JSON body')
    error.status = 400
    throw error
  }
}
