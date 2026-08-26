import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from './identity.js'
import type { IdentityServices } from './identity.js'
import type { LocalHashedStorage } from '../storage/local.js'
import type { GitRepository } from '../storage/repository.js'
import type { ProjectRow, ReleaseRow, ReleaseAssetRow } from '../db/store.js'
import type { Actor } from '../authz.js'
import { can } from '../authz.js'

/**
 * Releases — GitLab release/tag behavior on LSGit naming.
 *
 * A release binds metadata to a git tag (either an EXISTING tag or a NEW
 * annotated tag created at the given ref). Lifecycle: draft -> published
 * (one-way; publishing stamps released_at). Prereleases never displace an
 * older stable as "latest"; if only prereleases exist, the newest of them is
 * returned and flagged.
 *
 * ASSET FLOW (per requirement): upload -> validate (size/name) -> store
 * object on disk -> persist metadata with sha256 checksum -> serve via a
 * visibility-gated download endpoint. Re-uploading the same filename
 * REPLACES the stored object and recomputes the checksum. Checksums are
 * computed server-side at upload; clients verify after download.
 *
 * RELEASE NOTES: generated ONLY when explicitly requested via the generate
 * endpoint; the result is RETURNED for review and never auto-saved.
 */

const MAX_ASSET_BYTES = 100 * 1024 * 1024
const MAX_FILENAME = 120

export class ReleaseService {
  constructor(
    private s: IdentityServices,
    private storage: LocalHashedStorage,
    private assetsRoot: string,
  ) {}

  // ── gates ───────────────────────────────────────────────────────────────

  private projectCtx(project: ProjectRow) {
    return {
      resourceProject: {
        ownerId: project.owner_id,
        visibility: project.visibility,
      },
    }
  }

  private readableProject(actor: Actor | null, projectId: number): ProjectRow {
    const p = this.s.projects.byId(projectId)
    if (!p) throw new AppError(404, 'Project not found')
    if (!can(actor, 'project:read', this.projectCtx(p))) {
      throw new AppError(actor ? 404 : 401, actor ? 'Project not found' : 'Authentication required')
    }
    return p
  }

  private requireMaintainer(actor: Actor | null, project: ProjectRow): void {
    if (!can(actor, 'release:maintain', this.projectCtx(project))) {
      throw new AppError(actor ? 403 : 401, 'Only maintainers can manage releases', 'forbidden')
    }
  }

  private visibleRelease(actor: Actor | null, projectId: number, tag: string): { release: ReleaseRow; project: ProjectRow } {
    const project = this.readableProject(actor, projectId)
    const release = this.s.releases.byTag(projectId, tag)
    const maintainer = can(actor, 'release:maintain', this.projectCtx(project))
    if (!release || release.project_id !== projectId) throw new AppError(404, 'Release not found')
    // Drafts are hidden from non-maintainers until published.
    if (release.state === 'draft' && !maintainer) throw new AppError(404, 'Release not found')
    return { release, project }
  }

  private engineFor(project: ProjectRow): GitRepository {
    try {
      return this.storage.repository(project.disk_path)
    } catch {
      throw new AppError(422, 'Repository unavailable', 'repository_missing')
    }
  }

  // ── create ───────────────────────────────────────────────────────────────

  create(
    actor: Actor,
    projectId: number,
    input: Record<string, unknown>,
  ): ReleaseRow & { assets: ReleaseAssetRow[] } {
    const project = this.s.projects.byId(projectId)
    if (!project) throw new AppError(404, 'Project not found')
    this.requireMaintainer(actor, project)

    const tagName = String(input.tag_name ?? '').trim()
    if (!tagName) throw new AppError(400, 'tag_name is required')

    const name = typeof input.name === 'string' && input.name.trim() !== '' ? input.name.trim().slice(0, 200) : null
    const description = typeof input.description === 'string' ? input.description.slice(0, 50_000) : ''
    const prerelease = input.prerelease === true
    // GitLab parity: releases are PUBLISHED unless an explicit draft is requested.
    const draft = input.draft === true

    if (this.s.releases.byTag(projectId, tagName)) {
      throw new AppError(409, `A release for tag '${tagName}' already exists`, 'taken')
    }

    const repo = this.engineFor(project)
    let existingTagSha = repo.resolveTag(tagName)

    if (!existingTagSha) {
      // NEW TAG support: create an annotated tag at `ref` (default: default branch).
      const refRaw = typeof input.ref === 'string' && input.ref.trim() !== '' ? input.ref.trim() : project.default_branch
      const resolved = repo.resolveBranch(refRaw)
        ?? (() => {
          try { return repo.readRef(`refs/tags/${refRaw}`) } catch { return null }
        })()
      if (!resolved) throw new AppError(422, `Cannot create tag '${tagName}': ref '${refRaw}' not found`, 'ref_not_found')
      repo.createTag({
        name: tagName,
        target: resolved,
        message: typeof input.tag_message === 'string' && input.tag_message.trim() !== '' ? input.tag_message : `Release ${tagName}`,
        tagger: { name: actor.username, email: `${actor.username}@users.lsgit.local` },
      })
      existingTagSha = repo.resolveTag(tagName)!
    }

    const state: 'draft' | 'published' = draft ? 'draft' : 'published'
    const releasedAt = state === 'published' ? new Date().toISOString() : null

    const row = this.s.releases.create({
      project_id: projectId,
      tag_name: tagName,
      name,
      description,
      state,
      is_prerelease: prerelease,
      released_at: releasedAt,
      author_id: actor.userId,
    })
    // Consistent serialized view everywhere (booleans, asset_count, paths).
    return { ...this.releaseView(row), draft: state === 'draft', assets: [] }
  }

