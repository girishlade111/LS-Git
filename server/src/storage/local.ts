import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildTree,
  commitTree,
  loadFilesUnderTree,
  readObject,
  parseCommit,
  type TreeEntryInput,
} from './gitobjects.js'

/**
 * Repository storage abstraction (STORAGE.md §2–§3).
 *
 * - Hashed disk paths derived from the project's database id:
 *     @hashed/h[0..1]/h[2..3]/<sha256(projectId)>.git
 *   Namespace/project renames and transfers therefore NEVER touch disk.
 * - Deletion is two-step (move to @trash/<uuid>, then purge) mirroring GitLab.
 * - The server hosts this implementation today; the interface is exactly what a
 *   future gRPC git-core service exposes, so extraction is mechanical.
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

  exists(diskPath: string): boolean {
    return existsSync(this.absolute(diskPath))
  }

  createRepository(diskPath: string, defaultBranch: string): void {
    const abs = this.absolute(diskPath)
    mkdirSync(join(abs, 'objects', 'info'), { recursive: true })
    mkdirSync(join(abs, 'objects', 'pack'), { recursive: true })
    mkdirSync(join(abs, 'refs', 'heads'), { recursive: true })
    mkdirSync(join(abs, 'refs', 'tags'), { recursive: true })
    writeFileSync(
      join(abs, 'HEAD'),
      `ref: refs/heads/${defaultBranch}\n`,
      'utf8',
    )
    writeFileSync(
      join(abs, 'config'),
      '[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = true\n',
      'utf8',
    )
  }

  initializeWithFiles(
    diskPath: string,
    defaultBranch: string,
    files: Array<InitialFile>,
    author: { name: string; email: string },
    message: string,
  ): { commitSha: string } {
    this.createRepository(diskPath, defaultBranch)
    const abs = this.absolute(diskPath)
    const objectsDir = join(abs, 'objects')
    const entries: Array<TreeEntryInput> = files.map((f) => ({
      mode: f.mode ?? '100644',
      name: f.path,
      content: Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf8'),
    }))
    const tree = buildTree(entries, objectsDir)
    const commitSha = commitTree(objectsDir, tree.sha, message, author)
    // The branch ref must exist for HEAD to resolve.
    writeFileSync(join(abs, 'refs', 'heads', defaultBranch), `${commitSha}\n`, 'utf8')
    return { commitSha }
  }

  readBranchFiles(diskPath: string, branch: string): Map<string, Buffer> {
    const abs = this.absolute(diskPath)
    const refFile = join(abs, 'refs', 'heads', branch)
    if (!existsSync(refFile)) throw new Error(`branch not found: ${branch}`)
    const headSha = readFileSync(refFile, 'utf8').trim()
    const objectsDir = join(abs, 'objects')
    // readObject strips the "commit <size>\0" header before parsing.
    const { body } = readObject(objectsDir, headSha)
    return loadFilesUnderTree(objectsDir, parseCommit(body).tree)
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
