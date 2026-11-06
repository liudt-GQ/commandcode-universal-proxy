import { isRecord, log, nonEmptyString, positiveNumber } from './util.js'
import { planRank } from './config.js'

const PLAN_RANK = { go: 1, goat: 2, pro: 3, max: 4 }

let cache = { at: 0, models: [] }
let inflight

export async function listModels(config, { force = false } = {}) {
  if (!force && cache.models.length > 0 && Date.now() - cache.at < config.modelRefreshMs) {
    return filterModels(cache.models, config.modelFilter)
  }
  if (inflight) return filterModels(await inflight, config.modelFilter)

  inflight = loadModels(config)
  try {
    const models = await inflight
    cache = { at: Date.now(), models }
    return filterModels(models, config.modelFilter)
  } finally {
    inflight = undefined
  }
}

export function clearModelCache() {
  cache = { at: 0, models: [] }
}

async function loadModels(config) {
  const [providerResult, catalogResult] = await Promise.allSettled([
    fetchProviderModels(config),
    fetchCatalog(config),
  ])

  const catalog = catalogResult.status === 'fulfilled' ? catalogResult.value : new Map()
  if (catalogResult.status === 'rejected') {
    log('model catalog unavailable:', catalogResult.reason?.message || catalogResult.reason)
  }

  let provider = providerResult.status === 'fulfilled' ? providerResult.value : []
  if (providerResult.status === 'rejected') {
    log('provider model list unavailable, falling back to catalog:', providerResult.reason?.message || providerResult.reason)
  }
  if (providerResult.status === 'rejected' && catalogResult.status === 'rejected') {
    throw new Error(`could not load models: provider list and catalog both failed (${providerResult.reason?.message || providerResult.reason}; ${catalogResult.reason?.message || catalogResult.reason})`)
  }

  const byId = new Map()
  if (provider.length > 0) {
    for (const entry of provider) {
      const meta = catalog.get(entry.id)
      byId.set(entry.id, {
        id: entry.id,
        name: entry.name || meta?.name || entry.id,
        contextLength: entry.contextLength ?? meta?.contextLength,
        efforts: meta?.efforts,
        minPlan: meta?.minPlan,
      })
    }
  } else {
    for (const [id, meta] of catalog) {
      byId.set(id, {
        id,
        name: meta.name || id,
        contextLength: meta.contextLength,
        efforts: meta.efforts,
        minPlan: meta.minPlan,
      })
    }
  }

  const models = [...byId.values()].map((model) => ({
    id: model.id,
    name: model.name,
    contextLength: model.contextLength ?? config.defaultContextWindow,
    efforts: model.efforts ?? [],
    minPlan: model.minPlan ?? '',
  }))
  models.sort((a, b) => a.id.localeCompare(b.id))
  return models
}

function filterModels(models, filter) {
  if (!filter) return models
  const max = planRank(filter)
  return models.filter((model) => {
    const rank = planRankOf(model.minPlan)
    return rank === 0 || rank <= max
  })
}

function planRankOf(minPlan) {
  const head = String(minPlan || '').trim().toLowerCase().split(/\s+/)[0]
  return PLAN_RANK[head] ?? 0
}

async function fetchProviderModels(config) {
  const url = config.modelsURL || `${config.baseURL}/provider/v1/models`
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const payload = await response.json()
  if (!isRecord(payload) || !Array.isArray(payload.data)) throw new Error('unexpected response shape')
  const models = []
  for (const raw of payload.data) {
    if (!isRecord(raw)) continue
    const id = nonEmptyString(raw.id)
    if (!id) continue
    models.push({
      id,
      name: nonEmptyString(raw.name) ?? id,
      contextLength: positiveNumber(raw.context_length) ?? positiveNumber(raw.context_window),
    })
  }
  return models
}

async function fetchCatalog(config) {
  const response = await fetch(config.catalogURL, {
    headers: { accept: 'text/markdown' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return parseCatalog(await response.text())
}

export function parseCatalog(markdown) {
  const entries = new Map()
  for (const line of markdown.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue
    const cells = line.split('|').map((cell) => cell.trim())
    const id = cells[1]?.startsWith('`') ? cells[1].replace(/`/g, '') : undefined
    if (!id) continue
    const minPlan = nonEmptyString(cells[6])
    if (minPlan === undefined) continue
    entries.set(id, {
      name: cells[2] || id,
      contextLength: parseContext(cells[3]),
      efforts: parseEfforts(cells[4]),
      minPlan,
    })
  }
  return entries
}

function parseEfforts(raw) {
  const trimmed = String(raw ?? '').trim()
  if (trimmed.length === 0 || trimmed === '—' || trimmed === '-') return []
  return trimmed.split(',').map((part) => part.trim()).filter(Boolean)
}

function parseContext(raw) {
  const value = String(raw ?? '').trim()
  if (value.length === 0 || value === '—' || value === '-') return undefined
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([KkMm])?$/.exec(value)
  if (!match) return undefined
  const amount = Number(match[1])
  const unit = match[2]?.toLowerCase()
  if (unit === 'm') return Math.round(amount * 1_000_000)
  if (unit === 'k') return Math.round(amount * 1024)
  return Math.round(amount)
}

export function toOpenAIModel(model) {
  return {
    id: model.id,
    object: 'model',
    created: 0,
    owned_by: 'commandcode',
    name: model.name,
    context_length: model.contextLength,
    context_window: model.contextLength,
    ...(model.efforts?.length ? { reasoning_efforts: model.efforts } : {}),
    ...(model.minPlan ? { min_plan: model.minPlan } : {}),
  }
}
