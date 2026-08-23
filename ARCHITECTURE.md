# LSGit — Architecture

Status: **PROPOSED (greenfield)** — no code exists in this repository yet.
Reference: GitLab Community Edition / FOSS behavior and architecture
(https://docs.gitlab.com/development/architecture/). LSGit does **not** copy GitLab UI or source;
it adopts proven workflows, data relationships, and edge-case handling.

---

## 1. Architecture assessment (current state)

Inventory of the repository as of 2026-08-23:

| # | Area | Finding |
|---|------|---------|
| 1 | Framework | **None.** Empty repo, `main` branch, zero commits. |
| 2 | Frontend architecture | None. |
| 3 | Backend architecture | None. |
| 4 | Database | None. |
| 5 | Authentication | None. |
| 6 | Authorization | None. |
| 7 | Git storage | None. |
| 8 | Object storage | None. |
| 9 | Queue / background jobs | None. |
| 10 | Existing API | None. |
| 11 | Existing UI system | None. |
| 12 | Existing tests | None. |
| 13 | Deployment configuration | None (only `.git`). |

Conclusion: every architectural choice below is a *recommendation to be confirmed*,
not a description of existing code. The single blocking decision is the application
stack (see "Unresolved decisions" at the bottom of this file).

## 2. What we take from the GitLab reference

GitLab's architecture proves out these separations, which LSGit adopts conceptually:

1. **Metadata plane vs. data plane.** Application metadata lives in PostgreSQL; raw
   Git objects live in bare repositories on disk owned by a dedicated service
   (Gitaly analog). The web app never reads `.git` directories directly.
2. **AuthZ before transport.** Every Git HTTP/SSH request first resolves
   authentication + authorization against the internal API (Rails `/api/internal`
   analog), then the packfile stream is proxied without buffering through the app server
   (Workhorse analog).
3. **Background jobs as first-class citizens.** Webhook delivery, CI pipeline creation,
   fork deduplication, archive generation, search indexing, emails — all asynchronous,
   idempotent workers (Sidekiq analog), queued via Redis.
4. **Hashed storage from day one** (`@hashed/ab/cd/<sha256>.git`) so renames/transfers
   of namespaces never move files on disk (see STORAGE.md).
5. **Denormalized authorization cache** (`project_authorizations`-style table) so listing
   accessible projects never requires recursive group traversal per request (see PERMISSIONS.md).
6. **Per-project sequence numbers** (`iid` on issues/MRs) so URLs stay stable and short
   even with global ID churn.
7. **Event fan-out through one bus**: domain events → workers → {webhooks, activity feed,
   notifications, search index, CI triggers} (see EVENTS.md).
8. **Runners are pull-based.** Runners poll for jobs over an authenticated runner API;
   the platform never pushes into customer networks.

## 3. Proposed LSGit component model

```
                       ┌────────────── Clients ──────────────┐
                       │  Browser        git client    Runner │
                       └────┬──────────────┬────────────┬────┘
                            │ HTTPS        │ HTTPS      │ HTTPS
                    ┌───────▼──────────────▼────────────▼───────┐
                    │              Edge / Reverse Proxy          │
                    │        (TLS, routing, static assets)       │
                    └───┬──────────────┬─────────────┬───────────┘
                        │ app routes   │ /ns/proj.git│ SSH (port 22)
                 ┌──────▼─────┐  ┌─────▼──────┐  ┌───▼──────────┐
                 │  lsgit-web │  │ git-http   │  │ ssh-gateway  │
                 │ (UI+API,   │  │ (smart HTTP│  │ (key lookup +│
                 │  monolith) │  │  proxy to  │  │  authz via   │
                 │            │  │  git-core) │  │  internal API│
                 └──┬───┬─────┘  └─────┬──────┘  └───┬──────────┘
                    │   │              │ gRPC/HTTP    │
                    │   │         ┌────▼──────────────▼───┐
                    │   │         │       git-core        │
                    │   │         │ owns all bare repos,  │
                    │   │         │ runs git plumbing     │
                    │   │         └────────┬──────────────┘
             ┌──────▼─┐ │                  │
             │ Redis  │◄┼── enqueue        │ filesystem
             └──────▼─┘ │                  ▼
             ┌──────────▼──┐     ┌────────────────────┐
             │ PostgreSQL  │     │ repositories disk  │
             └─────────────┘     │ @hashed/.../*.git  │
                                 └────────────────────┘
             ┌──────────────┐    ┌───────────────────────────────┐
             │  lsgit-worker│───►│ S3-compatible object storage  │
             │ (job runners)│    │ LFS · artifacts · uploads ·   │
             └──────────────┘    │ packages · pages · backups    │
                                 └───────────────────────────────┘
```

### Components

| Component | Responsibility | GitLab analog |
|-----------|----------------|---------------|
| **lsgit-web** | Monolith: REST API, GraphQL, server-rendered/SPA UI, sessions, OAuth, internal API for gateways, admin area. Owns ALL database access. | Puma/Rails |
| **git-core** | Dedicated service owning bare repositories on local disk. Exposes a narrow internal API (create/delete/move repo, info-refs, upload-pack/receive-pack streaming, tree/blob reads, branch/tag ops). Runs `git` plumbing as subprocesses (never parses objects itself). | Gitaly |
| **git-http** | Thin smart-HTTP transport: authenticates via lsgit-web internal API, then streams `info/refs`, `upload-pack`, `receive-pack` bidirectionally between client and git-core. Must not buffer large packs in memory. | Workhorse + Gitaly SmartHTTP |
| **ssh-gateway** | Terminates SSH as the single system `git` user; resolves key→user via internal API; enforces command allowlist (`git-upload-pack`, `git-receive-pack`); streams to git-core. | gitlab-shell + sshd |
| **lsgit-worker** | Background job processors (queues: webhook_delivery, pipeline_create, housekeeping, archive_cache, emails, indexing, cleanup). Idempotent handlers, exponential backoff, dead-letter queue. | Sidekiq |
| **runner-broker** | (Inside lsgit-web initially.) Runner registration/auth, job claiming, trace/log append, artifact upload coordination. Pull-based protocol. | /api/v4/runners subset |
| **PostgreSQL** | Single authoritative metadata store. | same |
| **Redis** | Job queue backend, cache, rate-limit counters, session store option. Never authoritative data. | same |
| **Object storage** | S3-compatible bucket-per-purpose layout (see STORAGE.md). Local disk fallback driver for dev. | MinIO/S3/GCS |

### Explicitly deferred components

These exist in GitLab but are **out of scope until their roadmap phase**
(see ROADMAP.md): Praefect-style replication, Geo, Pages daemon (Phase 4),
Container Registry integration (Phase 4), KAS agent, advanced-search engine
(replaceable adapter interface defined in Phase 5).

## 4. Request cycles (behavioral contracts)

### 4.1 Web/API request
Edge → lsgit-web → (PostgreSQL | Redis | git-core) → response.
Long-running work (e.g., fork creation, import) returns `202 Accepted` + status URL;
actual work happens in lsgit-worker.

### 4.2 Git fetch over HTTP
1. `GET /{namespace}/{project}.git/info/refs?service=git-upload-pack`
2. git-http asks lsgit-web internal API: authenticate token/session → authorize
   `read_repository` (visibility + role + protected-ref rules do NOT apply to fetch).
3. On approval git-http streams the ref advertisement from git-core straight to the client.
4. `POST .../git-upload-pack`: re-authenticated identically; bytes stream end-to-end.

### 4.3 Git push over HTTP
Same flow with `receive-pack`; before streaming starts, lsgit-web computes:
- push permission on target refs (protected branch/tag rules),
- push size limit, LFS pointer policy, push rules hooks.
git-core then runs receive-pack; **post-receive processing is evented**, never inline:
the push transaction commits, emits `repo.push` events, and workers handle
pipeline creation, MR updates ("merge when pipeline succeeds", closing patterns),
mirror sync, webhooks.

### 4.4 Git over SSH
ssh-gateway → internal API `authorized_keys` lookup (fast path, cached in Redis)
→ internal API `allowed` check → stream to git-core. Same post-receive path as HTTP.

### 4.5 CI job lifecycle
push/MR/schedule/manual trigger → worker creates pipeline + jobs (DAG by stages/needs)
→ runner polls `POST /jobs/request` with its authentication token → claims job →
streams trace → uploads artifacts to object storage via pre-signed URL → reports
state transitions → worker finalizes pipeline, emits events.

## 5. Architectural conflicts & technical-debt register (greenfield)

Because there is no code, "debt" here means *decisions that create debt if made wrong now*:

| Risk if wrong | Mitigation baked into this design |
|---|---|
| Storing repos under human-readable paths (namespace/project.git) | Hashed storage mandatory from commit #1; rename = DB row update only. |
| App server reading/writing `.git` directly | All Git I/O behind git-core's internal API from Phase 1; UI code physically cannot touch disk paths. |
| Inline webhook/pipeline work inside request cycle | Events + workers from Phase 1; request handlers may only emit events. |
| Missing per-project `iid` | Sequencing strategy decided in DATABASE.md before first issue exists; retrofitting iid is one of the most painful migrations in GitLab history. |
| Authorization computed ad-hoc per feature | One permission evaluator + denormalized authorization table; features must call it, enforced in code review + tests. |
| Buffering packfiles in app memory | git-http/git-core stream with fixed-size buffers; load test contract documented. |
| Global IDs exposed as URL keys everywhere | Public identifiers use full paths (`group/project`) and `iid`; numeric IDs remain API-stable but not user-facing. |
| Feature visibility bolted on later | `project_features` gating designed into project schema day one (PERMISSIONS.md §6). |

## 6. Technology recommendation (pending confirmation)

Recommended shape regardless of stack choice: **modular monolith first, services where
I/O characteristics demand them** (git-core and ssh-gateway are separate processes from
day one because their failure modes, scaling, and security boundaries differ fundamentally
from the web app — this mirrors GitLab's own split).

Candidate stacks are compared in ROADMAP.md §7; the decision is requested at the end of
this document set.

## 7. Non-goals

- No multi-instance/cells topology.
- No EE-style licensing/tiers; single open edition like GitLab CE/FOSS.
- No Kubernetes-operator-level orchestration in Phases 0–2 (docker-compose dev, simple deploy later).

## 8. Document map

| Document | Covers |
|----------|--------|
| ARCHITECTURE.md | This file — components, request cycles, debt register |
| DATABASE.md | Schema, sequences, partitioning, migration discipline |
| API.md | REST v1, GraphQL, internal API, runner API |
| STORAGE.md | Repo layout, object storage buckets, caches, backups |
| SECURITY.md | AuthN/AuthZ surfaces, tokens, threat mitigations |
| EVENTS.md | Internal events, webhooks, delivery guarantees |
| PERMISSIONS.md | Roles, visibility, protected refs, sharing |
| ROADMAP.md | Phased delivery plan, acceptance criteria, risks |
