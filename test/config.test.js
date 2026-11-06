import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { loadConfig } from '../src/config.js'

const KEYS = ['HOST', 'PORT', 'COMMANDCODE_API_KEY', 'PROXY_AUTH_TOKEN', 'CC_CONFIG']

function withEnv(values, fn) {
  const saved = new Map(KEYS.map((key) => [key, process.env[key]]))
  try {
    for (const key of KEYS) delete process.env[key]
    Object.assign(process.env, values)
    return fn()
  } finally {
    for (const key of KEYS) {
      const value = saved.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('allows a public bind without any server-side key or token', () => {
  withEnv({ HOST: '0.0.0.0' }, () => {
    const config = loadConfig()
    assert.equal(config.host, '0.0.0.0')
    assert.equal('apiKey' in config, false)
    assert.equal('proxyAuthToken' in config, false)
  })
})

test('ignores legacy server-side key environment variables', () => {
  withEnv({ HOST: '0.0.0.0', COMMANDCODE_API_KEY: 'user_test', PROXY_AUTH_TOKEN: '0123456789abcdef' }, () => {
    const config = loadConfig()
    assert.equal('apiKey' in config, false)
    assert.equal('proxyAuthToken' in config, false)
  })
})
