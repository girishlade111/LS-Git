# LSGit — API

Status: **PARTIALLY IMPLEMENTED** — identity, projects, uploads, protected branches and
the repository code-browser (§3.5) are live in `server/src/http/routes/`; the remainder
of this document stays the planned contract.

Reference behavior: GitLab REST v4 + GraphQL + internal APIs
(https://docs.gitlab.com/api/rest/, https://docs.gitlab.com/api/graphql/).

---

## 1. API surfaces

| Surface | Path | Audience | Notes |
|---|---|---|---|
| Public REST | `/api/v1/*` | users, integrations, CI tools | JSON, versioned |
| GraphQL | `/api/graphql` | UI + power integrations | single endpoint, persisted-query friendly |
| Internal | `/api/internal/*` | git-http, ssh-gateway only | mTLS or shared-secret on private network |
| Runner | `/api/v1/runner/*` | registered runners | token-authenticated pull protocol |
| Webhooks (outbound) | — | external receivers | see EVENTS.md |

## 2. Authentication schemes

| Credential | Used for | Transport |
|---|---|---|
| Session cookie | Browser UI | `SameSite=Lax`, HttpOnly, Secure |
| Personal Access Token (`PRIVATE-TOKEN` header or `Bearer`) | REST/GraphQL scripts & apps | scopes: `read_api`, `write_api`, `read_repository`, `write_repository`, `sudo`(admin) |
| OAuth 2.0 authorization-code + PKCE | third-party web apps | standard flows; refresh tokens rotated |
| SSH key over port 22 | `git` transport | ssh-gateway internal lookup |
| Deploy token | read/write repo or packages for machines | username+token basic auth |
| Deploy key (SSH) | machine repo access | stored as ssh_keys scoped to project |
| CI job token | job→platform calls (packages, artifacts) | short-lived JWT issued per build |
| Runner authentication token | runner↔broker | issued at registration/rotation |

All long-lived secrets are stored hashed (SHA-256 digest); plaintext shown exactly once.
Token revocation is immediate (digest lookup fails). `sudo` scope restricted to admins,
mirroring GitLab's admin-mode behavior.

## 3. REST conventions

- **Versioning:** breaking changes ⇒ new major path (`/api/v2`). Additive changes stay.
- **Pagination:** cursor/keyset pagination default
  (`?pagination=keyset&per_page=20&order_by=updated_at`), with
  `X-Total-Count` and `Link` headers. Offset pagination allowed only on small sets.
- **Errors:** uniform envelope `{"message": "..."}` with precise HTTP codes;
  422 for validation failures with field details:
  `{"message":{"path":["has already been taken"]}}` (GitLab-compatible shape).
- **Idempotency:** unsafe POSTs accept `Idempotency-Key` header; deduplicated server-side.
- **Rate limiting:** bucketed (anonymous/authenticated/token-scope) with
  `RateLimit-*` headers; limits configurable instance-wide (SECURITY.md §6).
- **Resource addressing:** by URL-encoded full path `group%2Fproject` OR numeric id,
  GitLab-style. User-facing identifiers are paths + `iid`; numeric ids are API-stable
  but never surfaced in UI URLs.

### Endpoint catalog (Phase mapping)

Phase 1 — core:
```
Users        GET /users · GET/PATCH /user · /users/:id/projects · keys CRUD
Namespaces   CRUD groups/subgroups · members · group projects · transfer
Projects     CRUD /projects · visibility · archive/unarchive · transfer · forks
             stars PUT/DELETE :id/star · watchers · upload avatar/file
Repositories GET tree/blob/raw/blame · compare · contributors
             archive (:format zip/tar.gz/tar.bz2/tbz/tar)
Branches     list/get/create/delete · protected branches CRUD
Tags         list/get/create/delete · protected tags CRUD
Commits      list/get · diff · refs · cherry-pick/revert (POST, async job)
Files        get/create/update/delete (base64 content) — powers web editing & upload
Snippets     personal + project snippets CRUD (raw endpoints included)
Keys         deploy keys CRUD + enable/disable per project
```

Phase 2 — collaboration:
```
Issues       CRUD + notes · labels · milestones · subscribe/mute · time tracking
             move (cross-project) · related issues · confidential rules enforced
MergeReqs    create/update/list · diffs · commits · participants
             merge (async, guarded) · close/reopen · approve/unapprove
             rebase (async job) · squash-on-merge · discussions/resolve
Notes        polymorphic comments incl. commit & snippet notes
Webhooks     project hooks CRUD + test-delivery endpoint
Releases     CRUD bound to existing tag + asset links
```

Phase 3 — CI/CD:
```
Pipelines    list/get/create (ref/sha) · cancel/retry · jobs · test report summary
Runners      admin/group/project runners CRUD · verify · jobs endpoints (runner API)
Variables    project/group CI variables CRUD (masked/protected flags)
Schedules    pipeline schedules CRUD + take-ownership
Environments deployments CRUD-ish read + stop
Artifacts    download by ref+job+artifact-path · keep/delete · expiry policy
```

Phase 4–5 — ecosystem (endpoints defined when phase starts):
Packages registries (npm/maven/pypi/generic first), Pages settings,
security scanning reports ingestion, gists, AI assist endpoints.

### 3.5 Repository code browser (IMPLEMENTED)

LSGit's own stable URL scheme (not GitLab's `/-/blob/...` shape). `:ref` accepts
branch names, tag names and full SHAs — a SHA in the ref position IS the permalink
form. Line permalinks append `#L<n>` on the UI blob page. All reads authorize via
the central authz service before touching disk.

