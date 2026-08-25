process.env.LSGIT_SCRYPT_N = '512'
const { makeApp, registerUser, loginRaw, extractSession, authed } = await import('./test/helpers.js')
const app = makeApp()
await registerUser(app)
const s = extractSession((await loginRaw(app, 'alice')).cookies)
await authed(app, 'POST', '/api/v1/projects', { session: s, payload: { name: 'P', path: 'p', visibility: 'public', description: '', website_url: '', default_branch: 'main', topics: [], initialize_with_readme: true } })
const pid = app.store.projects.byOwnerPath('alice', 'p').id
const c = await authed(app, 'POST', `/api/v1/projects/${pid}/repository/commit`, { session: s, payload: { branch: 'f2', new_branch: 'f2', start_branch: 'main', commit_message: 'x', changes: [{ path: 'other.txt', content: 'x' }] } })
console.log('commit:', JSON.stringify(c.json()))
const pr = await authed(app, 'POST', `/api/v1/projects/${pid}/pull_requests`, { session: s, payload: { title: 'T', source_branch: 'f2', target_branch: 'main' } })
const body = pr.json()
console.log('merge_status:', body.merge_status, 'reason:', body.merge_status_reason)
