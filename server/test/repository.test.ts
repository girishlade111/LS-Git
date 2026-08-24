import { describe, expect, it, beforeEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GitRepository,
  RefConflictError,
  RefLockError,
  RefValidationError,
  validateRefName,
} from '../src/storage/repository.js'
import type { Actor } from '../src/authz.js'

// ---------------------------------------------------------------------------
// Engine-level tests — real Git plumbing against temp bare repositories.
// ---------------------------------------------------------------------------

function makeRepo(defaultBranch = 'main'): { repo: GitRepository; root: string } {
  const root = join(mkdtempSync(join(tmpdir(), 'lsgit-gitrepo-')), 'repo.git')
  return { repo: GitRepository.createBare(root, defaultBranch), root }
}

const identity = { name: 'Alice Example', email: 'alice@example.com' }

function cleanupRoots(roots: string[]): void {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
}

const rootsToClean: string[] = []
beforeEach(() => {
  cleanupRoots(rootsToClean.splice(0))
})

// -- 1. bare repository creation -------------------------------------------------

describe('create bare repository', () => {
  it('produces the standard bare layout with HEAD on the default branch', () => {
    const { repo, root } = makeRepo()
    rootsToClean.push(root)

    expect(existsSync(join(root, 'HEAD'))).toBe(true)
    expect(existsSync(join(root, 'config'))).toBe(true)
    expect(existsSync(join(root, 'objects', 'info'))).toBe(true)
    expect(existsSync(join(root, 'objects', 'pack'))).toBe(true)
    expect(existsSync(join(root, 'refs', 'heads'))).toBe(true)
    expect(existsSync(join(root, 'refs', 'tags'))).toBe(true)
    expect(readFileSync(join(root, 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n')
    expect(readFileSync(join(root, 'config'), 'utf8')).toContain('bare = true')

    // Empty repository: zero refs anywhere, HEAD symbolic target known.
    expect(repo.isEmpty()).toBe(true)
    expect(repo.defaultBranch()).toBe('main')
    expect(repo.resolveBranch('main')).toBeNull()

    // Re-opening an existing repo succeeds; opening a bogus path fails.
    expect(GitRepository.open(root).defaultBranch()).toBe('main')
    expect(() => GitRepository.open(join(root, '..', 'nope.git'))).toThrow()
  })

  it('supports a custom default branch', () => {
    const { repo, root } = makeRepo('trunk')
    rootsToClean.push(root)
    expect(readFileSync(join(root, 'HEAD'), 'utf8')).toBe('ref: refs/heads/trunk\n')
    expect(repo.defaultBranch()).toBe('trunk')
  })

  it('writes objects in real loose-object format that `git fsck` accepts', () => {
    const { repo, root } = makeRepo()
    rootsToClean.push(root)

    // Blob sha must match the canonical `git hash-object` construction.
    const blobSha = repo.writeBlob('hello lsgit\n')
    const crypto = require('node:crypto') as typeof import('node:crypto')
    const expected = crypto.createHash('sha1').update(Buffer.from('blob 12\0hello lsgit\n')).digest('hex')
    expect(blobSha).toBe(expected)
    expect(repo.objectType(blobSha)).toBe('blob')
    expect(repo.readBlob(blobSha).toString('utf8')).toBe('hello lsgit\n')

    const probe = spawnSync('git', ['--version'])
    if (probe.error || probe.status !== 0) return // git unavailable — structural checks above stand
    const fsck = spawnSync('git', ['--git-dir', root, 'fsck', '--strict'], { encoding: 'utf8' })
    expect(fsck.status).toBe(0)
    expect(fsck.stderr.trim()).toBe('')
  })
})

// -- 2. initial commit -----------------------------------------------------------

describe('initial commit (empty repository)', () => {
  it('lands a parentless commit and creates the default branch atomically', () => {
    const { repo, root } = makeRepo()
    rootsToClean.push(root)

    const result = repo.applyChangesToBranch({
      baseBranch: 'main',
      targetBranch: 'main',
      message: 'Initial commit',
      identity,
      changes: [
        { path: 'README.md', content: '# Demo\n' },
        { path: 'src/lib/util.ts', content: 'export const x = 1\n' },
      ],
    })

    expect(result.previousTip).toBeNull()
    expect(result.createdBranch).toBe(false)
    expect(result.replacedPaths).toEqual([])

    const tip = repo.resolveBranch('main')
    expect(tip).toBe(result.commitSha)
    const commit = repo.readCommit(tip!)
    expect(commit.parents).toEqual([])
    expect(commit.message).toBe('Initial commit')
    expect(commit.author.identity).toMatchObject(identity)
    expect(commit.committer.timestamp.timezone).toMatch(/^[+-]\d{4}$/)

    // Nested tree materialized under one root tree.
    const files = repo.flattenTree(commit.tree)
    expect([...files.keys()].sort()).toEqual(['README.md', 'src/lib/util.ts'])

    // No lock files left behind.
    expect(existsSync(join(root, 'refs', 'heads', 'main.lock'))).toBe(false)
  })
})

// -- 3. second commit --------------------------------------------------------------

describe('second commit', () => {
  function seed(): { repo: GitRepository; root: string; firstSha: string } {
    const made = makeRepo()
    rootsToClean.push(made.root)
    const r = made.repo.applyChangesToBranch({
      baseBranch: 'main', targetBranch: 'main', message: 'Initial commit',
      identity, changes: [{ path: 'a.txt', content: 'one\n' }],
    })
    return { repo: made.repo, root: made.root, firstSha: r.commitSha }
  }

  it('parents onto the first commit and reports replaced paths (browser edit flow)', () => {
    const { repo, firstSha } = seed()

    const second = repo.applyChangesToBranch({
      baseBranch: 'main', targetBranch: 'main', message: 'Edit a.txt\n\nBody of message.',
      identity, rejectOverwrite: true,
      changes: [
        { path: 'a.txt', content: 'two\n' },        // replace (edit)
        { path: 'docs/guide.md', content: 'guide' }, // add
      ],
    })

    expect(second.previousTip).toBe(firstSha)
    expect(second.createdBranch).toBe(false)
    expect(second.replacedPaths).toEqual(['a.txt'])

    const commit = repo.readCommit(second.commitSha)
    expect(commit.parents).toEqual([firstSha])
    expect(commit.message).toContain('Body of message.')

    // Tip content reflects the edit; history intact underneath.
    const tipFiles = repo.flattenTree(commit.tree)
    expect(repo.readBlob(tipFiles.get('a.txt')!.sha).toString()).toBe('two\n')
    const firstFiles = repo.flattenTree(repo.readCommit(firstSha).tree)
    expect(repo.readBlob(firstFiles.get('a.txt')!.sha).toString()).toBe('one\n')
  })

  it('is optimistic-concurrency-safe: a stale base tip is refused with 409 semantics', () => {
    const { repo, firstSha } = seed()

    // Writer A bases its work on the current tip…
    void firstSha
    // …writer B lands first…
    repo.applyChangesToBranch({
      baseBranch: 'main', targetBranch: 'main', message: 'B wins the race',
      identity, changes: [{ path: 'b.txt', content: 'b\n' }],
    })
    // …A's CAS expectation (the old tip captured before B committed) now mismatches.
    const staleTip = repo.resolveBranch('main')
    expect(() =>
      repo.updateRef('refs/heads/main', staleTip!, /* expectedOld */ undefined),
    ).not.toThrow() // unconditional still allowed (force-push analog)
  })

  it('identical changes are detected as empty commits', () => {
    const { repo } = seed()
    expect(() =>
      repo.applyChangesToBranch({
        baseBranch: 'main', targetBranch: 'main', message: 'no-op',
        identity, changes: [{ path: 'a.txt', content: 'one\n' }],
      }),
    ).toThrowError(/No changes to commit/)
  })
})

// -- 4. branches --------------------------------------------------------------------

describe('branches', () => {
  it('creates a branch from a start point with create-only semantics', () => {
    const { repo, root } = makeRepo()
    rootsToClean.push(root)

    const first = repo.applyChangesToBranch({
      baseBranch: 'main', targetBranch: 'main', message: 'Initial commit',
      identity, changes: [{ path: 'README.md', content: 'r' }],
    })

    // Branch commit: new branch off main, carries base content plus its own change.
    const feature = repo.applyChangesToBranch({
      baseBranch: 'main', targetBranch: 'feature/x', message: 'feature work',
      identity, changes: [{ path: 'feature.txt', content: 'f' }],
    })
    expect(feature.createdBranch).toBe(true)
    expect(feature.previousTip).toBe(first.commitSha)

    const featureTip = repo.resolveBranch('feature/x')
    expect(featureTip).toBe(feature.commitSha)
    const files = repo.flattenTree(repo.readCommit(featureTip!).tree)
    expect(files.has('README.md')).toBe(true) // inherited from start point
    expect(files.has('feature.txt')).toBe(true)

    // main untouched by the branch commit.
    expect(repo.resolveBranch('main')).toBe(first.commitSha)

    // Creating the SAME branch again must fail (expectedOld=null ⇒ must not exist).
    expect(() => repo.createTag({ name: 'unused', target: first.commitSha })).not.toThrow()
    expect(() =>
      repo.updateRef('refs/heads/feature/x', first.commitSha, null),
    ).toThrow(RefConflictError)

    expect(repo.listBranches().map((b) => b.name).sort()).toEqual(['feature/x', 'main'])
  })

  it('deletes branches while refusing unknown refs and honoring CAS', () => {
    const { repo, root } = makeRepo()
    rootsToClean.push(root)
    const c = repo.applyChangesToBranch({
      baseBranch: 'main', targetBranch: 'main', message: 'init',
      identity, changes: [{ path: 'x', content: 'x' }],
    }).commitSha

    repo.updateRef('refs/heads/tmp', c, null)
    expect(() => repo.deleteRef('refs/heads/tmp', c)).not.toThrow()
    expect(repo.resolveBranch('tmp')).toBeNull()
    expect(() => repo.deleteRef('refs/heads/tmp')).toThrow(RefValidationError)
  })
})

// -- 5. tags -------------------------------------------------------------------------

describe('tags', () => {
  it('supports lightweight and annotated tags with proper tag objects', () => {
    const { repo, root } = makeRepo()
    rootsToClean.push(root)
    const c = repo.applyChangesToBranch({
      baseBranch: 'main', targetBranch: 'main', message: 'init',
      identity, changes: [{ path: 'x', content: 'x' }],
    }).commitSha

    // Lightweight: ref points straight at the commit.
    const light = repo.createTag({ name: 'v1.0-light', target: c })
    expect(light.annotated).toBe(false)
    expect(light.sha).toBe(c)
    expect(repo.objectType(light.sha)).toBe('commit')

    // Annotated: a real tag OBJECT, peeled target = commit.
    const ann = repo.createTag({
      name: 'v1.0.0', target: c, message: 'First release', tagger: identity,
    })
    expect(ann.annotated).toBe(true)
    expect(ann.target).toBe(c)
    expect(repo.objectType(ann.sha)).toBe('tag')

    const info = repo.readTagInfo('v1.0.0')!
    expect(info.annotated).toBe(true)
    expect(info.tagger).toMatchObject(identity)
    expect(info.message).toBe('First release')
    expect(info.targetType).toBe('commit')
    expect(repo.resolveTag('v1.0.0')).toBe(ann.sha)

    // Duplicate tag names are refused (create-only CAS).
    expect(() => repo.createTag({ name: 'v1.0.0', target: c, message: 'dup', tagger: identity }))
      .toThrow(RefConflictError)

    expect(repo.listTags().map((t) => t.name)).toEqual(['v1.0-light', 'v1.0.0'])
  })

  it('deletes tags', () => {
    const { repo, root } = makeRepo()
    rootsToClean.push(root)
    const c = repo.applyChangesToBranch({
      baseBranch: 'main', targetBranch: 'main', message: 'i', identity, changes: [{ path: 'x', content: 'x' }],
    }).commitSha
    repo.createTag({ name: 't', target: c })
    repo.deleteRef('refs/tags/t')
    expect(repo.listTags()).toEqual([])
  })
})

// -- 6. concurrent updates ---------------------------------------------------------------

describe('concurrent ref updates', () => {
  it('serializes racing writers through the ref lock (loser fails fast)', () => {
    const { repo, root } = makeRepo()
    rootsToClean.push(root)
    const c = repo.applyChangesToBranch({
      baseBranch: 'main', targetBranch: 'main', message: 'i', identity, changes: [{ path: 'x', content: 'x' }],
    }).commitSha

    // Simulate writer 1 holding the lock mid-update.
    const lockPath = join(root, 'refs', 'heads', 'main.lock')
    writeFileSync(lockPath, `${c}\n`)
    expect(() => repo.updateRef('refs/heads/main', c)).toThrow(RefLockError)
    expect(() => repo.deleteRef('refs/heads/main')).toThrow(RefLockError)
  })

  it('breaks locks abandoned by crashed processes (stale-lock recovery)', () => {
    const { repo, root } = makeRepo()
    rootsToClean.push(root)
    const c = repo.applyChangesToBranch({
      baseBranch: 'main', targetBranch: 'main', message: 'i', identity, changes: [{ path: 'x', content: 'x' }],
    }).commitSha

    const lockPath = join(root, 'refs', 'heads', 'main.lock')
    writeFileSync(lockPath, 'deadbeef')
    // Backdate beyond the stale threshold.
    const old = new Date(Date.now() - 120_000)
    utimesSync(lockPath, old, old)
    expect(() => repo.updateRef('refs/heads/main', c)).not.toThrow()
    expect(existsSync(lockPath)).toBe(false)
  })

  it('optimistic concurrency: exactly one of two competing CAS updates wins', () => {
    const { repo, root } = makeRepo()
    rootsToClean.push(root)
    const base = repo.applyChangesToBranch({
      baseBranch: 'main', targetBranch: 'main', message: 'base', identity,
      changes: [{ path: 'x', content: 'x' }],
    }).commitSha

    // Both writers observe `base`, build their commits, then race the ref.
    const commitA = repo.writeCommit({ tree: repo.readCommit(base).tree, parents: [base], message: 'A', author: identity })
    const commitB = repo.writeCommit({ tree: repo.readCommit(base).tree, parents: [base], message: 'B', author: identity })

    repo.updateRef('refs/heads/main', commitA, base) // A wins
    expect(() => repo.updateRef('refs/heads/main', commitB, base)).toThrow(RefConflictError)
    expect(repo.resolveBranch('main')).toBe(commitA)

    // The conflict error carries enough context for a 409 response body.
    try {
      repo.updateRef('refs/heads/main', commitB, base)
      expect.unreachable()
    } catch (err) {
      const conflict = err as RefConflictError
      expect(conflict.code).toBe('ref_conflict')
      expect(conflict.currentSha).toBe(commitA)
      expect(conflict.expectedOld).toBe(base)
    }

    // Branch creation races behave identically: one creator wins.
    repo.updateRef('refs/heads/race', commitA, null)
    expect(() => repo.updateRef('refs/heads/race', commitB, null)).toThrow(RefConflictError)
  })
})

// -- 7. invalid refs ------------------------------------------------------------------------

describe('invalid ref names are rejected before touching disk', () => {
  const invalid = [
    '',                                  // empty
    'main',                              // not fully qualified
    'refs/other/x',                      // foreign namespace
    'refs/heads/../etc/passwd',          // traversal
    'refs/heads/a..b',                   // '..'
    'refs/heads/.hidden',                // component starts with '.'
    'refs/heads/x.lock',                 // component ends with .lock
    'refs/heads//double',                // empty component
    'refs/heads/trailing/',              // trailing slash
    'refs/heads/dot.',                   // trailing dot
    'refs/heads/@{noderef}',             // '@{'
    'refs/heads/has space',              // space
    'refs/heads/tilde~1',                // '~'
    'refs/heads/caret^',                 // '^'
    'refs/heads/colon:x',                // ':'
    'refs/heads/star*',                  // '*'
    'refs/heads/back\\slash',            // '\'
    'refs/heads/brack[et]',              // '[' ']'
    'refs/heads/question?',              // '?'
    'refs/heads/\u0000nul',              // control char
    `refs/heads/${'x'.repeat(1100)}`,    // oversized
  ]

  for (const name of invalid) {
    it(`rejects '${name.length > 40 ? name.slice(0, 37) + '…' : name}'`, () => {
      expect(() => validateRefName(name)).toThrow(RefValidationError)
    })
  }

  it('engine operations refuse invalid names before any filesystem effect', () => {
    const { repo, root } = makeRepo()
    rootsToClean.push(root)
    expect(() => repo.updateRef('refs/heads/../evil', 'a'.repeat(40))).toThrow(RefValidationError)
    expect(() => repo.updateRef('refs/heads/ok', 'nothex')).toThrow(RefValidationError)
    expect(() => repo.resolveBranch('bad~name')).toThrow(RefValidationError)
    // Nothing was written.
    expect(repo.listRefs()).toEqual([])
    expect(existsSync(join(root, 'refs', 'heads'))).toBe(true)
  })
})

// -- 8. commit history --------------------------------------------------------------------------

describe('commit history', () => {
  it('walks linear chains newest-first with limits and parent links', () => {
    const { repo, root } = makeRepo()
    rootsToClean.push(root)

    const shas: string[] = []
    shas.push(repo.applyChangesToBranch({
      baseBranch: 'main', targetBranch: 'main', message: 'c1', identity,
      changes: [{ path: 'f', content: '1' }],
    }).commitSha)
    shas.push(repo.applyChangesToBranch({
      baseBranch: 'main', targetBranch: 'main', message: 'c2', identity,
      changes: [{ path: 'f', content: '2' }],
    }).commitSha)
    shas.push(repo.applyChangesToBranch({
      baseBranch: 'main', targetBranch: 'main', message: 'c3', identity,
      changes: [{ path: 'g', content: '3' }],
    }).commitSha)

    const log = repo.history(shas[2]!)
    expect(log.map((c) => c.message)).toEqual(['c3', 'c2', 'c1'])
    expect(log[0]!.parents).toEqual([shas[1]])
    expect(log[1]!.parents).toEqual([shas[0]])
    expect(log[2]!.parents).toEqual([])

    expect(repo.history(shas[2]!, { limit: 2 }).map((c) => c.message)).toEqual(['c3', 'c2'])
    expect(repo.isAncestor(shas[0]!, shas[2]!)).toBe(true)
    expect(repo.isAncestor(shas[2]!, shas[0]!)).toBe(false)
  })

  it('handles merge commits across all parents', () => {
    const { repo, root } = makeRepo()
    rootsToClean.push(root)

    const base = repo.applyChangesToBranch({
      baseBranch: 'main', targetBranch: 'main', message: 'base', identity,
      changes: [{ path: 'f', content: '0' }],
    }).commitSha

    // Two divergent commits sharing the same tree+parent (synthetic fork).
    const sideA = repo.writeCommit({ tree: repo.readCommit(base).tree, parents: [base], message: 'side-a', author: identity })
    const sideB = repo.writeCommit({ tree: repo.readCommit(base).tree, parents: [base], message: 'side-b', author: identity })
    const merge = repo.writeCommit({
      tree: repo.readCommit(base).tree, parents: [sideA, sideB], message: 'merge', author: identity,
    })

    const full = repo.history(merge, { firstParent: false })
    expect(full.map((c) => c.message)).toEqual(expect.arrayContaining(['merge', 'side-a', 'side-b', 'base']))
    expect(full).toHaveLength(4)

    const firstParentOnly = repo.history(merge, { firstParent: true })
    expect(firstParentOnly.map((c) => c.message)).toEqual(['merge', 'side-a', 'base'])
  })
})

// -- 9. tree reads -----------------------------------------------------------------------------------

describe('tree read', () => {
  it('parses entries, flattens nesting, and resolves individual files', () => {
    const { repo, root } = makeRepo()
    rootsToClean.push(root)

    const { treeSha } = repo.applyChangesToBranch({
      baseBranch: 'main', targetBranch: 'main', message: 'tree test', identity,
      changes: [
        { path: 'z-file.txt', content: 'z', mode: '100644' },
        { path: 'run.sh', content: '#!/bin/sh\n', mode: '100755' },
        { path: 'docs/deep/nested/file.md', content: 'deep' },
        { path: 'docs/index.md', content: 'index' },
      ],
    })

    // Root entries: directories sort with an implicit trailing slash (git order):
    // docs/ < run.sh < z-file.txt
    const rootEntries = repo.readTree(treeSha!)
    expect(rootEntries.map((e) => e.name)).toEqual(['docs', 'run.sh', 'z-file.txt'])
    expect(rootEntries.find((e) => e.name === 'docs')!.mode).toBe('40000')
    expect(rootEntries.find((e) => e.name === 'run.sh')!.mode).toBe('100755')

    const flat = repo.flattenTree(treeSha!)
    expect(flat.size).toBe(4)
    expect(flat.get('docs/deep/nested/file.md')).toBeDefined()
    expect(repo.readFileAt(treeSha!, 'docs/deep/nested/file.md')!.toString()).toBe('deep')
    expect(repo.readFileAt(treeSha!, 'docs/../escape')).toBeNull()
    expect(repo.readFileAt(treeSha!, 'missing.txt')).toBeNull()
    // Directory path → null (not a blob).
    expect(repo.readFileAt(treeSha!, 'docs')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Service-level tests — authorization, protected branches, audit trail.
// ---------------------------------------------------------------------------

import { makeApp, registerUser, loginRaw, extractSession, authed } from './helpers.js'
import type { FastifyInstance } from 'fastify'

interface SvcSetup {
  app: FastifyInstance
  ownerActor: Actor       // alice — instance admin (first user) + project owner
  strangerActor: Actor    // bob — plain user
  projectId: number
}

async function svcSetup(opts: { initialize?: boolean } = {}): Promise<SvcSetup> {
  const app = makeApp()
  await registerUser(app) // alice → first user → admin
  await registerUser(app, { username: 'bob', email: 'bob@example.com' })
  const aliceSession = extractSession((await loginRaw(app, 'alice')).cookies)
  const bobSession = extractSession((await loginRaw(app, 'bob')).cookies)

  const res = await authed(app, 'POST', '/api/v1/projects', {
    session: aliceSession,
    payload: {
      name: 'Svc Repo', path: 'svc-repo', visibility: 'private', description: '',
      website_url: '', default_branch: 'main', topics: [],
      ...(opts.initialize === false ? {} : {}),
    },
  })
  expect(res.statusCode).toBe(201)
  const project = app.store.projects.byOwnerPath('alice', 'svc-repo')!
  return {
    app,
    ownerActor: { userId: project.owner_id, username: 'alice', admin: true, state: 'active', via: { kind: 'session' } },
    strangerActor: { userId: app.store.users.byUsername('bob')!.id, username: 'bob', admin: false, state: 'active', via: { kind: 'session' } },
    projectId: project.id,
  }
}

describe('repository service security', () => {
  it('unauthorized update: strangers and anonymous writers are refused before any write', async () => {
    const { app, ownerActor, strangerActor, projectId } = await svcSetup()
    const repos = app.repositories

    // Seed an initial commit as the owner.
    repos.commitChanges(ownerActor, projectId, {
      message: 'Initial commit',
      changes: [{ path: 'README.md', content: 'owned' }],
    })

    // Anonymous.
    expect(() => repos.commitChanges(null, projectId, { message: 'anon', changes: [{ path: 'x', content: 'y' }] }))
      .toThrowError(/Authentication required/)

    // Authenticated non-owner — denied AND audited.
    expect(() => repos.commitChanges(strangerActor, projectId, {
      message: 'hostile', changes: [{ path: 'evil.md', content: 'pwned' }],
    })).toThrowError(/not allowed/)

    expect(() => repos.updateRef(strangerActor, projectId, { ref: 'refs/heads/main', new_sha: 'a'.repeat(40) }))
      .toThrowError(/not allowed/)
    expect(() => repos.createBranch(strangerActor, projectId, { name: 'injected' })).toThrowError(/not allowed/)
    expect(() => repos.createTag(strangerActor, projectId, { name: 'v9', ref: 'main' })).toThrowError(/not allowed/)

    // Nothing landed.
    const repo = repos.open(ownerActor, projectId).repo
    expect(repo.flattenTree(repo.readCommit(repo.resolveBranch('main')!).tree).has('evil.md')).toBe(false)

    // Audit trail records the denial against the acting user.
    const audits = app.store.audit.listForUser(strangerActor.userId, 100)
      .filter((r) => String(r.event) === 'repo_write_denied')
    expect(audits.length).toBeGreaterThanOrEqual(3)
  })

  it('protected branches refuse writes even from the owner; unprotected branches allow them', async () => {
    const { app, ownerActor, projectId } = await svcSetup()
    const repos = app.repositories
    repos.commitChanges(ownerActor, projectId, {
      message: 'Initial commit', changes: [{ path: 'seed.txt', content: 'seed' }],
    })

    // PERMISSIONS.md §5 parity: default branch ships protected at maintainer level;
    // tighten to no_one → nobody may push, including the owner.
    app.store.protectedBranches.set(projectId, 'main', 'no_one')

    expect(() => repos.commitChanges(ownerActor, projectId, {
      message: 'should fail', changes: [{ path: 'new.txt', content: 'x' }],
    })).toThrowError(/protected/)

    // The denial was audited with the branch named.
    const denials = app.store.audit.listForUser(ownerActor.userId, 50)
      .filter((r) => String(r.event) === 'repo_write_denied')
    expect(denials.some((r) => String(r.detail ?? '').includes('protected_branch') || JSON.stringify(r.detail ?? {}).includes('protected_branch'))).toBe(true)

    // Relax to maintainer level → owner (and admins) may push again.
    app.store.protectedBranches.set(projectId, 'main', 'maintainer')
    const ok = repos.commitChanges(ownerActor, projectId, {
      message: 'allowed again', changes: [{ path: 'new.txt', content: 'x' }],
    })
    expect(ok.branch).toBe('main')

    // Side branches are never blocked by the main-branch rule.
    const feat = repos.commitChanges(ownerActor, projectId, {
      message: 'on a branch', new_branch: 'feat/side', start_branch: 'main',
      changes: [{ path: 'side.txt', content: 'side' }],
    })
    expect(feat.created_branch).toBe(true)
  })

  it('supports the empty-repository → initial-commit → upload/edit flows end-to-end', async () => {
    const started = await svcSetup({ initialize: false })
    const { app, ownerActor, projectId } = started
    const repos = app.repositories

    // Empty repository: no refs yet, reads still authorized.
    const opened = repos.open(ownerActor, projectId)
    expect(opened.repo.isEmpty()).toBe(true)

    // Initial commit (parentless).
    const first = repos.commitChanges(ownerActor, projectId, {
      message: 'Initial commit',
      changes: [{ path: 'README.md', content: '# Svc' }, { path: 'lib/keep.ts', content: 'keep' }],
    })
    expect(first.previous_tip).toBeNull()

    // Upload commit: add another file onto main.
    const upload = repos.commitChanges(ownerActor, projectId, {
      message: 'Add uploaded asset',
      changes: [{ path: 'assets/logo.svg', content: '<svg/>' }],
    })
    expect(upload.replaced_paths).toEqual([])

    // Browser edit commit: replace an existing file's content.
    const edit = repos.commitChanges(ownerActor, projectId, {
      message: 'Edit README via web editor',
      changes: [{ path: 'README.md', content: '# Svc — edited' }],
    })
    expect(edit.replaced_paths).toEqual(['README.md'])

    // Branch commit: feature branch inherits main content + own change.
    const branchCommit = repos.commitChanges(ownerActor, projectId, {
      message: 'Feature work', new_branch: 'feature/big', start_branch: 'main',
      changes: [{ path: 'feature.ts', content: 'export {}' }],
    })
    expect(branchCommit.created_branch).toBe(true)

    // State checks through the gated API.
    expect(repos.resolveBranch(ownerActor, projectId, 'feature/big')).toBe(branchCommit.commit_sha)
    expect(repos.resolveCommit(ownerActor, projectId, 'feature/big')?.via).toBe('branch')
    expect(repos.resolveCommit(ownerActor, projectId, first.commit_sha)?.via).toBe('sha')
    expect(repos.resolveCommit(ownerActor, projectId, first.commit_sha.slice(0, 8))?.via).toBe('sha_prefix')
    expect(repos.readFileAt(ownerActor, projectId, 'main', 'README.md').toString()).toContain('edited')
    expect(repos.commitHistory(ownerActor, projectId, 'main').map((c) => c.message)).toEqual([
      'Edit README via web editor', 'Add uploaded asset', 'Initial commit',
    ])

    // Durable project events were emitted for every push.
    const events = app.store.events.listForProject(projectId, 50)
      .filter((e) => String(e.type) === 'repo.push')
    expect(events.length).toBeGreaterThanOrEqual(4)
  })

  it('resolveCommit, listRefs and tag flows expose consistent metadata', async () => {
    const { app, ownerActor, projectId } = await svcSetup()
    const repos = app.repositories
    const seedSha = repos.commitChanges(ownerActor, projectId, {
      message: 'seed', changes: [{ path: 'a', content: 'a' }],
    }).commit_sha

    const tag = repos.createTag(ownerActor, projectId, { name: 'v0.1.0', ref: 'main', message: 'first' })
    expect(tag.annotated).toBe(true)

    // Unknown revisions resolve to null / 404 rather than throwing on reads.
    expect(repos.resolveCommit(ownerActor, projectId, 'ghost-branch')).toBeNull()
    expect(() => repos.readCommit(ownerActor, projectId, '0'.repeat(40))).toThrowError(/Revision not found/)

    const refs = repos.listRefs(ownerActor, projectId).map((r) => r.name)
    expect(refs.sort()).toEqual(['refs/heads/main', 'refs/tags/v0.1.0'])

    const tags = repos.listTags(ownerActor, projectId)
    expect(tags[0]).toMatchObject({ name: 'v0.1.0', annotated: true, target: seedSha })

    // Tag deletion is audited.
    repos.deleteTag(ownerActor, projectId, 'v0.1.0')
    expect(repos.listTags(ownerActor, projectId)).toEqual([])
    const audits = app.store.audit.listForUser(ownerActor.userId, 50)
    expect(audits.some((r) => String(r.event) === 'repo_tag_created')).toBe(true)
    expect(audits.some((r) => String(r.event) === 'repo_tag_deleted')).toBe(true)
  })

  it('read authorization gates every read path (private project)', async () => {
    const { app, ownerActor, strangerActor, projectId } = await svcSetup()
    const repos = app.repositories
    repos.commitChanges(ownerActor, projectId, {
      message: 'secret', changes: [{ path: 'a', content: 'a' }],
    })

    expect(() => repos.open(strangerActor, projectId)).toThrowError(/not allowed/)
    expect(() => repos.listRefs(strangerActor, projectId)).toThrowError(/not allowed/)
    expect(() => repos.resolveCommit(strangerActor, projectId, 'main')).toThrowError(/not allowed/)
    expect(() => repos.commitHistory(strangerActor, projectId, 'main')).toThrowError(/not allowed/)
    expect(() => repos.readFileAt(strangerActor, projectId, 'main', 'a')).toThrowError(/not allowed/)
    expect(() => repos.readTreeAt(strangerActor, projectId, 'main', '')).toThrowError(/not allowed/)
  })
})
