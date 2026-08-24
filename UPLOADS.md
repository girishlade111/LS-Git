# LSGit — Resumable Upload Infrastructure

Status: **IMPLEMENTED** (headless; independent of the visual upload UI)
Reference: GitLab Workhorse/CI artifact chunked-upload behavior and S3
multipart semantics were consulted; this is LSGit's own implementation.

---

## 1. Scope

`/api/v1/projects/:id/upload_sessions` is the canonical transfer layer for
multi-file repository upload. It is deliberately **UI-independent**: any client
(browser, CLI, script) drives the same protocol. The legacy single-file flow
(`/uploads/initiate|PUT|commit`) and the batch endpoints used by today's
upload dialog remain available during migration; they are superseded, not
removed.

Guarantees:

| Guarantee | Mechanism |
|---|---|
| Resume after interruption | Authoritative per-item chunk maps (`GET …/chunks`) |
| Chunk-level idempotency | Content-addressed replay detection (`duplicate: true`) |
| Finalization idempotency | `committed_sha` unique partial index + replayable result |
| No partial commits | All-or-nothing verification gate before any git mutation |
| No fake success | Structured per-item failure reports on blocked finalization |
| Bounded retries | Per-item attempt caps **and** a hard session TTL |
| Storage exhaustion control | Per-user declared-byte staging quota |
| Cross-user isolation | Every verb scoped to `session.user_id` (admins excepted) |
| Path traversal impossible | Server-side path validation + UUID-addressed storage only |
| Temp bytes never in PostgreSQL | Chunks live in the staging store; DB rows are bookkeeping |

## 2. API surface

| Verb & path | Purpose |
|---|---|
| `POST /projects/:id/upload_sessions` | Create session **with manifest** → items, chunk plan, limits, `expires_at` |
| `GET /projects/:id/upload_sessions/:sid` | Structured state: session + per-item status/failure detail |
| `DELETE /projects/:id/upload_sessions/:sid` | Cancel; staging discarded immediately (idempotent) |
| `PUT /projects/:id/upload_sessions/:sid/items/:itemId/chunks/:index` | Transfer one chunk (`application/octet-stream`, optional `x-chunk-sha256`) |
| `GET /projects/:id/upload_sessions/:sid/items/:itemId/chunks` | Received-chunk map for resume |
| `POST /projects/:id/upload_sessions/:sid/finalize` | Verify → ONE commit → event; idempotent replay answers `200` |

Authz: create/transfer/cancel/finalize require `write_api`; reads require
`read_api`. Repository authorization (`project:push_code`) runs at session
creation; protected-branch rules are enforced at finalize **before** any git
mutation.

### Flow mapping (spec → implementation)

```
create upload session   → POST /upload_sessions            (authorize repo first)
receive manifest        → request body `items[]`
authorize repository    → project:push_code via central authz
create upload items     → validated rows + chunk plans (single transaction)
upload chunks           → PUT chunks/:index (client-side bounded parallelism)
verify                  → finalize step 1: completeness + sizes + whole-file sha256
finalize                → finalize step 2: blobs → tree → ONE commit → ref update
process git objects     → existing gitobjects plumbing (unchanged)
commit                  → ref write inside the same logical operation
emit events             → one durable `repository.files_committed` per session
```

## 3. State machines

```
Session:  open ──finalize(ok)──► committed ──(re-finalize)── same result, HTTP 200
             │─finalize(blocked)─ stays open (structured 409)
             │─cancel──► cancelled          │─TTL expiry──► expired
             │─fatal validation──► failed (reserved)

Item:     pending ─first chunk─► transferring ─last chunk─► transferred
              │                                        │
              │─excluded by operator─► skipped         │─assemble+sha ok─► verified
              │                                        │
              └─attempts exhausted─────► failed (terminal; transfers refused)
```

Notes:
- DB item counters (`received_chunks`, `received_bytes`) are **advisory**.
  The staging store is authoritative; verification always re-reads it.
- A blocked finalize mutates nothing except explicit exclusions
  (`state=skipped`). Exclusions persist across retries.

## 4. Chunk protocol

- Client declares `chunk_size` per session (clamped to
  `[min_chunk_size, max_file_bytes]`). Files smaller than the floor collapse
  to a single whole-file chunk; `chunk_count = max(1, ceil(size/chunk_size))`.
- Boundaries are deterministic: every index carries exactly `chunk_size`
  bytes except the last, which carries `size - (chunk_count-1)·chunk_size`.
  Oversized/undersized chunks are rejected (`422 chunk_size_mismatch`) and
  consume an attempt.
- Optional integrity: send `x-chunk-sha256`; mismatches are rejected before
  staging (`422 chunk_checksum_mismatch`).
- Whole-file integrity: declare `sha256` in the manifest; finalize assembles,
  measures, and structurally reports mismatches (`sha256_mismatch`).
- Resume algorithm (client):

```
1. GET  …/items/:id/chunks        → received_indices
2. PUT  only missing indices      (safe to blind-retry; replays answer duplicate:true)
3. GET  …/upload_sessions/:sid    → reconcile item/session state
4. POST …/finalize                (exclude unrecoverable items if needed)
```

## 5. Error model

Errors follow the house envelope `{ message, code?, …context }`.