  // ── read / history / latest ────────────────────────────────────────────────

  list(actor: Actor | null, projectId: number) {
    const project = this.readableProject(actor, projectId)
    const maintainer = can(actor, 'release:maintain', this.projectCtx(project))
    const rows = this.s.releases.listForProject(projectId, maintainer)
    return {
      releases: rows.map((r) => ({
        ...this.releaseView(r),
        ...(r.state === 'draft' ? { draft: true } : {}),
      })),
    }
  }

  get(actor: Actor | null, projectId: number, tag: string) {
    const { release, project } = this.visibleRelease(actor, projectId, tag)
    void project
    return { release: { ...this.releaseView(release), assets: this.assetViews(release.id) } }
  }

  /**
   * Latest determination (documented rule): among PUBLISHED releases,
   * prefer stable over prerelease; within each class order by released_at.
   */
  latest(actor: Actor | null, projectId: number) {
    // Actor only gates visibility upstream; kept for API symmetry.
    void actor
    const published = this.s.releases.listForProject(projectId, false).filter((r) => r.state === 'published')
    if (published.length === 0) throw new AppError(404, 'No published releases', 'no_releases')
    const stable = published.filter((r) => !r.is_prerelease)
    const pick = (stable.length > 0 ? stable : published).reduce((a, b) =>
      (b.released_at ?? '') > (a.released_at ?? '') ? b : a,
    )
    return { release: { ...this.releaseView(pick), assets: this.assetViews(pick.id) }, is_prerelease_fallback: stable.length === 0 }
  }

  releaseView(r: ReleaseRow) {
    const author = (() => {
      const u = this.s.users.byId(r.author_id)
      return u ? { id: u.id, username: u.username, name: u.name } : null
    })()
    return {
      id: r.id,
      tag_name: r.tag_name,
      name: r.name ?? r.tag_name,
      description: r.description,
      state: r.state,
      is_prerelease: !!r.is_prerelease,
      released_at: r.released_at,
      author,
      created_at: r.created_at,
      updated_at: r.updated_at,
      asset_count: this.s.releaseAssets.listForRelease(r.id).length,
      assets_path: `/api/v1/projects/${r.project_id}/releases/${encodeURIComponent(r.tag_name)}/assets`,
    }
  }

  private assetViews(releaseId: number) {
    return this.s.releaseAssets.listForRelease(releaseId).map((a) => ({
      id: a.id,
      filename: a.filename,
      size: a.size,
      sha256: a.sha256,
      content_type: a.content_type,
      download_url: `/api/v1/projects/${this.projectOf(a)}/releases/${encodeURIComponent(this.tagNameOf(a))}/assets/${encodeURIComponent(a.filename)}/download`,
    }))
  }

  private projectOf(a: ReleaseAssetRow): number {
    const rel = this.s.releases.byId(a.release_id)
    return rel!.project_id
  }

  private tagNameOf(a: ReleaseAssetRow): string {
    return this.s.releases.byId(a.release_id)!.tag_name
  }

  // ── update / publish ────────────────────────────────────────────────────────

