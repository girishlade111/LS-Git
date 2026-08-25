process.env.LSGIT_SCRYPT_N = '512'
const { makeApp, registerUser, loginRaw, extractSession, authed } = await import('./test/helpers.js')
const app = makeApp()
await registerUser(app)
const s = extractSession((await loginRaw(app, 'alice')).cookies)
await authed(app, 'POST', '/api/v1/projects', { session: s, payload: { name: 'P', path: 'p', visibility: 'public', description: '', website_url: '', default_branch: 'main', topics: [], initialize_with_readme: true } })
const pid = app.store.projects.byOwnerPath('alice', 'p').id
await authed(app, 'POST', `/api/v1/projects/${pid}/repository/commit`, { session: s, payload: { branch: 'feature', new_branch: 'feature', start_branch: 'main', commit_message: 'fc', changes: [{ path: 'f.txt', content: 'f\n' }] } })
const pr = await authed(app, 'POST', `/api/v1/projects/${pid}/pull_requests`, { session: s, payload: { title: 'T', source_branch: 'feature', target_branch: 'main' } })
const iid = pr.json().iid
await authed(app, 'PUT', `/api/v1/projects/${pid}/repository/protected_branches`, { session: s, payload: { name: 'main', push_access_level: 'no_one' } })

// Direct service call with a fresh non-admin actor.
const u = app.store.users.byUsername('alice')
const actor = { userId: u.id, username: 'alice', admin: !!u.admin, state: 'active', via: { kind: 'session' } }
console.log('actor admin flag:', actor.admin)
try {
  const direct = app.pullRequests.merge(actor, pid, iid, {})
  console.log('direct merge OK:', direct.new_tip)
} catch (e) {
  console.log('direct merge threw:', e.status, e.code)
}
