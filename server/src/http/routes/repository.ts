import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AppError } from '../../services/identity.js'
import { buildArchive, type ArchiveEntry } from '../../storage/archive.js'

/**
 * Repository code-browser API (stable, shareable URLs).
 *
 * LSGit's own URL scheme — deliberately NOT GitLab's `/-/blob/...` shape:
 *
 *   GET /api/v1/projects/:id/repository/refs
 *   GET /api/v1/projects/:id/repository/tree/:ref/(?path=&page=&per_page=)
 *   GET /api/v1/projects/:id/repository/blob/:ref/(?path=)
 *   GET /api/v1/projects/:id/repository/raw/:ref/(?path=)
 *   GET /api/v1/projects/:id/repository/download/:ref/(?path=&format=tar.gz)
 *   GET /api/v1/projects/:id/repository/commits/:ref(?path=&page=&per_page=)
 *   GET /api/v1/projects/:id/repository/commit/:sha
 *   GET /api/v1/projects/:id/repository/blame/:ref/(?path=)
 *   GET /api/v1/projects/:id/repository/search/:ref(?q=&content=)
 *
 * `:ref` accepts branch names, tag names and full SHAs — a SHA in the ref
 * position IS the permalink form (content-addressed, immutable). Line-level
 * permalinks append `#L<n>` on the blob page fragment; the server returns the
 * line-anchored metadata the UI needs.
 *
 * Every handler authorizes via the repository service BEFORE reading disk.
 */