| Code | HTTP | Meaning | Retry? |
|---|---|---|---|
| `unauthenticated` | 401 | No/expired credential | n/a |
| `forbidden` | 403 | Not owner of session/repo push | no |
| `not found` | 404 | Session/item unknown or foreign project | no |
| `session_expired` | 410 | TTL passed; lazily terminalized | new session |
| `validation_failed` / `invalid_path` | 400 | Malformed manifest/path/index | fix input |
| `duplicate_in_session` | 409 | Same path twice in manifest | dedupe |
| `too_large` / `too_many_files` | 413 | Manifest/file over configured cap | shrink |
| `storage_quota_exceeded` | 413 | Per-user open-staging quota hit | cancel/finish others |
| `session_closed` | 409 | Terminal session got a transfer/finalize | no |
| `item_closed` | 409 | Failed/skipped item got a transfer | no |
| `chunk_index_out_of_range` | 400 | Index outside `[0, chunk_count)` | fix input |
| `chunk_size_mismatch` | 422 | Boundary violation (attempt charged) | resend exact slice |
| `chunk_checksum_mismatch` | 422 | `x-chunk-sha256` mismatch (attempt) | resend |
| `too_many_attempts` | 409 | Item terminal-failed after cap | exclude/new session |
| `session_incomplete` | 409 | Finalize blocked; `items[]` details | resume then retry |
| `protected_branch` | 403 | Ref locked (`no_one`) | other branch |
| `file_exists` (+`conflict_paths`) | 409 | Replace conflicts on target branch | `replace:true` |
| `branch_missing` | 400 | start_branch does not exist | fix refs |
| `empty_commit` | 400 | Everything identical / nothing included | drop session |

Attempt accounting: any checksum/size violation bumps `attempts`; at
`max_attempts_per_item` (default 20) the item becomes terminally `failed`.
The session TTL independently bounds wall-clock retrying.

## 6. Cleanup job

Two mechanisms, both idempotent:

1. **Opportunistic sweep** — `purgeAbandoned()` runs on every session creation:
   expires past-TTL open sessions, discards their staging directories, and
   removes orphan staging dirs that have no database row (crash leftovers).
2. **Scheduled execution (recommended)** — wire the same call to a timer in
   the worker process:

```ts
setInterval(() => app.uploadSessions.purgeAbandoned(), 15 * 60_000)
```

Operational invariant: staging directories under
`uploadsRoot/resumable/<sessionId>` exist only while a session is `open`;
they are destroyed on commit, cancel, expiry, and sweep. Disk usage ceiling ≈
`Σ declared_bytes(open sessions per user) ≤ max_user_staging_bytes`.

## 7. Storage lifecycle & decision record

Bytes move through exactly three states:

```
chunk files (staging store)  →  assembled buffer (memory, verified)  →  git loose objects
        (temporary)                    (transient)                        (permanent)
```

PostgreSQL stores metadata only — never chunk or file contents.

**Storage modes.** The `UploadStagingStore` interface
(`storage/uploadstaging.ts`) isolates drivers:

- **LocalChunkStore (implemented, default)** — filesystem chunks under
  `<uploadsRoot>/resumable/<sessionId>/<itemId>/chunk-NNNNNN`, atomic
  temp+rename writes. Development and self-hosted deployments.
- **Object-store multipart driver (recommended production mode)** — the chunk
  model maps 1:1 onto S3 multipart: index → `PartNumber`, assemble →
  `CompleteMultipartUpload`, listChunks → `ListParts`. Two deployment shapes:
  1. **Direct browser→object-storage presigned uploads (RECOMMENDED where
     security/architecture permit)**: server issues short-lived signed part
     URLs; bytes bypass the application entirely; the app keeps the
     control plane (this API) unchanged and records part ETags. Requires an
     S3-compatible endpoint, server-side credential custody, tight CORS and
     lifecycle rules, and URLs that carry no sensitive payload names.
  2. App-proxied multipart: identical semantics, bytes relay through the
     backend (works everywhere, costs egress).

  Alternatives considered: (B) full multipart proxy driver behind the same
  interface — chosen migration path from LocalChunkStore; (C) adopting the
  tus.io resumable protocol — rejected for now: redundant given the session
  API already provides checksums/resume/idempotency, adds an external
  extension surface.

Driver swap requires no API or state-machine change: sessions reference the
store only through the five interface operations.

## 8. Security notes

- Authorization matrix: session verbs are bound to `(project_id, user_id)`;
  mismatched project ⇒ 404, foreign user ⇒ 403/401. Instance admins inherit
  access (central authz parity).
- Client paths never touch the filesystem: storage keys are random UUIDs;
  paths exist only as git tree keys after `validateRepoFilePath`.
- Exhaustion: quota check at creation + hard per-file/session caps + TTL
  reclamation + orphan sweeps bound worst-case disk growth.
- Duplicate finalization across processes is prevented by the unique index on
  `committed_sha`, not merely by application checks.

## 9. Test coverage map (`server/test/uploads.resumable.test.ts`)

Creation/manifest authz & validation · chunk boundaries · per-chunk checksums ·
idempotent replays · attempt-cap terminal failure · interrupted-transfer
resume with exact-byte assertion · concurrent cross-item and same-chunk
uploads · finalize idempotency (ref/event/staging invariants) · 500-file
session with 3 failures → structured report → excluded partial ship ·
whole-file sha256 enforcement (all-or-nothing) · protected-branch denial and
same-session rerouting · cross-user isolation on every verb · lazy expiry +
`purgeAbandoned` + orphan cleanup · cancel semantics · staging-reclamation
assertions.
