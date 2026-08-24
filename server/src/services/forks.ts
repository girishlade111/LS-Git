import { join } from 'node:path'
import { AppError } from './identity.js'
import type { IdentityServices } from './identity.js'
import type { AppConfig } from '../config.js'
import type { Actor } from '../authz.js'
import { can } from '../authz.js'
import type { ProjectRow, Visibility } from '../db/store.js'
import { GitRepository } from '../storage/repository.js'
import type { LocalHashedStorage } from '../storage/local.js'

/**
 * Fork system (GitLab fork-network parity).
 *
 * Model:
 *   - `projects.forked_from_project_id` — the DIRECT upstream of a fork.
 *   - `projects.fork_network_id`        — id of the network ROOT project.
 *     Every member carries it, so the whole network loads in ONE indexed
 *     query; the tree is assembled in memory. No recursive SQL per page.
 *
 * Storage: forking clones the entire object database at the storage layer
 * (commit SHAs are content-addressed ⇒ history/branches/tags transfer
 * verbatim). Sync transfers only missing objects upstream→fork and updates
 * refs with optimistic CAS — fork-side commits are never overwritten.
 */

export type ForkDivergenceState = 'up_to_date' | 'ahead' | 'behind' | 'diverged'

const VISIBILITY_RANK: Record<Visibility, number> = { private: 0, internal: 1, public: 2 }

export interface ForkOutcome {
  project: ProjectRow
  source: { id: number; full_path: string }
}

export interface DivergenceReport {
  state: ForkDivergenceState
  branch: string
  upstream_branch: string
  fork_tip: string | null
  upstream_tip: string | null
  behind_count: number
  ahead_count: number
}

const SYNC_MAX_COMMITS = 5_000

export class ForksService {
  constructor(
    private s: IdentityServices,
    private cfg: AppConfig,
    private storage: LocalHashedStorage,
  ) {}

  // ------------------------------------------------------------------ gates --

  private projectCtx(project: ProjectRow) {
    return {
      resourceProject: {
        ownerId: project.owner_id,
        visibility: project.visibility,
        archived: !!project.archived,
      },
    }
  }

  private requireProject(projectId: number): ProjectRow {
    const p = this.s.projects.byId(projectId)
    if (!p) throw new AppError(404, 'Project not found')
    return p
  }

  private authorizeOrThrow(actor: Actor | null, permission: Parameters<typeof can>[1], project?: ProjectRow): void {
    const ok = can(actor, permission, project ? this.projectCtx(project) : {})
    if (!ok) {
      throw new AppError(
        actor ? 403 : 401,
        actor ? 'You are not allowed to perform this action on this project' : 'Authentication required',
        actor ? 'forbidden' : 'unauthenticated',
      )
    }
  }

  private failAuth(actor: Actor | null, detail: Record<string, unknown>): never {
    this.s.audit.record({
      userId: actor?.userId ?? undefined,
      name: 'repo_write_denied',
      detail,
    })
    throw new AppError(
      actor ? 403 : 401,
      actor ? 'You are not allowed to perform this action' : 'Authentication required',
      actor ? 'forbidden' : 'unauthenticated',
    )
  }

  private openEngine(project: ProjectRow): GitRepository {
    try {
      return this.storage.repository(project.disk_path)
    } catch (err) {
      if ((err as { code?: string }).code === 'repository_not_found') {
        throw new AppError(422, 'The repository has not been created yet', 'repository_missing')
      }
      throw err
    }
  }

  private fullPath(p: ProjectRow): string {
    const owner = this.s.users.byId(p.owner_id)
    return `${owner?.username ?? ''}/${p.path}`
  }

  // ------------------------------------------------------------------- fork --

