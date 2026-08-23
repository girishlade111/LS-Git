# LSGit — Storage

Status: **PROPOSED (greenfield)** — §2–§4 repository layout is now **implemented** in
`server/src/storage/` (pure-Node Git object writer `gitobjects.ts` + hashed-layout
`LocalHashedStorage`; deletion moves repos to `@trash/<uuid>` before purge).
Reference: GitLab repository/object-storage architecture
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
