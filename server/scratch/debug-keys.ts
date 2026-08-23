/* Debug scratch — traces a hanging POST /api/v1/user/keys request. */
import { makeApp, registerUser, authed, PASSWORD } from '../test/helpers.js'

const app = makeApp()
const reg = await app.inject({
  method: 'POST', url: '/api/v1/auth/register',
  payload: { username: 'alice', email: 'alice@example.com', password: PASSWORD },
})
console.log('register:', reg.statusCode)

function ed25519Line(): string {
  const typeStr = Buffer.from('ssh-ed25519')
  const keyBytes = Buffer.alloc(32)
  keyBytes.fill(1)
  const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), typeStr, Buffer.from([0, 0, 0, 32]), keyBytes])
  return `ssh-ed25519 ${blob.toString('base64')} dev@machine`
}

console.log('sending keys POST...')
const res = await authed(app, 'POST', '/api/v1/user/keys', {
  session: {
    cookie: `lsgit_session=${reg.cookies.find((c) => c.name === 'lsgit_session')!.value}; lsgit_csrf=${reg.cookies.find((c) => c.name === 'lsgit_csrf')!.value}`,
    csrf: reg.cookies.find((c) => c.name === 'lsgit_csrf')!.value,
  },
  payload: { title: 'work laptop', key: ed25519Line() },
})
console.log('keys POST:', res.statusCode, JSON.stringify(res.json()))
process.exit(0)
