process.env.LSGIT_SCRYPT_N ??= '512'
import { makeApp } from '../test/helpers.js'

const app = makeApp()
const reg = await app.inject({ method:'POST', url:'/api/v1/auth/register', payload:{ username:'alice', email:'alice@example.com', password:'correct horse battery staple 42' } })
console.log('register:', reg.statusCode)

const actor = { userId:1, username:'alice', admin:true, state:'active' as const, via:{ kind:'session' as const } }
app.projects.create(actor, {
  name: 'My Project', path: 'my-project', visibility: 'private',
  description: '', website_url: '', default_branch: 'main',
  initialize_with_readme: false, gitignore_template: null,
  license_template: null, topics: [], template_project_id: null,
})
try {
  const r = app.projects.rename(actor, 1, 'renamed')
  console.log('rename OK:', JSON.stringify({ path: r.project.path, redirect: r.redirectCreated }))
} catch (e) {
  console.log('rename threw:', e)
}
process.exit(0)
