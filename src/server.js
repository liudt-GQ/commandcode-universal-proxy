#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { loadConfig } from './config.js'
import { anthropicError, openAIError } from './errors.js'
import { handleChat } from './formats/chat.js'
import { handleMessages } from './formats/messages.js'
import { handleResponses } from './formats/responses.js'
import { listModels, toOpenAIModel } from './models.js'
import { log, readJsonBody, sendJson, setCors } from './util.js'

export function createProxyServer(config) {
  return createServer(async (req, res) => {
    setCors(res, config.corsAllowOrigin)
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method === 'GET' && (path === '/health' || path === '/healthz')) {
      sendJson(res, 200, {
        status: 'ok',
        service: 'commandcode-universal-proxy',
        baseURL: config.baseURL,
        modelFilter: config.modelFilter || 'none',
      })
      return
    }

    if (config.proxyAuthToken) {
      const provided = req.headers['x-proxy-token']
      if (provided !== config.proxyAuthToken) {
        sendJson(res, 401, { error: { message: 'missing or invalid x-proxy-token', type: 'auth_error' } })
        return
      }
    }

    if (req.method === 'GET' && path === '/v1/models') {
      try {
        const models = await listModels(config)
        sendJson(res, 200, { object: 'list', data: models.map(toOpenAIModel) })
      } catch (error) {
        sendJson(res, 502, { error: { message: error.message, type: 'upstream_error' } })
      }
      return
    }

    if (req.method !== 'POST') {
      sendJson(res, 404, { error: { message: `no route for ${req.method} ${path}`, type: 'not_found' } })
      return
    }

    try {
      const apiKey = extractApiKey(req) || config.apiKey
      if (!apiKey) {
        sendJson(res, 401, { error: { message: 'missing Command Code API key (Authorization: Bearer user_xxx or x-api-key)', type: 'auth_error' } })
        return
      }

      const body = await readJsonBody(req, config.maxBodyBytes)
      const controller = new AbortController()
      res.on('close', () => {
        if (!res.writableEnded) controller.abort(new Error('client disconnected'))
      })

      if (path === '/v1/chat/completions') {
        await handleChat({ body, config, apiKey, signal: controller.signal, res })
        return
      }
      if (path === '/v1/messages') {
        await handleMessages({ body, config, apiKey, signal: controller.signal, res })
        return
      }
      if (path === '/v1/responses') {
        await handleResponses({ body, config, apiKey, signal: controller.signal, res })
        return
      }

      sendJson(res, 404, { error: { message: `no route for POST ${path}`, type: 'not_found' } })
    } catch (error) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end()
        return
      }
      const status = error.status ?? 500
      const formatter = path === '/v1/messages' ? anthropicError : openAIError
      if (status >= 500) log(`${req.method} ${path} failed:`, error.stack || error.message)
      sendJson(res, status, formatter(error))
    }
  })
}

function extractApiKey(req) {
  const authorization = req.headers.authorization
  if (typeof authorization === 'string' && authorization.length > 0) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization)
    if (match) return match[1].trim()
    if (!authorization.includes(' ')) return authorization.trim()
  }
  const apiKey = req.headers['x-api-key']
  if (typeof apiKey === 'string' && apiKey.length > 0) return apiKey.trim()
  const ccKey = req.headers['cc-api-key']
  if (typeof ccKey === 'string' && ccKey.length > 0) return ccKey.trim()
  return undefined
}

function main() {
  if (existsSync('.env')) process.loadEnvFile('.env')
  const config = loadConfig()
  const server = createProxyServer(config)
  server.listen(config.port, config.host, () => {
    log(`commandcode-universal-proxy listening on http://${config.host}:${config.port}`)
    log(`upstream: ${config.baseURL}  model filter: ${config.modelFilter || 'none (all plans)'}`)
    if (!config.proxyAuthToken) {
      log('inbound auth: disabled (clients must send their own Command Code API key)')
    }
    log('endpoints: POST /v1/chat/completions, POST /v1/messages, POST /v1/responses, GET /v1/models')
  })
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      log(`${signal} received, shutting down`)
      server.close(() => process.exit(0))
    })
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
}
