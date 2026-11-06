import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { loadConfig } from '../src/config.js'

const KEYS = ['HOST', 'COMMANDCODE_API_KEY', 'PROXY_AUTH_TOKEN', 'PORT', 'CC_CONFIG']

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

test('allows a non-loopback bind without a token when the server has no key', () => {
  withEnv({ HOST: '0.0.0.0' }, () => {
    const config = loadConfig()
    assert.equal(config.host, '0.0.0.0')
    assert.equal(config.apiKey, '')
    assert.equal(config.proxyAuthToken, '')
  })
})

test('refuses to expose a server-side key without an inbound token', () => {
  withEnv({ HOST: '0.0.0.0', COMMANDCODE_API_KEY: 'user_test' }, () => {
    assert.throws(() => loadConfig(), /PROXY_AUTH_TOKEN/)
  })
})

test('allows a server-side key when an inbound token is configured', () => {
  withEnv({ HOST: '0.0.0.0', COMMANDCODE_API_KEY: 'user_test', PROXY_AUTH_TOKEN: '0123456789abcdef' }, () => {
    const config = loadConfig()
    assert.equal(config.apiKey, 'user_test')
    assert.equal(config.proxyAuthToken, '0123456789abcdef')
  })
})