  /**
   * Forks a repository into a target namespace.
   *
   * Validation order: source readable → namespace resolvable → path free →
   * visibility capped at source visibility (a fork may never start MORE
   * visible than its upstream). The object database is cloned verbatim so all
   * history, branches and tags survive with identical SHAs.
   */
  createFork(
    actor: Actor | null,
    sourceProjectId: number,
    input: { path?: string; name?: string; visibility?: Visibility; namespace?: string },
  ): ForkOutcome {
    const source = this.requireProject(sourceProjectId)

    // 1) Reading the source is the gate for forking it (private-repo rule),
    //    plus the generic create permission on the platform.
    this.authorizeOrThrow(actor, 'project:read', source)
    this.authorizeOrThrow(actor, 'project:create')

    const user = this.s.users.byId(actor!.userId)
    if (!user || user.state !== 'active') throw new AppError(403, 'Account cannot fork repositories')

    // 2) Namespace resolution. User namespaces today; organization namespaces
    //    arrive with the collaboration phase (groups tables) — rejected with a
    //    dedicated code so callers can distinguish.
    const requestedNamespace = String(input.namespace ?? '').trim().toLowerCase()
    let targetOwner = user
    if (requestedNamespace && requestedNamespace !== user.username) {
      const nsUser = this.s.users.byUsername(requestedNamespace)
      if (!nsUser && !['users', 'user'].includes(requestedNamespace)) {
        // Not an existing user namespace — organizations are not implemented yet.
        throw new AppError(422, 'Forking to an organization namespace arrives with the collaboration phase', 'namespace_unsupported')
      }
      if (nsUser && nsUser.id !== user.id && !actor!.admin) {
        throw new AppError(403, 'You can only fork into your own namespace')
      }
      if (nsUser) targetOwner = nsUser
    }

    // 3) Path/name defaults + duplicate check.
    const path = String(input.path ?? source.path).trim().toLowerCase()
    if (!path) throw new AppError(400, 'A fork path is required', 'validation_failed')
    if (this.s.projects.byOwnerPath(targetOwner.username, path)) {
      throw new AppError(409, 'Path has already been taken in the target namespace', 'path_taken')
    }
    const name = String(input.name ?? '').trim() || source.name

    // 4) Visibility validation: a fork may never exceed its upstream.
    const requested: Visibility =
      input.visibility === 'public' || input.visibility === 'internal' || input.visibility === 'private'
        ? input.visibility
        : source.visibility
    if (VISIBILITY_RANK[requested] > VISIBILITY_RANK[source.visibility]) {
      throw new AppError(
        400,
        `A fork of a ${source.visibility} project cannot be ${requested}`,
        'visibility_exceeds_source',
      )
    }

    // 5) Metadata row inside a transaction (id drives the hashed disk path).
    let fork!: ProjectRow
    try {
      fork = this.s.db.transaction(() =>
        this.s.projects.create({
          owner_id: targetOwner.id,
          name,
          path,
          visibility: requested,
          description: source.description,
          website_url: source.website_url,
          default_branch: source.default_branch,
          disk_path: '',
          initialized: !!source.initialized,
        }),
      )
      const diskPath = this.storage.diskPathFor(fork.id)
      this.s.projects.update(fork.id, {
        disk_path: diskPath,
        forked_from_project_id: source.id,
        fork_network_id: source.fork_network_id ?? source.id,
      } as never)
      // Repository configuration policy: protection rules are NOT copied —
      // forks define their own protection posture (GitLab parity).
      this.s.protectedBranches.ensure(fork.id, source.default_branch, 'maintainer')
      fork = this.requireProject(fork.id)
    } catch (err) {
      if (String((err as Error).message).includes('UNIQUE')) {
        throw new AppError(409, 'Path has already been taken in the target namespace', 'path_taken')
      }
      throw err
    }

    // 6) Disk effect: full object+ref clone (history preserved by SHA).
    try {
      if (source.initialized) {
        this.storage.copyRepository(source.disk_path, fork.disk_path, {
          defaultBranch: source.default_branch,
        })
      } else {
        GitRepository.createBare(join(this.cfg.repositoriesRoot, fork.disk_path), fork.default_branch)
      }
    } catch (err) {
      // Compensating metadata cleanup keeps DB consistent with storage.
      this.dbCleanupFailedFork(fork.id)
      throw new AppError(500, 'Failed to clone repository storage for the fork')
    }

    this.s.events.emit(fork.id, 'project.forked', {
      source_project_id: source.id,
      source_full_path: this.fullPath(source),
      fork_id: fork.id,
      fork_full_path: this.fullPath(fork),
      actor_user_id: actor!.userId,
    })
    this.s.audit.record({
      userId: actor!.userId,
      name: 'profile_updated',
      detail: { kind: 'project_forked', source_id: source.id, fork_id: fork.id },
    })

    return {
      project: fork,
      source: { id: source.id, full_path: this.fullPath(source) },
    }
  }