  update(actor: Actor, projectId: number, tag: string, patch: Record<string, unknown>): ReleaseRow {
    const project = this.s.projects.byId(projectId)
    if (!project) throw new AppError(404, 'Project not found')
    this.requireMaintainer(actor, project)
    const release = this.s.releases.byTag(projectId, tag)
    if (!release) throw new AppError(404, 'Release not found')
    if (release.state === 'published') {
      throw new AppError(422, 'Published releases are immutable — delete and recreate instead', 'published_immutable')
    }

    const sets: Record<string, unknown> = {}
    if (patch.name !== undefined) sets.name = patch.name === null ? null : String(patch.name).slice(0, 200)
    if (patch.description !== undefined) sets.description = String(patch.description ?? '').slice(0, 50_000)
    if (patch.prerelease !== undefined) sets.is_prerelease = patch.prerelease === true ? 1 : 0

    const event = patch.state_event
    if (event === 'publish') {
      sets.state = 'published'
      sets.released_at = new Date().toISOString()
    } else if (event !== undefined) {
      throw new AppError(400, "state_event must be 'publish'")
    }

    this.s.db.transaction(() => {
      this.s.releases.update(release.id, sets as never)
      if (sets.state === 'published') {
        this.fanout(projectId, 'release.published', {
          action: 'published',
          title: (sets.name as string | undefined) ?? release.name ?? release.tag_name,
          tag: release.tag_name,
          actor_user_id: actor.userId,
          actor_username: actor.username,
          participant_user_ids: [release.author_id],
        })
      }
    })
    return this.s.releases.byId(release.id)!
  }

  delete(actor: Actor, projectId: number, tag: string): void {
    const project = this.s.projects.byId(projectId)
    if (!project) throw new AppError(404, 'Project not found')
    this.requireMaintainer(actor, project)
    const release = this.s.releases.byTag(projectId, tag)
    if (!release) throw new AppError(404, 'Release not found')

    // Remove asset files best-effort BEFORE dropping metadata (rows cascade).
    for (const asset of this.s.releaseAssets.listForRelease(release.id)) {
      try { unlinkSync(asset.stored_path) } catch { /* already gone */ }
    }
    this.s.db.transaction(() => this.s.releases.delete(release.id))
    // The GIT TAG itself is untouched — deleting a release never rewrites history.
  }

  // ── release notes generation ────────────────────────────────────────────────

  /**
   * Explicit notes generation from commit history (and merged PR titles)
   * between the PREVIOUS tag and this release's tag. Returns the markdown
   * for review — it is NEVER auto-written into the release description.
   */
  generateNotes(actor: Actor, projectId: number, tag: string, opts: { previous_tag?: string }): { markdown: string; commit_count: number; merged_prs: number } {
    const project = this.s.projects.byId(projectId)!
    this.requireMaintainer(actor, project)
    const release = this.s.releases.byTag(projectId, tag)
    if (!release) throw new AppError(404, 'Release not found')

    const repo = this.engineFor(project)
    const currentSha = repo.resolveTag(tag) ?? repo.resolveBranch(project.default_branch)
    if (!currentSha) throw new AppError(422, 'Nothing to generate notes from', 'empty_history')

    const allTags = repo.listTags().sort((a, b) => {
      const ta = repo.readCommit(a.sha).committer.timestamp.time
      const tb = repo.readCommit(b.sha).committer.timestamp.time
      return tb - ta
    })
    const idx = allTags.findIndex((t) => t.name === tag)
    const previous =
      (opts.previous_tag && repo.resolveTag(opts.previous_tag)) ||
      (idx >= 0 && idx + 1 < allTags.length ? allTags[idx + 1]!.sha : null)

    const aheadSet = new Set<string>()
    const frontier: string[] = [currentSha]
    let guard = 0
    while (frontier.length > 0 && guard++ < 10_000) {
      const sha = frontier.shift()!
      if (aheadSet.has(sha)) continue
      aheadSet.add(sha)
      frontier.push(...repo.readCommit(sha).parents)
    }
    const excluded = new Set<string>()
    if (previous) {
      const f2: string[] = [previous]
      guard = 0
      while (f2.length > 0 && guard++ < 10_000) {
        const sha = f2.shift()!
        if (excluded.has(sha)) continue
        excluded.add(sha)
        f2.push(...repo.readCommit(sha).parents)
      }
    }
    for (const s of excluded) aheadSet.delete(s)

    const commits = [...aheadSet]
      .map((sha) => repo.readCommit(sha))
      .sort((a, b) => a.committer.timestamp.time - b.committer.timestamp.time)

    const lines: string[] = [`# ${release.name ?? tag}`, '']
    lines.push('## Changes')
    if (commits.length === 0) lines.push('_No commits in this range._')
    for (const c of commits) {
      const title = c.message.split('\n')[0] ?? c.message
      lines.push(`- ${title} (${c.sha.slice(0, 8)})`)
    }

    // Merged PRs whose merge/squash commit landed inside the range.
    const mergedPrs = this.s.pullRequests
      .listFiltered(projectId, { state: 'merged' })
      .rows.filter((pr) => {
        const sha = pr.merge_commit_sha ?? pr.squash_commit_sha
        return sha !== null && aheadSet.has(sha)
      })
    if (mergedPrs.length > 0) {
      lines.push('', '## Merged pull requests')
      for (const pr of mergedPrs) lines.push(`- !${pr.iid} ${pr.title}`)
    }

    return {
      markdown: lines.join('\n'),
      commit_count: commits.length,
      merged_prs: mergedPrs.length,
    }
  }

