process.env.LSGIT_SCRYPT_N ??= '512'
import { makeApp, registerUser, authed } from '../test/helpers.js'

const app = makeApp()
await registerUser(app)
const s = extractSync()

async function extractSyncImpl() { return null }
function extractSync(): any {
  return null
}
void extractSyncImpl

const reg = await app.inject({ method:'POST', url:'/api/v1/auth/login', payload:{ login:'alice', password:'correct horse battery staple 42' } })
const cookie = reg.cookies.map((c)=>`${c.name}=${c.value}`).join('; ')
const csrf = reg.cookies.find(c=>c.name==='lsgit_csrf')!.value

const created = await app.inject({ method:'POST', url:'/api/v1/projects', headers:{cookie, 'x-csrf-token':csrf}, payload:{ name:'My Project', path:'my-project' } })
console.log('create:', created.statusCode)

const rename = await app.inject({ method:'POST', url:'/api/v1/projects/1/rename', headers:{cookie, 'x-csrf-token':csrf}, payload:{ path:'renamed' } })
console.log('rename:', rename.statusCode, rename.body.slice(0,300))
process.exit(0)
