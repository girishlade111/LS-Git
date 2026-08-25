process.env.LSGIT_SCRYPT_N = '512'
const { makeApp, registerUser, loginRaw, extractSession, authed } = await import('./test/helpers.js')
const app = makeApp()
await registerUser(app)
const s = extractSession((await loginRaw(app, 'alice')).cookies)
await authed(app, 'POST', '/api/v1/projects', { session: s, payload: { name: 'P', path: 'p', visibility: 'public', description: '', website_url: '', default_branch: 'main', topics: [], initialize_with_readme: true } })
const pid = app.store.projects.byOwnerPath('alice', 'p').id
const c = await authed(app, 'POST', `/api/v1/projects/${pid}/repository/commit`, { session: s, payload: { branch: 'hotfix-target', new_branch: 'hotfix-target', start_branch: 'main', commit_message: 't', changes: [{ path: 't.txt', content: 't\n' }] } })
console.log('commit:', c.statusCode)
const res = await authed(app, 'POST', `/api/v1/projects/${pid}/pull_requests`, {
  session: s,
  payload: { title: 'Backwards PR', source_branch: 'main', target_branch: 'hotfix-target' },
})
console.log('pr status:', res.statusCode, res.body.slice(0, 200))