```
GET /api/v1/projects/:id/repository/refs                       branches+tags (selectors)
GET /api/v1/projects/:id/repository/tree/:ref(?path=&page=&per_page=)
GET /api/v1/projects/:id/repository/blob/:ref/*                metadata + inline text (≤512 KB)
GET /api/v1/projects/:id/repository/raw/:ref/*                 raw bytes (≤100 MB, nosniff+CSP)
GET /api/v1/projects/:id/repository/download/:ref(/dir)        tar.gz of ref or subdirectory
GET /api/v1/projects/:id/repository/commits/:ref(?path=&page=) path-scoped history keeps deletions
GET /api/v1/projects/:id/repository/commit/:sha                detail + changed-file kinds + stats
GET /api/v1/projects/:id/repository/blame/:ref/*               line→commit ranges (LCS foundation)
GET /api/v1/projects/:id/repository/search/:ref(?q=&content=)  filename search; opt-in bounded grep

POST /api/v1/projects/:id/repository/commit                    web-editor commit (create/edit/
                                                               delete/rename/multi-file in ONE
                                                               atomic commit). Body: {changes:[{path,
                                                               content|content_base64|sha, mode?,
                                                               delete?}], commit_message, branch |
                                                               new_branch+start_branch,
                                                               expected_base_tip?, reject_overwrite?}.
                                                               Optimistic concurrency: expected_base_tip
                                                               (GitLab last_commit_id parity) is checked
                                                               against the branch tip BEFORE the write and
                                                               the engine's CAS ref update remains the
                                                               backstop; mismatches return
                                                               409 ref_update_conflict {expected, current}.
                                                               Success returns 201 with commit_sha, branch,
                                                               created_branch, replaced_paths, deleted_paths
                                                               and an MR-ready hint for the future PR phase.
```

Web editor client (`web/src/repository/editor/`): CodeMirror 6 surface themed via design
tokens only; local drafts in localStorage with restore/discard; multi-file session that
commits all dirty buffers as one change set.

### 3.6 Branches, tags & commit history (IMPLEMENTED)

Branch names containing slashes are addressed by percent-encoding each segment.
All mutations authorize through the central service before touching refs; every ref
write is lockfile-atomic with CAS expectations (concurrent-safe).