export function registerRepositoryRoutes(app: FastifyInstance): void {
  const repos = app.repositories
  // Repository mutations require an authenticated writer (write_api PAT scope).
  const auth = app.requireAuth('write_api')

  // -- web-editor commit (create/edit/delete/rename; multi-file in one commit) ----

  app.post('/api/v1/projects/:id/repository/commit', { preHandler: auth }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const id = projectId(req)
    const rawChanges = Array.isArray(body.changes) ? body.changes : []
    const changes = rawChanges.map((c) => {
      const change = c as Record<string, unknown>
      const mapped: Record<string, unknown> = {
        path: String(change.path ?? ''),
        mode: change.mode === '100755' ? '100755' : '100644',
      }
      if (change.delete === true) mapped.delete = true
      if (typeof change.content === 'string') mapped.content = change.content
      else if (typeof change.content_base64 === 'string') {
        // Binary replace path: bytes arrive base64-encoded (JSON transport).
        const decoded = Buffer.from(change.content_base64, 'base64')
        if (decoded.length === 0 && String(change.content_base64).length > 0) {
          throw new AppError(400, `'${mapped.path}' has invalid base64 content`, 'validation_failed')
        }
        mapped.content = decoded
      } else if (typeof change.sha === 'string') mapped.sha = change.sha
      return mapped
    })

    const outcome = repos.commitChanges(req.actor, id, {
      changes: changes as unknown as Parameters<typeof repos.commitChanges>[2]['changes'],
      message: String(body.commit_message ?? body.message ?? ''),
      branch: typeof body.branch === 'string' ? body.branch : null,
      new_branch: typeof body.new_branch === 'string' ? body.new_branch : null,
      start_branch: typeof body.start_branch === 'string' ? body.start_branch : null,
      expected_base_tip: body.expected_base_tip === null
        ? null
        : typeof body.expected_base_tip === 'string'
          ? body.expected_base_tip
          : undefined,
      reject_overwrite: body.reject_overwrite === true,
    })

    reply.code(201)
    return {
      ...outcome,
      // Merge requests arrive with the collaboration phase; the new-branch flow
      // is already MR-shaped so a PR/MR can be created from this result later.
      merge_request: { created: false, reason: 'Merge requests arrive with the collaboration phase.' },
    }
  })

  // -- refs (branch/tag selectors) ---------------------------------------------

  app.get('/api/v1/projects/:id/repository/refs', async (req) => {
    const id = projectId(req)
    return {
      branches: repos.listBranches(req.actor, id),
      tags: repos.listTags(req.actor, id),
    }
  })

  // -- tree ----------------------------------------------------------------------

  app.get('/api/v1/projects/:id/repository/tree/:ref', async (req) => {
    const { ref } = req.params as { ref: string }
    const q = req.query as { path?: string; page?: string; per_page?: string }
    return repos.tree(req.actor, projectId(req), decodeRef(ref), q.path ?? '', {
      page: Number(q.page ?? 1),
      perPage: Number(q.per_page ?? 100),
    })
  })

  app.get('/api/v1/projects/:id/repository/tree/:ref/*', async (req) => {
    const { ref } = req.params as { ref: string }
    const wildcard = (req.params as Record<string, string>)['*'] ?? ''
    const q = req.query as { page?: string; per_page?: string }
    return repos.tree(req.actor, projectId(req), decodeRef(ref), wildcard, {
      page: Number(q.page ?? 1),
      perPage: Number(q.per_page ?? 100),
    })
  })

  // -- blob ------------------------------------------------------------------------

  app.get('/api/v1/projects/:id/repository/blob/:ref', async () => {
    throw missingPath()
  })

  app.get('/api/v1/projects/:id/repository/blob/:ref/*', async (req) => {
    const { ref } = req.params as { ref: string }
    const path = (req.params as Record<string, string>)['*'] ?? ''
    return repos.blob(req.actor, projectId(req), decodeRef(ref), path)
  })

  // -- raw ----------------------------------------------------------------------------

  app.get('/api/v1/projects/:id/repository/raw/:ref', async () => {
    throw missingPath()
  })

  app.get('/api/v1/projects/:id/repository/raw/:ref/*', async (req, reply) => {
    const { ref } = req.params as { ref: string }
    const path = (req.params as Record<string, string>)['*'] ?? ''
    const bytes = repos.rawBlob(req.actor, projectId(req), decodeRef(ref), path)
    reply.header('content-type', 'application/octet-stream')
    reply.header('x-content-type-options', 'nosniff')
    reply.header('content-security-policy', "default-src 'none'")
    reply.send(bytes)
  })

  // -- downloads (repository or subdirectory archive) -------------------------------------
  // No path suffix ⇒ archive of the WHOLE ref; a wildcard path ⇒ subdirectory.

  app.get('/api/v1/projects/:id/repository/download/:ref', async (req, reply) => {
    return streamArchive(req, reply, '')
  })

  app.get('/api/v1/projects/:id/repository/download/:ref/*', async (req, reply) => {
    const rawPath = (req.params as Record<string, string>)['*'] ?? ''
    return streamArchive(req, reply, rawPath)
  })

  // -- commits ----------------------------------------------------------------------------------

  app.get('/api/v1/projects/:id/repository/commits/:ref', async (req) => {
    const { ref } = req.params as { ref: string }
    const q = req.query as { path?: string; page?: string; per_page?: string }
    const id = projectId(req)
    const path = q.path ? String(q.path) : null
    if (path) {
      return repos.fileHistory(req.actor, id, decodeRef(ref), path, {
        limit: Number(q.per_page ?? 50),
      })
    }
    const perPage = Math.max(1, Math.min(Number(q.per_page ?? 25), 100))
    const page = Math.max(1, Number(q.page ?? 1))
    const all = repos.commitHistory(req.actor, id, decodeRef(ref), { limit: 200 })
    return {
      ref: decodeRef(ref),
      commits: all.slice((page - 1) * perPage, page * perPage).map((c) => repos.toCommitView(c)),
      pagination: { page, per_page: perPage, total: all.length, has_more: page * perPage < all.length },
    }
  })

  app.get('/api/v1/projects/:id/repository/commit/:sha', async (req) => {
    const { sha } = req.params as { sha: string }
    return repos.commitDetail(req.actor, projectId(req), sha)
  })

  // -- blame foundation -------------------------------------------------------------------------------

  app.get('/api/v1/projects/:id/repository/blame/:ref/*', async (req) => {
    const { ref } = req.params as { ref: string }
    const path = (req.params as Record<string, string>)['*'] ?? ''
    return repos.blame(req.actor, projectId(req), decodeRef(ref), path)
  })

  // -- file search ---------------------------------------------------------------------------------------

  app.get('/api/v1/projects/:id/repository/search/:ref', async (req) => {
    const { ref } = req.params as { ref: string }
    const q = req.query as { q?: string; content?: string; limit?: string }
    return repos.searchFiles(req.actor, projectId(req), decodeRef(ref), q.q ?? '', {
      content: q.content === '1' || q.content === 'true',
      limit: Number(q.limit ?? 50),
    })
  })

  // -- branches -----------------------------------------------------------------
  // Branch names may contain slashes; wildcard routes capture them whole and
  // the client percent-encodes each segment.

  app.get('/api/v1/projects/:id/repository/branches', async (req) => {
    const q = req.query as { search?: string; sort?: string; limit?: string }
    return {
      branches: repos.listBranchesForBrowse(req.actor, projectId(req), {
        search: q.search?.slice(0, 100),
        sort: q.sort === 'recent' ? 'recent' : 'name',
        limit: Number(q.limit ?? 100),
      }),
    }
  })

  app.post('/api/v1/projects/:id/repository/branches', { preHandler: auth }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const result = repos.createBranch(req.actor, projectId(req), {
      name: String(body.name ?? ''),
      start_point: typeof body.start_point === 'string' ? body.start_point : null,
    })
    reply.code(201)
    return result
  })

  app.delete('/api/v1/projects/:id/repository/branches/*', { preHandler: auth }, async (req) => {
    const name = decodeWildcard((req.params as Record<string, string>)['*'] ?? '')
    const q = req.query as { expected_old?: string }
    repos.deleteBranch(req.actor, projectId(req), name, typeof q.expected_old === 'string' ? q.expected_old : undefined)
    return { ok: true, branch: name }
  })

  app.post('/api/v1/projects/:id/repository/branches/rename', { preHandler: auth }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    return repos.renameBranch(req.actor, projectId(req), String(body.name ?? ''), String(body.new_name ?? ''))
  })

  // -- default branch ---------------------------------------------------------------

  app.put('/api/v1/projects/:id/repository/default_branch', { preHandler: auth }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const res = repos.setDefaultBranch(req.actor, projectId(req), String(body.name ?? ''))
    return { default_branch: res.project.default_branch, previous: res.previous }
  })

  // -- compare --------------------------------------------------------------------------

  app.get('/api/v1/projects/:id/repository/compare', async (req) => {
    const q = req.query as { from?: string; to?: string; with_patches?: string }
    return repos.compareRefs(
      req.actor, projectId(req),
      String(q.from ?? ''), String(q.to ?? ''),
      { with_patches: q.with_patches === '1' || q.with_patches === 'true' },
    )
  })

  // -- commit diff ----------------------------------------------------------------------------

  app.get('/api/v1/projects/:id/repository/commit/:sha/diff', async (req) => {
    const { sha } = req.params as { sha: string }
    return repos.commitDiff(req.actor, projectId(req), sha)
  })

  // -- tags (list/create/delete; "tag a commit" = create with ref=<sha>) ---------------

  app.get('/api/v1/projects/:id/repository/tags', async (req) => {
    return { tags: repos.listTags(req.actor, projectId(req)) }
  })

  app.post('/api/v1/projects/:id/repository/tags', { preHandler: auth }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const result = repos.createTag(req.actor, projectId(req), {
      name: String(body.name ?? ''),
      ref: String(body.ref ?? body.target ?? ''),
      message: typeof body.message === 'string' ? body.message : null,
    })
    reply.code(201)
    return result
  })

  app.delete('/api/v1/projects/:id/repository/tags/*', { preHandler: auth }, async (req) => {
    const name = decodeWildcard((req.params as Record<string, string>)['*'] ?? '')
    repos.deleteTag(req.actor, projectId(req), name)
    return { ok: true, tag: name }
  })

  // -- protected-branch rules (management centralized in the service) ---------------------

  app.put('/api/v1/projects/:id/repository/protected_branches', { preHandler: auth }, async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const level = String(body.push_access_level ?? 'maintainer')
    if (!['no_one', 'maintainer'].includes(level)) {
      throw new AppError(400, "push_access_level must be 'no_one' or 'maintainer'")
    }
    const rules = repos.setProtection(req.actor, projectId(req), {
      name: String(body.name ?? ''),
      level: level as 'no_one' | 'maintainer',
    })
    return rules
  })

  app.get('/api/v1/projects/:id/repository/protected_branches', async (req) => {
    const id = projectId(req)
    repos.open(req.actor, id) // read-gate
    return app.store.protectedBranches.listForProject(id)
  })

  app.delete('/api/v1/projects/:id/repository/protected_branches/*', { preHandler: auth }, async (req) => {
    const name = decodeWildcard((req.params as Record<string, string>)['*'] ?? '')
    const rules = repos.removeProtection(req.actor, projectId(req), name)
    return rules
  })

  // -- helpers ---------------------------------------------------------------------------------------------

  function decodeWildcard(raw: string): string {
    // Wildcard params arrive with slashes intact; segments were individually
    // encoded by the client. Decode the whole tail once.
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }

  async function streamArchive(req: FastifyRequest, reply: import('fastify').FastifyReply, rawPath: string): Promise<void> {
    const { ref } = req.params as { ref: string }
    const project = app.store.projects.byId(projectId(req))
    if (!project) throw new AppError(404, 'Project not found')

    // Resolve + authorize once (service gates the read), then build from the flattened subtree.
    const opened = repos.open(req.actor, project.id)
    const resolved = repos.resolveCommit(req.actor, project.id, decodeRef(ref))
    if (!resolved) throw new AppError(404, 'Revision not found', 'revision_not_found')
    const prefix = normalizeArchivePath(rawPath)

    let treeSha = resolved.commit.tree
    if (prefix) {
      for (const seg of prefix.split('/')) {
        const entry = opened.repo.readTree(treeSha).find((e) => e.name === seg)
        if (!entry || !entry.mode.startsWith('4')) {
          throw new AppError(404, `Directory '${prefix}' not found`, 'path_not_found')
        }
        treeSha = entry.sha
      }
    }

    const flat = opened.repo.flattenTree(treeSha)
    const entries: Array<ArchiveEntry> = [...flat.entries()].map(([p, e]) => ({
      path: p,
      mode: e.mode,
      read: () => opened.repo.readBlob(e.sha),
    }))
    const refLabel = sanitizeArchiveLabel(decodeRef(ref))
    const scope = prefix ? `${sanitizeArchiveLabel(prefix)}-` : ''
    const result = buildArchive({
      entries,
      rootPrefix: `${sanitizeArchiveLabel(project.path)}-${scope}${refLabel}/`,
      fileName: `${project.path}-${scope}${refLabel}.tar.gz`,
      commitTime: new Date(resolved.commit.committer.timestamp.time * 1000),
    })

    reply.header('content-type', 'application/gzip')
    reply.header('content-disposition', `attachment; filename="${result.fileName}"`)
    reply.header('content-length', result.bytes.length)
    reply.send(result.bytes)
  }

  function projectId(req: FastifyRequest): number {
    return Number((req.params as { id: string }).id)
  }

  function decodeRef(ref: string): string {
    try {
      return decodeURIComponent(ref)
    } catch {
      return ref
    }
  }

  function normalizeArchivePath(raw: string): string {
    if (!raw || raw === '/') return ''
    try {
      return decodeURIComponent(raw).replace(/^\/+|\/+$/g, '')
    } catch {
      return raw.replace(/^\/+|\/+$/g, '')
    }
  }

  function sanitizeArchiveLabel(label: string): string {
    const clean = label.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
    return clean.slice(0, 60) || 'archive'
  }
}

function missingPath(): AppError {
  return new AppError(400, 'A file or directory path is required', 'invalid_path')
}
