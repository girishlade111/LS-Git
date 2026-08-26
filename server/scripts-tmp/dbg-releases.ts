import { makeApp, registerUser, authed, extractSession, loginRaw } from '../test/helpers.js'

const app = makeApp()
await registerUser(app)
const sess = extractSession((await loginRaw(app, 'alice')).cookies)
const created = await authed(app, 'POST', '/api/v1/projects', {
  session: sess,
  payload: { name: 'Dbg', path: 'dbg', initialize_with_readme: true },
})
console.log('create project', created.statusCode)
const pid = app.store.projects.byOwnerPath('alice', 'dbg')!.id
const rel = await authed(app, 'POST', `/api/v1/projects/${pid}/releases`, {
  session: sess, payload: { tag_name: 'v1.0.0', draft: true },
})
console.log('create release', rel.statusCode, JSON.stringify(rel.json()).slice(0, 200))
const pub = await authed(app, 'PATCH', `/api/v1/projects/${pid}/releases/v1.0.0`, {
  session: sess, payload: { state_event: 'publish' },
})
console.log('publish', pub.statusCode, JSON.stringify(pub.json()).slice(0, 400))

// notes generation probe
const gen = await authed(app, 'POST', `/api/v1/projects/${pid}/releases/v1.0.0/notes/generate`, {
  session: sess, payload: {},
})
console.log('notes', gen.statusCode, JSON.stringify(gen.json()).slice(0, 400))
