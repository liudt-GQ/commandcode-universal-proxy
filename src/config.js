import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const DEFAULTS = {
  port: 3000,
  host: '127.0.0.1',
  baseURL: 'https://api.commandcode.ai',
  apiKey: '',
  version: '1.74.0',
  modelsURL: '',
  catalogURL: 'https://unpkg.com/command-code@latest/dist/bundled/command-code-knowledge/reference/models.md',
  modelRefreshMs: 5 * 60 * 1000,
  modelFilter: '',
  defaultContextWindow: 262144,
  maxBodyMB: 32,
  maxTokens: 64000,
  proxyAuthToken: '',
  corsAllowOrigin: '',
  projectSlug: 'commandcode-universal-proxy',
  healthz: true,
}

function numberFrom(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function boolFrom(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase())
}

function loadFile() {
  const explicit = process.env.CC_CONFIG
  const candidates = explicit ? [resolve(explicit)] : [resolve(process.cwd(), 'config.json')]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch (error) {
      throw new Error(`failed to read ${file}: ${error.message}`)
    }
  }
  return {}
}

export function loadConfig() {
  const file = loadFile()
  const env = process.env

  const config = {
    port: numberFrom(env.PORT, numberFrom(file.port, DEFAULTS.port)),
    host: env.HOST || file.host || DEFAULTS.host,
    baseURL: normalizeBaseURL(env.CC_BASE_URL || file.baseURL || DEFAULTS.baseURL),
    apiKey: env.COMMANDCODE_API_KEY || file.apiKey || DEFAULTS.apiKey,
    version: env.CC_VERSION || file.version || DEFAULTS.version,
    modelsURL: env.CC_MODELS_URL || file.modelsURL || '',
    catalogURL: env.CC_CATALOG_URL || file.catalogURL || DEFAULTS.catalogURL,
    modelRefreshMs: numberFrom(env.CC_MODEL_REFRESH_MS, numberFrom(file.modelRefreshMs, DEFAULTS.modelRefreshMs)),
    modelFilter: normalizeFilter(env.CC_MODEL_FILTER ?? file.modelFilter ?? DEFAULTS.modelFilter),
    defaultContextWindow: numberFrom(env.CC_DEFAULT_CONTEXT_WINDOW, numberFrom(file.defaultContextWindow, DEFAULTS.defaultContextWindow)),
    maxBodyBytes: Math.floor(1024 * 1024 * numberFrom(env.CC_MAX_BODY_MB, numberFrom(file.maxBodyMB, DEFAULTS.maxBodyMB))),
    maxTokens: numberFrom(env.CC_MAX_TOKENS, numberFrom(file.maxTokens, DEFAULTS.maxTokens)),
    proxyAuthToken: env.PROXY_AUTH_TOKEN || file.proxyAuthToken || DEFAULTS.proxyAuthToken,
    corsAllowOrigin: env.CORS_ALLOW_ORIGIN || file.corsAllowOrigin || DEFAULTS.corsAllowOrigin,
    projectSlug: env.PROJECT_SLUG || file.projectSlug || DEFAULTS.projectSlug,
    logLevel: env.LOG_LEVEL || file.logLevel || 'info',
  }

  if (config.proxyAuthToken && config.proxyAuthToken.length < 16) {
    throw new Error('PROXY_AUTH_TOKEN must be at least 16 characters')
  }
  if (!isLoopback(config.host) && !config.proxyAuthToken) {
    throw new Error('refusing to bind a non-loopback address without PROXY_AUTH_TOKEN')
  }
  return config
}

export function normalizeBaseURL(value) {
  return String(value).replace(/\/+$/, '')
}

function isLoopback(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

const PLAN_RANK = { go: 1, goat: 2, pro: 3, max: 4 }

function normalizeFilter(value) {
  const filter = String(value || '').trim().toLowerCase()
  if (filter === '' || filter === 'none' || filter === 'all') return ''
  if (!(filter in PLAN_RANK)) {
    throw new Error(`unknown CC_MODEL_FILTER "${value}"; use none, go, goat, pro, or max`)
  }
  return filter
}

export function planRank(filter) {
  return PLAN_RANK[filter] ?? 0
}
