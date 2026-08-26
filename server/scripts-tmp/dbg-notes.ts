import { makeApp, registerUser, authed, extractSession, loginRaw } from '../test/helpers.js'

const app = makeApp()
await registerUser(app)
const sess = extractSession((await loginRaw(app, 'alice')).cookies)
await authed(app, 'POST', '/api/v1/projects', {
  session: sess,
  payload: { name: 'Dbg2', path: 'dbg2', initialize_with_readme: true },
})
const pid = app.store.projects.byOwnerPath('alice', 'dbg2')!.id
const alice = app.store.users.byUsername('alice')!
const actor = { userId: alice.id, username: 'alice', admin: true, state: 'active' as const, via: { kind: 'session' as const } }

app.repositories.commitChanges(actor, pid, { message: 'c1', changes: [{ path: 'a', content: '1' }] })
const r1 = await authed(app, 'POST', `/api/v1/projects/${pid}/releases`, { session: sess, payload: { tag_name: 'v1.0.0' } })
console.log('rel1', r1.statusCode)
app.repositories.commitChanges(actor, pid, { message: 'c2', changes: [{ path: 'b', content: '2' }] })
const r2 = await authed(app, 'POST', `/api/v1/projects/${pid}/releases`, { session: sess, payload: { tag_name: 'v1.1.0' } })
console.log('rel2', r2.statusCode)

try {
  const out = app.releases.generateNotes(actor, pid, 'v1.1.0', { previous_tag: 'v1.0.0' })
  console.log('OK:', JSON.stringify(out).slice(0, 300))
} catch (err) {
  console.error('ERR:', err)
}
