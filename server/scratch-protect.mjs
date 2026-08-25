process.env.LSGIT_SCRYPT_N = '512'
const { makeApp, registerUser, loginRaw, extractSession, authed } = await import('./test/helpers.js')
const app = makeApp()
await registerUser(app)
const s = extractSession((await loginRaw(app, 'alice')).cookies)
await authed(app, 'POST', '/api/v1/projects', { session: s, payload: { name: 'P', path: 'p', visibility: 'public', description: '', website_url: '', default_branch: 'main', topics: [], initialize_with_readme: true } })
const pid = app.store.projects.byOwnerPath('alice', 'p').id
await authed(app, 'POST', `/api/v1/projects/${pid}/repository/commit`, { session: s, payload: { branch: 'feature', new_branch: 'feature', start_branch: 'main', commit_message: 'fc', changes: [{ path: 'f.txt', content: 'f\n' }] } })
const pr = await authed(app, 'POST', `/api/v1/projects/${pid}/pull_requests`, { session: s, payload: { title: 'T', source_branch: 'feature', target_branch: 'main' } })
console.log('pr iid:', pr.json().iid)
const put = await authed(app, 'PUT', `/api/v1/projects/${pid}/repository/protected_branches`, { session: s, payload: { name: 'main', push_access_level: 'no_one' } })
console.log('put:', put.statusCode)
console.log('rules:', JSON.stringify(app.store.protectedBranches.listForProject(pid)))
const m = await authed(app, 'POST', `/api/v1/projects/${pid}/pull_requests/${pr.json().iid}/merge`, { session: s, payload: {} })
try {
  const actor = { userId: app.store.users.byUsername('alice').id, username: 'alice', admin: false, state: 'active', via: { kind: 'session' } }
  const direct = app.pullRequests.merge(actor, pid, pr.json().iid, {})
  console.log('direct merge OK tip:', direct.new_tip)
} catch (e) {
  console.log('direct merge threw:', e.status, e.code, e.message)
}
const m2 = await authed(app, 'POST', \/api/v1/projects/\11820/pull_requests/1/merge\, { session: s, payload: {} })
console.log('http merge again:', m2.statusCode)