  private dbCleanupFailedFork(forkId: number): void {
    this.s.db.transaction(() => {
      this.s.redirects.deleteForProject(forkId)
      this.s.db.run('DELETE FROM projects WHERE id = ?', forkId)
      this.s.topics.pruneOrphans()
    })
  }

  // -------------------------------------------------------------- divergence --

  /** Requires the project to actually BE a fork. */
  private requireFork(projectId: number): { project: ProjectRow; upstream: ProjectRow } {
    const project = this.requireProject(projectId)
    if (project.forked_from_project_id == null) {
      throw new AppError(422, 'This project is not a fork', 'not_a_fork')
    }
    const upstream = this.s.projects.byId(project.forked_from_project_id)
    if (!upstream) throw new AppError(422, 'The upstream project no longer exists', 'upstream_missing')
    return { project, upstream }
  }

  /**
   * Upstream divergence for one branch: behind / ahead / diverged / up_to_date.
   * Counts come from real git reachability, never application records.
   */
  divergence(actor: Actor | null, projectId: number, opts: { branch?: string | null } = {}): DivergenceReport {
    const { project, upstream } = this.requireFork(projectId)
    this.authorizeOrThrow(actor, 'project:read', project)

    const forkRepo = this.openEngine(project)
    const upstreamRepo = this.openEngine(upstream)

    const branch = String(opts.branch ?? project.default_branch)
    const forkTip = forkRepo.resolveBranch(branch)
    const upstreamTip = upstreamRepo.resolveBranch(branch) ?? upstreamRepo.resolveBranch(upstream.default_branch)
    if (!forkTip && !upstreamTip) {
      throw new AppError(404, `Branch '${branch}' does not exist in the fork or upstream`, 'branch_missing')
    }

    const behindSet = this.reachableExcluding(upstreamRepo, upstreamTip, forkTip)
    const aheadSet = this.reachableExcluding(forkRepo, forkTip, upstreamTip)

    let state: ForkDivergenceState
    if (behindSet.size === 0) state = aheadSet.size === 0 ? 'up_to_date' : 'ahead'
    else state = aheadSet.size === 0 ? 'behind' : 'diverged'

    return {
      state,
      branch,
      upstream_branch: branch,
      fork_tip: forkTip,
      upstream_tip: upstreamTip,
      behind_count: behindSet.size,
      ahead_count: aheadSet.size,
    }
  }

  // -------------------------------------------------------------------- sync --

  /**
   * Sync Fork: fast-forwards the fork's branch to the upstream tip.
   *
   * Safety model:
   *   - up_to_date / ahead → nothing to change (reported, not mutated);
   *   - behind             → missing objects transferred upstream→fork, then
   *                          CAS ref update (expectedOld = fork tip) — a racing
   *                          writer conflicts instead of being clobbered;
   *   - diverged           → REFUSED. Fork-side work is never overwritten;
   *                          the report explains both sides.
   */
  syncBranch(
    actor: Actor | null,
    projectId: number,
    opts: { branch?: string | null } = {},
  ): { outcome: 'updated' | 'noop'; report: DivergenceReport } {
    const { project, upstream } = this.requireFork(projectId)
    this.authorizePush(actor, project)

    const report = this.divergence(actor, projectId, { branch: opts.branch ?? project.default_branch })

    if (report.state === 'diverged') {
      this.s.audit.record({
        userId: actor!.userId,
        name: 'repo_write_denied',
        detail: { kind: 'sync_refused_diverged', project_id: project.id, ...pickCounts(report) },
      })
      throw new AppError(
        409,
        `Branch has diverged from upstream (${report.ahead_count} local, ${report.behind_count} upstream commits). Fork changes are preserved — reconcile manually.`,
        'fork_diverged',
        { code: 'fork_diverged', ...pickCounts(report), fork_tip: report.fork_tip, upstream_tip: report.upstream_tip },
      )
    }
    if (report.state !== 'behind') {
      return { outcome: 'noop', report } // up_to_date or ahead — nothing to do
    }

    // Transfer every missing object from the upstream store…
    const copied = this.storage.copyObjectsInto(
      upstream.disk_path,
      project.disk_path,
      report.upstream_tip!,
      { maxObjects: SYNC_MAX_COMMITS * 50 },
    )

    // …then fast-forward the ref under CAS.
    const forkRepo = this.openEngine(project)
    forkRepo.updateRef(`refs/heads/${report.branch}`, report.upstream_tip!, report.fork_tip)

    this.s.events.emit(project.id, 'repo.push', {
      ref: `refs/heads/${report.branch}`,
      before: report.fork_tip,
      after: report.upstream_tip,
      action: 'fork_synced',
      objects_copied: copied,
      upstream_project_id: upstream.id,
      actor_user_id: actor!.userId,
    })
    this.s.audit.record({
      userId: actor!.userId,
      name: 'repo_ref_updated',
      detail: { kind: 'fork_sync', project_id: project.id, branch: report.branch, objects_copied: copied },
    })
    return { outcome: 'updated', report: { ...report, fork_tip: report.upstream_tip } }
  }

