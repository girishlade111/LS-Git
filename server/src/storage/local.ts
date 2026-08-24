import { createHash, randomUUID } from 'node:crypto'
import { cpSync, mkdirSync, existsSync, rmSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { GitRepository } from './repository.js'

/**
 * Repository storage abstraction (STORAGE.md §2–§3).
 *
 * - Hashed disk paths derived from the project's database id:
 *     @hashed/h[0..1]/h[2..3]/<sha256(projectId)>.git
 *   Namespace/project renames and transfers therefore NEVER touch disk.
 * - Deletion is two-step (move to @trash/<uuid>, then purge) mirroring GitLab.
 * - All Git plumbing is delegated to the core engine (storage/repository.ts);
 *   this class owns layout + lifecycle policy only. The interface is exactly
 *   what a future gRPC git-core service exposes, so extraction is mechanical.
 */

export interface InitialFile {
  path: string
  content: string | Buffer
  mode?: '100644' | '100755'
}

export interface RepositoryStorage {
  /** Bare-init only: HEAD → default branch, no commits. */
  createRepository(diskPath: string, defaultBranch: string): void
  /** Bare init + initial commit on the default branch. */
  initializeWithFiles(
    diskPath: string,
    defaultBranch: string,
    files: Array<InitialFile>,
    author: { name: string; email: string },
    message: string,
  ): { commitSha: string }
  /** Files at the tip of a branch (used by create-from-template). */
  readBranchFiles(diskPath: string, branch: string): Map<string, Buffer>
  deleteRepository(diskPath: string): void
  exists(diskPath: string): boolean
  /** Hashed path for a project id (pure). */
  diskPathFor(projectId: number): string
}

const GIT_DIR_SUFFIX = '.git'

export class LocalHashedStorage implements RepositoryStorage {
  constructor(private root: string) {}

  diskPathFor(projectId: number): string {
    const hash = createHash('sha256').update(String(projectId)).digest('hex')
    return `@hashed/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}${GIT_DIR_SUFFIX}`
  }

  private absolute(diskPath: string): string {
    if (!diskPath.startsWith('@hashed/')) throw new Error('refusing non-hashed repository path')
    const resolved = join(this.root, diskPath)
    if (resolved.includes('..')) throw new Error('path traversal rejected')
    return resolved
  }

  /**
   * Opens the core Git engine bound to a hashed repository.
   * Throws RepositoryNotFoundError when the repository does not exist.
   */
  repository(diskPath: string): GitRepository {
    return GitRepository.open(this.absolute(diskPath))
  }

  exists(diskPath: string): boolean {
    return GitRepository.existsAt(this.absolute(diskPath))
  }

  createRepository(diskPath: string, defaultBranch: string): void {
    const abs = this.absolute(diskPath)
    if (!existsSync(abs)) GitRepository.createBare(abs, defaultBranch)
  }

  initializeWithFiles(
    diskPath: string,
    defaultBranch: string,
    files: Array<InitialFile>,
    author: { name: string; email: string },
    message: string,
  ): { commitSha: string } {
    const abs = this.absolute(diskPath)
    const repo = existsSync(abs)
      ? GitRepository.open(abs)
      : GitRepository.createBare(abs, defaultBranch)
    // Engine applyChangesToBranch handles tree building, the initial
    // parentless commit and the CAS ref write atomically.
    const result = repo.applyChangesToBranch({
      baseBranch: defaultBranch,
      targetBranch: defaultBranch,
      message,
      identity: author,
      changes: files.map((f) => ({
        path: f.path,
        content: f.content,
        mode: f.mode ?? '100644',
      })),
    })
    return { commitSha: result.commitSha }
  }

  readBranchFiles(diskPath: string, branch: string): Map<string, Buffer> {
    const repo = this.repository(diskPath)
    const tip = repo.resolveBranch(branch)
    if (!tip) throw new Error(`branch not found: ${branch}`)
    const out = new Map<string, Buffer>()
    for (const [path, entry] of repo.flattenTree(repo.readCommit(tip).tree)) {
      out.set(path, repo.readBlob(entry.sha))
    }
    return out
  }

  deleteRepository(diskPath: string): void {
    const abs = this.absolute(diskPath)
    if (!existsSync(abs)) return
    const trashRoot = join(this.root, '@trash')
    mkdirSync(trashRoot, { recursive: true })
    const trashPath = join(trashRoot, randomUUID())
    try {
      renameSync(abs, trashPath)
    } catch {
      // Cross-device or transient failure — fall back to direct removal.
      rmSync(abs, { recursive: true, force: true })
      return
    }
    rmSync(trashPath, { recursive: true, force: true })
  }

  /**
   * Full repository clone at the storage level (the fork primitive).
   *
   * Copies the ENTIRE object database plus all refs — commit SHAs are
   * content-addressed, so history, branches and tags transfer verbatim.
   * HEAD/config are written fresh for the new repository per policy.
   */
  copyRepository(srcDiskPath: string, destDiskPath: string, opts: { defaultBranch?: string } = {}): void {
    const src = GitRepository.open(this.absolute(srcDiskPath))
    const destAbs = this.absolute(destDiskPath)
    if (existsSync(destAbs)) throw new Error('destination repository already exists')

    // Fresh skeleton (bare init semantics).
    const repo = GitRepository.createBare(destAbs, opts.defaultBranch ?? src.defaultBranch())

    // Object database + packed-refs + refs/* verbatim.
    if (existsSync(join(src.path, 'objects'))) {
      cpSync(join(src.path, 'objects'), join(destAbs, 'objects'), { recursive: true })
    }
    for (const file of ['packed-refs']) {
      const from = join(src.path, file)
      if (existsSync(from)) cpSync(from, join(destAbs, file))
    }
    for (const ns of ['heads', 'tags']) {
      const from = join(src.path, 'refs', ns)
      if (existsSync(from)) cpSync(from, join(destAbs, 'refs', ns), { recursive: true })
    }
    void repo // skeleton already materialized on disk
  }

  /**
   * Incremental object transfer from an upstream repository into a fork
   * (the Sync-Fork primitive): walks `tipSha` ancestry in the source and
   * writes every missing object into the destination. Content-addressed
   * writes make the transfer idempotent and SHA-exact.
   */
  copyObjectsInto(
    srcDiskPath: string,
    destDiskPath: string,
    tipSha: string,
    limits: { maxObjects?: number } = {},
  ): number {
    const upstream = GitRepository.open(this.absolute(srcDiskPath))
    const fork = GitRepository.open(this.absolute(destDiskPath))
    const maxObjects = limits.maxObjects ?? 200_000

    const stack: Array<string> = [tipSha]
    let copied = 0
    while (stack.length > 0) {
      if (copied > maxObjects) throw new Error('Fork sync exceeded the object-transfer limit')
      const sha = stack.pop()!
      // Presence implies ancestry completeness for content-addressed stores:
      // every prior write transferred a full closure, so skip whole subtrees.
      if (fork.hasObject(sha)) continue
      const { type, body } = upstream.readRaw(sha)
      fork.writeObject(type, body)
      copied++
      if (type === 'commit') {
        const parsed = fork.readCommit(sha)
        stack.push(...parsed.parents, parsed.tree)
      } else if (type === 'tree') {
        for (const entry of fork.readTree(sha)) stack.push(entry.sha)
      }
    }
    return copied
  }
}
