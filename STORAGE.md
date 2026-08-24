# LSGit — Storage

Status: **IMPLEMENTED** — §2–§4 repository layout and the full §3 lifecycle run on the
core Git engine (`server/src/storage/repository.ts` + `LocalHashedStorage`); see §10
for the implemented Git storage lifecycle. Reference: GitLab repository/object-storage
architecture
(https://docs.gitlab.com/administration/repository_storage_paths/,
https://docs.gitlab.com/development/file_storage/).

---

## 1. Storage taxonomy

| Kind | Backing store | Owner service | Examples |
|---|---|---|---|
| Git repositories | Local disk (sharded) | **git-core only** | project `.git`, `.wiki.git`, design repo |
| Blobs | S3-compatible object storage | lsgit-web/workers | LFS, uploads/avatars, CI artifacts, package files, Pages archives, MR external diffs |
| Ephemeral caches | Local disk, disposable | producing service | archive cache, import scratch space |
| Metadata | PostgreSQL | lsgit-web | everything addressable in API |
| Queues/counters | Redis | all services | jobs, rate-limit buckets, sessions |

Rule inherited from GitLab: **no component except git-core may open a repository file**
directly; no component may treat local disk as durable for blobs.

## 2. Repository layout — hashed storage (mandatory from day one)

Path derives from SHA-256 of the project's database id:

```
<shard-root>/@hashed/h[0..1]/h[2..3]/<hash>.git          # main repo
<shard-root>/@hashed/h[0..1]/h[2..3]/<hash>.wiki.git     # project wiki repo
```

- Example: project id 1 → sha256("1") =
  `6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b` →
  `@hashed/6b/86/6b86...b4b.git`
- `projects.disk_path` stores the relative path; `repository_storage` names the shard.
- Namespace/project renames and transfers therefore **never touch disk** — this is why
  legacy (path-derived) storage is rejected outright.
- Fork object pools later live under `@pools/...` using identical hashing
  (GitLab parity; see §5).
- Group wikis use `@groups/h[0..1]/h[2..3]/<sha256(group-id)>.wiki.git`.

### Shards ("storage shards")

Config lists named shard roots, e.g. `default → /var/lib/lsgit/git-data`. New projects
are assigned by weighted round-robin or explicit admin choice; `rake storage:move`
style migration = DB row update + git-core `move` RPC + verify job. Shard health
(free space) is exported as metrics; full shards refuse new repos but not pushes.

## 3. Repository lifecycle operations (git-core RPCs)

```
create(disk_path, default_branch, template?)     # bare init + hooks dir + config
delete(disk_path)                                # rename to @trash/<uuid> then rm -rf (delayed purge)
move(from_shard, to_shard, disk_path)            # atomic-ish copy+rename+swap
info_refs(service, disk_path)                    # advertisement stream
upload_pack / receive_pack(disk_path, io)        # bidirectional pack streaming
housekeeping(disk_path)                          # gc --auto schedule, repack, bitmaps
pool_join(disk_path, pool_disk_path)             # objects/info/alternates link (Phase 3)
fsck(disk_path)                                  # integrity job, results → DB
```

Every write operation emits an event (EVENTS.md); housekeeping runs as scheduled
worker per repo with jitter (GitLab's "aggressive housekeeping after push" behavior).

## 4. Object storage layout (S3-compatible; MinIO in dev)

Bucket-per-purpose (GitLab convention):

| Bucket | Contents | Addressing | Lifecycle |
|---|---|---|---|
| `lsgit-lfs` | LFS objects | `lfs/objects/<oid[0:2]>/<oid[2:4]>/<oid>` (oid = sha256) | GC'd when unreferenced > grace period |
| `lsgit-uploads` | issue/MR markdown attachments, avatars | `uploads/<random-hash>/<filename>` | deleted with owner row |
| `lsgit-artifacts` | CI artifacts + metadata zips | `artifacts/<project_id>/<job_id>/<file_type>` | `expire_at` cleanup worker |
| `lsgit-packages` | npm/maven/pypi/generic package files | per-ecosystem layout | deletion via cleanup policies |
| `lsgit-pages` | built static sites | `pages/<project_id>/public/` | rebuilt per deploy |
| `lsgit-mr-diffs` | externalized large MR diffs | `merge_request_diffs/mr-<parent>/diff-<id>` | with MR |
| `lsgit-backups` | pg dumps, repo tarballs | dated prefixes | retention policy |

Client flow: **direct upload via pre-signed PUT** for anything user-supplied >1 MiB
(drag-and-drop UX requirement) — the app issues presigned URL + records row only after
client confirms; small inline uploads proxy through app. Downloads use pre-signed GETs
or streaming proxy depending on ACL needs.

Upload safety (see SECURITY.md): extension allowlist per context, MIME sniffing,
size caps, filename sanitization, images re-encoded/sanitized, SVG served with
`Content-Type: text/plain` unless trusted context (stored-XSS vector).

## 5. Fork deduplication (Phase 3)

GitLab object pools: source repo's objects moved into `@pools/<hash>.git`;
source + forks point via `objects/info/alternates`. Rules adopted:

- Pools created lazily on fork of public/internal projects only.
- Never run destructive gc inside pools; pool housekeeping is its own job type.
- Unlinking a fork copies missing objects back before detach (correctness over speed).
- Deletion of last member destroys the pool.

## 6. Caches (disposable, rebuildable)

| Cache | Location | Invalidation |
|---|---|---|
| Archive cache (zip/tar.gz of refs) | local `shared/cache/archive` | TTL + LRU worker sweep (GitLab parity) |
| Rendered markdown fragments | Redis/app cache | event-driven bust on note/issue change |
| Repo stats (languages, size) | PG columns refreshed by worker | post-receive event |
| Branch/tag listing hot responses | Redis short-TTL | invalidated by push event per repo |

## 7. Import/export

- Project export = manifest JSON + repo bundle + referenced blob downloads, streamed to
  `lsgit-uploads` then offered as download; import reverses it (both async workers).
- Git-based imports (GitHub/GitLab/Bitbucket/URL mirror) run in worker with progress rows
  resumable; credentials encrypted at rest, wiped after completion.

## 8. Backup & restore posture

1. Nightly `pg_dump --format=custom` → `lsgit-backups` (+ WAL archiving when self-host docs mature).
2. Repository snapshots: per-shard incremental bundling (git bundle of new packs) or
   filesystem snapshots; restore = restore bundle into fresh bare repo + verify fsck.
3. Object buckets synced cross-region where provider allows.
4. Quarterly documented restore drill is an acceptance criterion for Phase 3 exit.

## 9. Capacity notes

- Repositories grow unbounded ⇒ disk watermark alerts at 80/90%; auto-pause new repos
  on a shard at 95%.
- Artifact/package growth is bounded by expiry/cleanup policies (defaults documented in
  ROADMAP Phase 3 acceptance criteria).

## 10. Git storage lifecycle (implemented)

LSGit repositories are **real Git repositories** — standard loose objects, tree/commit/
tag object formats and ref files exactly as `git init --bare` produces. They are
clonable and pass `git fsck --strict`. There is no JSON emulation anywhere and no Git
blob content is ever stored in PostgreSQL; the database holds metadata rows only
(projects, protected-branch rules, events, audit). The engine never spawns subprocesses
and never lets user-controlled strings reach the filesystem unvalidated — every ref
name passes a git-check-ref-format subset validator first.

### 10.1 Component map

| Layer | File | Responsibility |
|---|---|---|
| Core engine (`GitRepository`) | `server/src/storage/repository.ts` | Bare init, blob/tree/commit/tag objects, ref read/write/delete with locking + CAS, HEAD, history walks, packed-refs reads |
| Hashed layout | `server/src/storage/local.ts` | `@hashed/ab/cd/<sha256(projectId)>.git` path derivation, trash-step deletion |
| Repository service | `server/src/services/repositories.ts` | Authorization gates, protected branches, audit + event emission, rev resolution, commit orchestration |

### 10.2 Lifecycle stages

```
 create ─► empty ─► initial commit ─► active (pushes) ─► archived/deleted
                      │                    │
                      ▼                    ▼
              refs/heads/<default>    more commits, branches, tags
```

1. **Create** — project row commits → engine writes the bare skeleton:
   `HEAD` (symbolic to the default branch), `config` (`bare = true`),
   `objects/info`, `objects/pack`, `refs/heads`, `refs/tags`, `description`.
   The repo is **empty** (zero refs) until its first commit.
2. **Initial commit** — `applyChangesToBranch` on an empty repository produces a
   parentless commit and creates the default-branch ref with create-only CAS.
3. **Active** — every web-originated write (upload finalize, browser edit, branch
   commit, tag creation) flows through one atomic pipeline: base tip → merged tree →
   commit → CAS ref update (§10.4).
4. **Delete** — hashed directory moves to `<root>/@trash/<uuid>` then is purged;
   compensating metadata cleanup keeps DB and disk consistent.

### 10.3 Object model

| Kind | Format | Written by |
|---|---|---|
| Blob | `blob <size>\0<bytes>`, zlib-deflated under `objects/xx/yyyy…` | upload/edit flows via `writeBlob` |
| Tree | binary entries `<mode> <name>\0<20-byte sha>`, git sort order (dirs sort as `name/`) | `writeTreeFromFiles` / `writeTreeFromShas` |
| Commit | `tree`, zero+ `parent`, `author`/`committer` idents with unix time + tz offset, message | `writeCommit` |
| Tag | annotated: `object`/`type`/`tag`/`tagger` headers + message; lightweight: plain ref to target | `createTag` |

Object writes are write-temp-then-rename, so a crash can never leave a truncated
object that another reader mistakes for complete.

### 10.4 Ref updates: atomicity, race prevention, optimistic concurrency

Every ref mutation follows git's own discipline:

1. Acquire `<ref>.lock` with `O_CREAT|O_EXCL`. Two concurrent writers cannot both
   hold it; the loser fails fast with `ref_locked` (HTTP 409).
2. Read the current value **while holding the lock** and compare against the caller's
   expectation (CAS):
   - `expectedOld === undefined` → unconditional overwrite (force-push analog),
   - `expectedOld === null` → ref must not exist (create-only: new branches, tags),
   - `expectedOld === '<sha>'` → must still equal the observed tip.
   A mismatch raises `RefConflictError` → HTTP 409 `ref_update_conflict`; clients
   reload and rebase their change instead of silently losing updates.
3. Stage the new value inside the lock file and install it with a single rename —
   readers never observe torn ref files.
4. Locks older than 60 s are treated as abandoned by crashed processes and broken.

Because the tip is captured *before* tree construction and doubles as the CAS
expectation, the window between "read" and "write" cannot lose a concurrent commit.

### 10.5 Reads

Refs resolve loose-first with `packed-refs` fallback (loose shadows packed), so
imported/packed repositories keep working. Revision resolution accepts branch names,
tag names, full SHAs and unique ≥7-char SHA prefixes (bounded loose-object scan).
History walks follow parent links newest-first with optional first-parent
linearization and depth caps.

### 10.6 Security & auditability

Order of operations for every write: resolve project → central authorization
(`can(actor, 'project:push_code')`: owner or instance admin today) → protected-branch
rule check (`protected_branches.push_allowed`) → **then** any disk effect → durable
event + audit row. Denials are audited (`repo_write_denied`) with the reason and
branch. Protected branches are never deletable; the default branch cannot be deleted.
Event catalog: `repo.push` (commits/branch ops) and `repo.tag_push` per EVENTS.md §2;
audit names: `repo_commit_created`, `repo_branch_created/deleted`,
`repo_tag_created/deleted`, `repo_ref_updated`, `repo_write_denied`.

### 10.7 Housekeeping (future phases)

Unchanged from §3: `housekeeping` (gc/repack/bitmaps), fsck verification jobs,
object pools for forks, archive caches — all worker-scheduled, never inline with
request handling.
