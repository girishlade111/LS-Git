import { GitRepository } from '../src/storage/repository.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(mkdtempSync(join(tmpdir(), 'lsgit-e2e-')), 'repo.git')
const r = GitRepository.createBare(root, 'main')
const c1 = r.applyChangesToBranch({
  baseBranch: 'main', targetBranch: 'main', message: 'Initial commit',
  identity: { name: 'Alice', email: 'a@x.io' },
  changes: [{ path: 'README.md', content: '# hi' }, { path: 'src/a.ts', content: 'x' }],
}).commitSha
const c2 = r.applyChangesToBranch({
  baseBranch: 'main', targetBranch: 'feature', message: 'feature',
  identity: { name: 'Alice', email: 'a@x.io' },
  changes: [{ path: 'f.txt', content: 'f' }],
}).commitSha
r.createTag({ name: 'v1.0.0', target: c1, message: 'rel', tagger: { name: 'Alice', email: 'a@x.io' } })
console.log(root)