  private authorizePush(actor: Actor | null, project: ProjectRow): void {
    const ok = can(actor, 'project:push_code', this.projectCtx(project))
    if (!ok) this.failAuth(actor, { kind: 'push_denied', action: 'fork_sync', project_id: project.id })
  }

  /** Commits reachable from `tip` but NOT from `exclude` (bounded walks). */
  private reachableExcluding(
    repo: GitRepository,
    tip: string | null,
    exclude: string | null,
  ): Set<string> {
    const out = new Set<string>()
    if (!tip) return out
    const excluded = new Set<string>()
    if (exclude) {
      const f: string[] = [exclude]
      let g = 0
      while (f.length > 0 && g++ < SYNC_MAX_COMMITS * 2) {
        const s = f.shift()!
        if (excluded.has(s)) continue
        excluded.add(s)
        f.push(...repo.readCommit(s).parents)
      }
    }
    const f: string[] = [tip]
    let g = 0
    while (f.length > 0 && g++ < SYNC_MAX_COMMITS * 2) {
      const s = f.shift()!
      if (out.has(s) || excluded.has(s)) continue
      out.add(s)
      f.push(...repo.readCommit(s).parents)
    }
    return out
  }

  // ------------------------------------------------------------------ detach --

  /**
   * Detach removes the upstream relationship AND network membership. Requires
   * owner/admin plus typed confirmation of the full project path (GitLab's
   * strong-confirmation pattern for irreversible-ish relationship surgery).
   */
  detachFork(actor: Actor | null, projectId: number, confirmPath: string): { detached: boolean } {
    const project = this.requireProject(projectId)
    if (project.forked_from_project_id == null) {
      throw new AppError(422, 'This project is not a fork', 'not_a_fork')
    }
    this.authorizeOrThrow(actor, 'project:update', project)

    const expected = this.fullPath(project).toLowerCase()
    if (String(confirmPath ?? '').trim().toLowerCase() !== expected) {
      throw new AppError(400, `Confirmation failed. Type "${expected}" to confirm detaching.`)
    }

    this.s.db.transaction(() => {
      this.s.projects.update(project.id, {
        forked_from_project_id: null,
        fork_network_id: null,
      } as never)
    })
    this.s.events.emit(project.id, 'project.updated', {
      kind: 'fork_detached',
      former_upstream_id: project.forked_from_project_id,
      actor_user_id: actor?.userId ?? null,
    })
    this.s.audit.record({
      userId: actor!.userId,
      name: 'profile_updated',
      detail: { kind: 'fork_detached', project_id: project.id },
    })
    return { detached: true }
  }

  // ----------------------------------------------------------------- network --

