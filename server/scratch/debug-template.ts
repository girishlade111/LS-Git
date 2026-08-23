process.env.LSGIT_SCRYPT_N ??= '512'
import { makeApp } from '../test/helpers.js'

const app = makeApp()
const actorA = { userId: 1, username: 'alice', admin: true, state: 'active' as const, via: { kind: 'session' as const } }
const r1 = await app.inject({ method:'POST', url:'/api/v1/auth/register', payload:{ username:'alice', email:'a@e.com', password:'correct horse battery staple 42' } }); console.log('regA:', r1.statusCode, r1.body.slice(0,120))
const r2 = await app.inject({ method:'POST', url:'/api/v1/auth/register', payload:{ username:'bob', email:'b@e.com', password:'correct horse battery staple 42' } }); console.log('regB:', r2.statusCode)
const actorB = { userId:2, username:'bob', admin:false, state:'active' as const, via:{ kind:'session' as const } }

app.projects.create(actorA, {
  name: 'Tpl', path: 'tpl', visibility: 'public',
  description: '', website_url: '', default_branch: 'main',
  initialize_with_readme: true, gitignore_template: null,
  license_template: null, topics: [], template_project_id: null,
})
app.projects.setTemplate(actorA, 1, true)

try {
  const p = app.projects.createFromTemplate(actorB, 1, {
    name: 'From Tpl', path: 'from-tpl', visibility: 'private',
    default_branch: 'main', topics: [],
  })
  console.log('OK:', p.path)
} catch (e) {
  console.log('THREW:', e)
}
process.exit(0)
