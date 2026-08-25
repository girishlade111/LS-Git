# LSGit — API

Status: **PARTIALLY IMPLEMENTED** — identity, projects, uploads, protected branches, the
repository code-browser (§3.5–3.7), the issues/labels/milestones collaboration surface
(§3.8) and configurable issue forms (§3.9) are live in `server/src/http/routes/`; the
remainder of this document stays the planned contract.

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

### 3.7 Fork system (IMPLEMENTED)

Forks are real repository clones at the storage layer: the entire object database plus
refs are copied verbatim, so commit SHAs (history/branches/tags) are identical to the
source. PostgreSQL stores only two columns on `projects` — `forked_from_project_id`
(direct upstream) and `fork_network_id` (network root's project id) — both indexed, so
the whole network loads in ONE query and the tree is assembled in memory.

```
POST /api/v1/projects/:id/fork               {path?, name?, visibility?, namespace?}
                                             → 201 {project{...full_path}, source}
                                             409 path_taken · 400 visibility_exceeds_source ·
                                             422 namespace_unsupported (orgs → groups phase)
GET  /api/v1/projects/:id/fork/divergence(?branch=)
                                             → state up_to_date|ahead|behind|diverged +
                                               behind_count/ahead_count + tips
POST /api/v1/projects/:id/fork/sync          fast-forward ONLY; transfers missing objects
                                             upstream→fork then CAS ref update;
                                             diverged → 409 fork_diverged (never overwrites)
POST /api/v1/projects/:id/fork/detach        {confirm_path} — owner/admin + typed full-path
                                             confirmation; clears both relationship columns
GET  /api/v1/projects/:id/fork/network       root + members + direct_forks/descendant counts
```

Policy: fork visibility can never exceed source visibility at creation; protection
rules are not inherited — forks define their own posture; sync targets the same-named
branch upstream (no silent fallback); detached forks leave the network entirely.
UI (`web/src/repository/forks.tsx`): Fork button with capped visibility selector,
"Forked from" reference + divergence badge + Sync control, strong-confirmed detach,
and a dense indented network table under `#/proj/<owner>/<project>/network`.

Behavioral notes: directories list dirs-first with pagination (`per_page` ≤ 200);
binary files are sniffed (NUL byte / invalid UTF-8) and never inlined; large files
return `too_large` flags so the UI offers raw/download; deleted paths keep their
history with a terminal `deleted` event. The web client lives in
`web/src/repository/` and renders through design tokens only.

### 3.8 Issues, labels & milestones (IMPLEMENTED)

GitLab REST v4 semantics on LSGit URLs. Issues are addressed by per-project `iid`
(DATABASE.md §2 `internal_ids` sequencing). Confidential issues follow
PERMISSIONS.md §6 (visible to author/assignees/reporter+; hidden from everyone else,
including listings and single reads → 404).

```
GET    /api/v1/projects/:id/issues        state= · labels=a,b · milestone=<title|id|none|any> ·
                                          assignee_username=(user|none) · author_username= · search=
                                          order_by=(updated_at|created_at) · sort=(asc|desc)
                                          page/per_page — X-Total-Count/X-Total-Pages headers +
                                          {pagination:{page,per_page,total,total_pages,has_more}}
POST   /api/v1/projects/:id/issues        {title, description?, confidential?, assignee_ids?,
                                          labels?: [title…], milestone_id?} → 201
GET    /api/v1/projects/:id/issues/:iid
PATCH  /api/v1/projects/:id/issues/:iid   partial update incl. state_event: close|reopen;
                                          every state/metadata change appends a SYSTEM note
POST   .../issues/:iid/close | /reopen    explicit state transitions
DELETE /api/v1/projects/:id/issues/:iid   owner/admin only

GET/POST  .../issues/:iid/notes           timeline = human comments + system notes (chronological);
                                          POST body {body} — @mentions fan out through EVENTS.md bus
PATCH/DELETE .../notes/:note_id          author or owner/admin only; system notes immutable
POST      .../issues/:iid/tasks/toggle    {index} flips the nth `- [ ]`/`- [x]` checkbox IN the
                                          persisted description (GitLab storage contract); returns
                                          fresh task_progress {total, completed}
GET/POST  .../issues/:iid/award_emoji     reactions (server allowlist of emoji names); POST toggles
DELETE    .../award_emoji/:name           revokes the viewer's award
GET/POST  .../notes/:note_id/award_emoji[/:name]   same for comments

GET/POST/PATCH/DELETE /api/v1/projects/:id/labels[/:label_id]
                                          title/description/color/scope; colors normalized to
                                          canonical #rrggbb (anything else → 400); presentation
                                          layer renders user hues as fixed-alpha tints only.
                                          Defaults seeded at project creation (bug/feature/
                                          documentation/critical). ?with_counts=true adds usage.
GET/POST/PATCH/DELETE /api/v1/projects/:id/milestones[/:milestone_id]
                                          title/description/due_date/state(active|closed);
                                          PATCH accepts state_event: close|activate. List/detail
                                          include total/opened/closed issue counts and
                                          completion_percent = floor(closed/total*100).
                                          merge_requests_count is part of the shape now (0 until
                                          the MR phase). Deleting a milestone unlinks its issues
                                          (SET NULL), never deletes them.
```

Web client (`web/src/issues/`): filtered/paginated list, detail view with interactive
Markdown task lists + activity timeline + reactions, label & milestone managers.
Label chips composite user colors at low alpha over panel tokens so arbitrary/neon
choices cannot violate the design palette (`web/src/issues/labelcolor.ts`).

### 3.9 Configurable issue forms (IMPLEMENTED)

Structured issue templates, LSGit-native by design (decision recorded below),
stored as versioned repository files at `.lsgit/issues/forms/<name>.yml` on the
default branch — the same storage plane as code, so forms inherit history,
review and rollback.

**Schema compatibility decision.** Recommended and adopted: an **LSGit-native
schema with a documented compatibility mapping** to GitLab-style templates.
Alternatives considered: (1) a GitLab-schema-compatible subset — rejected
because it would couple our storage contract to an external product surface we
only partially implement; (2) generic JSON-Schema-in-YAML — rejected as
over-general for issue forms with a larger validation/attack surface for zero
product gain. The mapping below lets tooling convert GitLab templates:

| GitLab template | LSGit form |
|---|---|
| `.gitlab/issue_templates/<n>.md` | `.lsgit/issues/forms/<name>.yml` |
| `body:` widget list | `fields:` list |
| widget `input` | `type: text` |
| widget `textarea` | `type: textarea` |
| widget `dropdown` (+ `multiple`) | `type: dropdown` (+ `attributes.multiple`) |
| widget `checkboxes` | `type: checkboxes`, or `type: tasklist` |
| widget validations `required` | `validations.required` |
| — (no equivalent) | `type: radio` · single `type: checkbox` · `title_prefix` · `title_field` · per-field `pattern`/lengths |

Field types: `text · textarea · dropdown · radio · checkbox · checkboxes · tasklist`.
Each field carries `id` ([a-z0-9_], unique), `attributes.label/description/
placeholder/options/multiple/default` and `validations.required/min_length/
max_length/pattern/pattern_message`. Task-list fields render ALL options as
real `- [ ]`/`- [x]` markers, so submissions participate in issue progress.

```
GET    /api/v1/projects/:id/issue_forms                 list (project readers); invalid stored
                                                        templates are flagged {valid:false,error},
                                                        never crash the listing
GET    /api/v1/projects/:id/issue_forms/:name            parsed definition → 422 if corrupted post-storage
PUT    /api/v1/projects/:id/issue_forms/:name  {yaml}    maintainer gate; validated BEFORE commit → 400
DELETE /api/v1/projects/:id/issue_forms/:name            removal commit (maintainer gate)
POST   /api/v1/projects/:id/issue_forms/:name/submissions
        {title?, answers} → 201 {issue}                  server re-validates every answer against the
                                                        stored schema; unknown ids/wrong types/out-of-option
                                                        choices/unconfirmed required options → 422 with
                                                        extras.field; renders structured Markdown body
                                                        (### <label> sections, task markers, provenance
                                                        footer), applies existing configured labels
                                                        (GitLab-lenient), resolves title via explicit >
                                                        title_field > first text field, prepends title_prefix
```

**YAML safety model (`server/src/lib/yaml.ts`).** Templates are data; nothing is ever
evaluated. An in-house strict-subset parser produces only null/bool/int/string/
arrays/plain objects. Rejected outright (parse error): tags (`!!…`),
anchors & aliases (&/* — billion-laughs vector), merge keys (`<<:`), flow
collections (`{}`/`[]`), block scalars (`|`/`>`), multi-document streams
(`---`/`...`), tab indentation, duplicate keys, unclosed quotes. Resource caps:
32 KB byte limit enforced pre-parse, depth ≤ 10, ≤ 1024 nodes. Schemas are
additionally bounded at validation time: ≤ 25 fields × ≤ 30 options, bounded
string lengths, compiled-regex guard (≤ 200 chars). A hostile template that is
corrupted after storage (e.g., pushed directly) is flagged invalid on read and
submissions fail closed with 422 — defense in depth.

Web client: creation dialog offers Blank issue vs. form mode (form picker →
dynamic fields → client-side mirror validation → submit), plus a maintainer
forms manager (`#/proj/<o>/<p>/issue_forms`) editing YAML with live validity
badges (`web/src/issues/FormsManagerView.tsx`).

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
