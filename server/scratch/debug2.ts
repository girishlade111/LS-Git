import { loadConfig } from '../src/config.js'
process.env.LSGIT_SCRYPT_N ??= '512'
import { buildApp } from '../src/http/app.js'
import { PASSWORD } from '../test/helpers.js'

// Repro 1: verifyEmail 500
const app1 = buildApp(loadConfig({ env:'test', secret:'s'.repeat(40), databaseFile:':memory:', secureCookies:false }), ':memory:')
const reg = await app1.inject({ method:'POST', url:'/api/v1/auth/register', payload:{ username:'alice', email:'alice@example.com', password:PASSWORD } })
console.log('register:', reg.statusCode)
const mail = app1.store.outbox.drain()[0]!
const token = String(mail.body).match(/token=([A-Za-z0-9_-]+)/)![1]
const v = await app1.inject({ method:'POST', url:'/api/v1/auth/verify-email', payload:{ verification_token: token } })
console.log('verify:', v.statusCode, v.body)
if (v.statusCode === 500) {
  try { app1.identity.verifyEmail(token) } catch (e) { console.log('direct error:', e) }
}

// Repro 2: bob login
const app2 = buildApp(loadConfig({ env:'test', secret:'t'.repeat(40), databaseFile:':memory:', secureCookies:false }), ':memory:')
await app2.inject({ method:'POST', url:'/api/v1/auth/register', payload:{ username:'alice', email:'alice@example.com', password:PASSWORD } })
const a = await app2.inject({ method:'POST', url:'/api/v1/auth/login', payload:{ login:'alice', password:PASSWORD } })
console.log('alice relogin:', a.statusCode, a.cookies.length)
const breg = await app2.inject({ method:'POST', url:'/api/v1/auth/register', payload:{ username:'bob', email:'bob@example.com', password:PASSWORD } })
console.log('bob register:', breg.statusCode)
const b = await app2.inject({ method:'POST', url:'/api/v1/auth/login', payload:{ login:'bob', password:PASSWORD } })
console.log('bob login:', b.statusCode, b.cookies.length, b.body.slice(0,200))
process.exit(0)
