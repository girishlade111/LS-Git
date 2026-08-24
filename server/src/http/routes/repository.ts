import { createReadStream, statSync, rmSync } from 'node:fs'
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

  // -- helpers ---------------------------------------------------------------------------------------------

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
      tempDir: app.cfg.uploadsRoot,
    })

    reply.header('content-type', 'application/gzip')
    reply.header('content-disposition', `attachment; filename="${result.fileName}"`)
    void statSync(result.file).size // materialize before streaming
    const stream = createReadStream(result.file)
    reply.send(stream)
    // Cleanup after transfer completes.
    stream.once('close', () => rmSync(result.file, { force: true }))
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