  /**
   * Fork network graph. Loads ALL members with ONE indexed query on
   * fork_network_id, assembles the tree in memory, and computes descendant
   * totals bottom-up — no recursion at query time.
   */
  networkGraph(
    actor: Actor | null,
    anchorProjectId: number,
  ): {
    root: NetworkNode
    members: Array<NetworkNode>
    total_size: number
    max_depth: number
  } {
    const anchor = this.requireProject(anchorProjectId)
    this.authorizeOrThrow(actor, 'project:read', anchor)

    const networkId = anchor.fork_network_id ?? anchor.id
    const rows = this.s.db.all(
      `SELECT p.id, p.name, p.path, p.visibility, p.owner_id, p.default_branch,
              p.forked_from_project_id AS forked_from, p.created_at,
              u.username AS owner_username
         FROM projects p JOIN users u ON u.id = p.owner_id
        WHERE p.fork_network_id = ?
        ORDER BY p.created_at ASC`,
      networkId,
    ) as Array<{
      id: number; name: string; path: string; visibility: Visibility; owner_id: number
      default_branch: string; forked_from: number | null; created_at: string; owner_username: string
    }>
    // Root might pre-date the fork columns (networkId === its own id).
    if (!rows.some((r) => r.id === networkId)) {
      const rootRow = this.s.projects.byId(networkId)
      if (rootRow) {
        rows.unshift({
          id: rootRow.id,
          name: rootRow.name,
          path: rootRow.path,
          visibility: rootRow.visibility,
          owner_id: rootRow.owner_id,
          default_branch: rootRow.default_branch,
          forked_from: null,
          created_at: rootRow.created_at,
          owner_username: this.s.users.byId(rootRow.owner_id)?.username ?? '',
        })
      }
    }

    const nodes = new Map<number, NetworkNode>()
    for (const r of rows) {
      nodes.set(r.id, {
        id: r.id,
        name: r.name,
        path: r.path,
        full_path: `${r.owner_username}/${r.path}`,
        visibility: r.visibility,
        default_branch: r.default_branch,
        forked_from: r.forked_from,
        is_root: r.id === networkId && r.forked_from === null,
        direct_forks: 0,
        total_descendants: 0,
        children: [],
      })
    }
    let root: NetworkNode | null = null
    for (const node of nodes.values()) {
      const parentId = node.forked_from
      if (parentId != null && nodes.has(parentId)) {
        nodes.get(parentId)!.children.push(node)
      } else if (node.is_root || parentId === null) {
        root = node
      }
    }
    if (!root) root = nodes.get(networkId) ?? [...nodes.values()][0]!
    if (!root) throw new AppError(404, 'Project not found')

    // Bottom-up subtree sizes + depth (fork networks are shallow; recursion
    // here is bounded by network depth, not size).
    const computeSizes = (n: NetworkNode): number => {
      n.direct_forks = n.children.length
      n.total_descendants = n.children.reduce((acc, c) => acc + 1 + computeSizes(c), 0)
      return n.total_descendants
    }
    computeSizes(root)
    for (const node of nodes.values()) {
      if (node !== root && node.children.length > 0) {
        node.direct_forks = node.children.length
        node.total_descendants = node.children.reduce((acc, c) => acc + 1 + c.total_descendants, 0)
      }
    }

    const members = [...nodes.values()].sort((a, b) => a.full_path.localeCompare(b.full_path))
    return { root, members, total_size: nodes.size, max_depth: computeDepth(root, nodes) }
  }
}

// ---------------------------------------------------------------------------
// Helpers & view types
// ---------------------------------------------------------------------------

export interface NetworkNode {
  id: number
  name: string
  path: string
  full_path: string
  visibility: Visibility
  default_branch: string
  forked_from: number | null
  is_root: boolean
  direct_forks: number
  total_descendants: number
  children: NetworkNode[]
}

function pickCounts(r: DivergenceReport): { behind_count: number; ahead_count: number } {
  return { behind_count: r.behind_count, ahead_count: r.ahead_count }
}

function computeDepth(root: NetworkNode, nodes: Map<number, NetworkNode>): number {
  let max = 1
  const walk = (n: NetworkNode, d: number): void => {
    max = Math.max(max, d)
    for (const c of n.children) walk(c, d + 1)
  }
  walk(root, 1)
  void nodes
  return max
}
