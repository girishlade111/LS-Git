import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, existsSync, rmSync, renameSync } from 'node:fs'
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
}
