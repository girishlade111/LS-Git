process.env.LSGIT_SCRYPT_N = '512'
const { makeApp, registerUser, loginRaw, extractSession, authed } = await import('./test/helpers.js')
const app = makeApp()
await registerUser(app)
const s = extractSession((await loginRaw(app, 'alice')).cookies)
await authed(app, 'POST', '/api/v1/projects', { session: s, payload: { name: 'P', path: 'p', visibility: 'public', description: '', website_url: '', default_branch: 'main', topics: [], initialize_with_readme: true } })
const pid = app.store.projects.byOwnerPath('alice', 'p').id
console.log('before:', JSON.stringify(app.store.protectedBranches.listForProject(pid)))
const put = await authed(app, 'PUT', `/api/v1/projects/${pid}/repository/protected_branches`, {
  session: s,
  payload: { name: 'main', push_access_level: 'no_one' },
})
console.log('put:', put.statusCode, JSON.stringify(put.json()))
console.log('after:', JSON.stringify(app.store.protectedBranches.listForProject(pid)))
console.log('byName:', JSON.stringify(app.store.protectedBranches.byName(pid, 'main')))