  // ── assets ────────────────────────────────────────────────────────────────

  private assetDirFor(projectId: number): string {
    const dir = join(this.assetsRoot, '@release-assets', String(projectId))
    mkdirSync(dir, { recursive: true })
    return dir
  }

  private safeFilename(raw: unknown): string {
    const rawName = String(raw ?? '')
    // Reject separators/dot-segments on the RAW value first — basename() would
    // silently neutralize them and mask client mistakes.
    if (rawName.includes('/') || rawName.includes('\\') || rawName.includes('..')) {
      throw new AppError(400, 'filename must not contain path separators')
    }
    const name = rawName.trim()
    if (!name || name.startsWith('.')) throw new AppError(400, 'filename is required and cannot start with a dot')
    if (name.length > MAX_FILENAME) throw new AppError(400, `filename exceeds ${MAX_FILENAME} characters`)
    return name
  }

  /**
   * Asset flow: validate -> store object -> persist metadata (with server-side
   * sha256). Re-uploading the same filename REPLACES the stored object and
   * refreshes the checksum/size — the replacement policy.
   */
  uploadAsset(
    actor: Actor,
    projectId: number,
    tag: string,
    rawFilename: unknown,
    contentTypeHeader: unknown,
    bytes: Buffer,
  ): { asset: ReleaseAssetRow; replaced: boolean } {
    const project = this.s.projects.byId(projectId)!
    this.requireMaintainer(actor, project)
    const release = this.s.releases.byTag(projectId, tag)
    if (!release) throw new AppError(404, 'Release not found')

    const filename = this.safeFilename(rawFilename)
    if (bytes.length === 0) throw new AppError(400, 'asset body is empty')
    if (bytes.length > MAX_ASSET_BYTES) {
      throw new AppError(413, `Asset exceeds the ${Math.floor(MAX_ASSET_BYTES / 1024 / 1024)} MB limit`)
    }

    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const storedPath = join(this.assetDirFor(projectId), `${release.id}_${sha256.slice(0, 16)}_${filename}`)
    writeFileSync(storedPath, bytes)

    const existing = this.s.releaseAssets.byName(release.id, filename)
    if (existing) {
      try { if (existsSync(existing.stored_path)) unlinkSync(existing.stored_path) } catch { /* best effort */ }
      this.s.db.run(
        `UPDATE release_assets SET size = ?, sha256 = ?, content_type = ?, stored_path = ?, uploaded_by_id = ?, created_at = ? WHERE id = ?`,
        bytes.length,
        sha256,
        typeof contentTypeHeader === 'string' && contentTypeHeader !== '' ? contentTypeHeader : 'application/octet-stream',
        storedPath,
        actor.userId,
        nowIsoSafe(),
        existing.id,
      )
      return { asset: this.s.releaseAssets.byId(existing.id)!, replaced: true }
    }
    const asset = this.s.releaseAssets.create({
      release_id: release.id,
      filename,
      size: bytes.length,
      sha256,
      content_type: typeof contentTypeHeader === 'string' && contentTypeHeader !== '' ? contentTypeHeader : 'application/octet-stream',
      stored_path: storedPath,
      uploaded_by_id: actor.userId,
    })
    return { asset, replaced: false }
  }

  /** Streams an asset after visibility gating; checksum travels in headers. */
  download(actor: Actor | null, projectId: number, tag: string, filename: string): { path: string; asset: ReleaseAssetRow } {
    const { release, project } = this.visibleRelease(actor, projectId, tag)
    void project
    const asset = this.s.releaseAssets.byName(release.id, decodeURIComponent(filename))
    if (!asset) throw new AppError(404, 'Asset not found')
    if (!existsSync(asset.stored_path)) throw new AppError(404, 'Asset file missing from storage')
    return { path: asset.stored_path, asset }
  }

  deleteAsset(actor: Actor, projectId: number, tag: string, filename: string): void {
    const project = this.s.projects.byId(projectId)!
    this.requireMaintainer(actor, project)
    const release = this.s.releases.byTag(projectId, tag)
    if (!release) throw new AppError(404, 'Release not found')
    const asset = this.s.releaseAssets.byName(release.id, filename)
    if (!asset) throw new AppError(404, 'Asset not found')
    try { if (existsSync(asset.stored_path)) unlinkSync(asset.stored_path) } catch { /* best effort */ }
    this.s.releaseAssets.delete(asset.id)
  }

  private fanout(projectId: number, type: string, payload: Record<string, unknown>): void {
    this.s.events.emit(projectId, type, payload)
  }
}

function nowIsoSafe(): string {
  return new Date().toISOString()
}