```
GET    /api/v1/projects/:id/repository/branches(?search=&sort=name|recent&limit=)
       enriched rows (tip commit title/author/time); sort=recent orders by commit time
POST   /api/v1/projects/:id/repository/branches            {name, start_point?} → 201
DELETE /api/v1/projects/:id/repository/branches/<name>(?expected_old=)
                                                           protected + default branches refuse
POST   /api/v1/projects/:id/repository/branches/rename     {name, new_name}
PUT    /api/v1/projects/:id/repository/default_branch      {name} — HEAD + metadata tx,
                                                           auto-protects the new default
GET    /api/v1/projects/:id/repository/compare?from=&to=&with_patches=
                                                           merge-base · ahead/behind commits ·
                                                           changed files (+ unified patches)
GET    /api/v1/projects/:id/repository/tags
POST   /api/v1/projects/:id/repository/tags                {name, ref, message?} — annotated
                                                           when message present; tag a commit by
                                                           passing its SHA as ref
DELETE /api/v1/projects/:id/repository/tags/<name>
GET    /api/v1/projects/:id/repository/commit/:sha/diff    per-file unified diffs vs first parent
GET/PUT/DELETE /api/v1/projects/:id/repository/protected_branches[/*]
                                                           rules managed via the authz-gated service
```

Behavioral notes: rename = create-only CAS claim of the target name followed by a
CAS delete of the source, with compensating rollback (protected and default branches
are never renamed); stale deletes/rename races fail with `ref_conflict` instead of
losing work; branch/tag history is read straight from real git objects — PostgreSQL
stores only protection rules and the default-branch pointer. UI surfaces dense token-
styled tables (`web/src/repository/branches.tsx`) with keyboard-accessible actions,
parent-commit links and browse-at-commit navigation.

Behavioral notes: directories list dirs-first with pagination (`per_page` ≤ 200);
binary files are sniffed (NUL byte / invalid UTF-8) and never inlined; large files
return `too_large` flags so the UI offers raw/download; deleted paths keep their
history with a terminal `deleted` event. The web client lives in
`web/src/repository/` and renders through design tokens only.

## 4. GraphQL principles

- Schema-first, generated SDL committed to repo; deprecation via `@deprecated`.
- Global object IDs base64 `gid://lsgit/<Type>/<id>` (GitLab-compatible convention).
- Connections follow Relay-style pagination; mutations return `<Action>Payload`
  types with top-level `errors` array — clients handle partial failure uniformly.
- Query depth + complexity limits; no N+1 without DataLoader-style batching
  (CI check runs example query set against test fixtures).
- Everything exposed in REST eventually appears in GraphQL; UI consumes GraphQL
  preferentially so the schema stays honest.

## 5. Internal API (git-http / ssh-gateway only)

Network-isolated; authenticated via mTLS client cert or HMAC-signed requests.

```
GET  /internal/authorized_keys?key=<fingerprint-or-key>
     → { id, user_id, ... }            # fast SSH key lookup (Redis-cached)
POST /internal/allowed                # THE authz gate for every git op
     { action: upload_pack|receive_pack, project_path|gl_repository,
       actor_type: user|deploy_key|deploy_token|ci_job, actor_id, protocol }
     → 200 { ok:true, gitaly:{...streaming target...}, gl_id, ... }
     → 403 { ok:false, message }      # e.g. protected branch push denial
POST /internal/post_receive           # called after receive-pack completes
     { changes:[{ref, old, new}], gl_id, project } → 202 (events emitted async)
GET  /internal/check                  # liveness for gateways
```

Behavioral contracts adopted from GitLab: `receive-pack` permission is computed
**before** any bytes stream (client gets clean 403, not a post-hoc hook rejection);
post-receive side effects are always asynchronous.

## 6. Runner API (pull protocol)

```
POST /api/v1/runner/register        # registration token → runner token (hashed)
POST /api/v1/runner/verify          # validate auth token
POST /api/v1/jobs/request           # claim next pending job for this runner
                                    # params: tags, system info; returns job payload
PUT  /api/v1/jobs/:id               # update state (running/success/failed/canceled)
PATCH /api/v1/jobs/:id/trace        # append log chunk w/ offset validation
POST /api/v1/jobs/:id/artifacts     # multipart or pre-signed direct upload
GET  /api/v1/jobs/:id/artifact/*    # download dependency artifacts
```

Contracts: a claimed job is leased with heartbeat timeout (stale → retry);
trace PATCH validates byte offset (conflict → resend from last acked offset);
artifacts expire per `expire_at`; protected-ref variables are only delivered to
runners whose `access_level=ref_protected`.

## 7. Compatibility stance

LSGit does **not** promise GitHub-API compatibility. It follows GitLab semantics where
the reference defines them (payload shapes, state names, iid behavior) because that is
our stated behavioral reference; deviations are documented in API changelog.
