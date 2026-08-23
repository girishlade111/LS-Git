process.env.LSGIT_SCRYPT_N ??= '512'
import { makeApp, registerUser } from '../test/helpers.js'

const app = makeApp()
await registerUser(app)
const created = await app.inject({ method:'POST', url:'/api/v1/projects', headers:{ cookie: await login(), 'x-csrf-token': csrf() }, payload:{ name:'My Project', path:'my-project' } })
console.log('create:', created.statusCode)

async function login(): Promise<string> {
  const r = await app.inject({ method:'POST', url:'/api/v1/auth/login', payload:{ login:'alice', password:'correct horse battery staple 42' } })
  return r.cookies.map((c)=>`${c.name}=${c.value}`).join('; ')
}
function csrf(): string {
  return 'x'
}

try {
  app.projects.rename({ userId:1, username:'alice', admin:true, state:'active', via:{kind:'session'} }, 1, 'renamed')
  console.log('rename OK')
} catch (e) {
  console.log('rename threw:', e)
}
process.exit(0)
