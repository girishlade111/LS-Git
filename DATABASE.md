# LSGit — Database

Status: **PROPOSED (greenfield)**.
Engine: **PostgreSQL** (only choice consistent with the GitLab reference and with the
JSONB + partitioning + sequence features this design needs). No other database exists in
the repo; nothing to migrate from.

---

## 1. Principles (adopted from GitLab's data layer)

1. PostgreSQL is the single source of truth. Redis holds only queues/caches/counters;
   object storage holds only blobs addressed by metadata rows.
2. Every user-facing collection gets a stable per-project integer `iid` in addition to
   the global `id`. GitLab does this for issues/MRs because global IDs leak creation
   volume across projects and make URLs unstable under import/export.
3. Authorization is denormalized into an authorization table refreshed on membership
   change, so "projects I can see" is a single indexed query.
4. Migrations are forward-only, versioned, and split into *schema* migrations and
   *data backfills* (background migration jobs) — GitLab's zero-downtime discipline.
   Large-table index builds must use `CREATE INDEX CONCURRENTLY`; column adds must be
   nullable or defaulted via backfill job, never `NOT NULL DEFAULT` on hot tables.
5. Soft-delete only where the product needs it (project deletion is a two-step
   `pending_delete` → purge job, mirroring GitLab). Everything else hard-deletes
   with cascades defined explicitly.

## 2. Core schema (Phase 1–2 scope)

Types below are indicative (`bigint` PKs everywhere unless noted).

### Identity & namespaces

```
users(id, username CITEXT UNIQUE, email CITEXT UNIQUE, encrypted_password,
      name, admin bool, state enum[active,blocked,deactivated,ldap_blocked],
      created_at, updated_at, ...)
ssh_keys(id, user_id→users, title, key TEXT, fingerprint_sha256 TEXT UNIQUE,
         usage enum[auth,signing,auth_and_signing], expires_at)
personal_access_tokens(id, user_id→users, name, scopes text[],
                       token_digest SHA256 UNIQUE, expires_at, revoked_at,
                       last_used_at)
-- token plaintext never stored; lookup by digest only.

namespaces(id, type enum[group,user], name, path CITEXT, parent_id→namespaces NULL,
           owner_id→users NULL, visibility int DEFAULT 0 CHECK IN (0,10,20),
           -- nested sets or ltree for subtree queries:
           traversal_ids bigint[],            -- e.g. {1,42,77}
           share_with_group_lock bool, ... )
UNIQUE(parent_id, lower(path))
```

- Users get a hidden personal namespace row (GitLab pattern) so a project always lives
  in exactly one namespace and routing code has one shape: `{namespace}/{project}`.
- `traversal_ids` array enables `WHERE traversal_ids @> ARRAY[:group_id]` subtree scans
  without recursive CTEs on every request.

### Projects & repositories

```
projects(id, namespace_id→namespaces, name, path CITEXT,
         visibility int CHECK IN (0,10,20),
         description, creator_id→users,
         default_branch TEXT DEFAULT 'main',
         repository_storage TEXT NOT NULL,     -- shard name (STORAGE.md §2)
         disk_path TEXT NOT NULL UNIQUE,       -- '@hashed/ab/cd/<sha256>.git'
         pending_delete bool DEFAULT false,
         archived bool DEFAULT false,
         star_count int DEFAULT 0,             -- counter cache
         last_repository_updated_at timestamptz,
         import_status ..., forked_from_project_id→projects NULL, ...)
UNIQUE(namespace_id, lower(path))

project_features(project_id PK/FK→projects,
  issues/wiki/snippets/repository/merge_requests/pages/pipelines/
    container_registry/forks int CHECK IN (0 disabled,10 private,20 enabled),
  -- default mirrors project visibility semantics; gates feature routes

fork_network_members / object pools deferred to Phase 3 (STORAGE.md §5)
stars(user_id, project_id) PK(user_id, project_id)          -- drives star_count cache
users_star_projects replaced by stars; watchers implemented as
watches(user_id, project_id, level enum[participating,on_mention,all,custom])
```

### Memberships & authorization

```
members(id, source_type enum[namespace,project], source_id,
        user_id→users, access_level int CHECK BETWEEN 0 AND 50,
        created_by_id, expires_at timestamptz NULL, ...)
UNIQUE(source_type, source_id, user_id)
-- access levels: 10 guest, 20 reporter, 30 developer, 40 maintainer, 50 owner

project_authorizations(user_id, project_id, access_level)  -- denormalized cache
PK(user_id, project_id); rebuilt incrementally whenever members,
group_links, group membership, or namespace hierarchy changes.
```

### Collaboration

```
issues(id, project_id→projects, iid int NOT NULL, author_id, title,
       description TEXT, state enum[opened,closed], confidential bool,
       due_date, time_estimate, weight?, moved_to_id, closed_at, ...)
UNIQUE(project_id, iid)

merge_requests(id, target_project_id, source_project_id, iid int NOT NULL,
       title, description, state enum[opened,closed,merged,locked],
       source_branch, target_branch, author_id, assignee_ids bigint[],
       reviewer_ids bigint[], merge_commit_sha, merge_status enum[
         unchecked,can_be_merged,cannot_be_merged,...],
       squash_on_merge bool, draft bool, ...)
UNIQUE(target_project_id, iid)

notes(id, noteable_type enum[issue,merge_request,commit,snippet],
      noteable_id, project_id, author_id, note TEXT,
      system bool, resolved_at, ...)        -- polymorphic; index (noteable_type,noteable_id)

labels(id, project_id, title, color, description)
label_links(label_id, target_type, target_id)
milestones(id, project_id, title, due_date, state)

diff_note_positions(...)                 -- Phase 2: line-position tracking for MR notes
merge_request_diffs(id, merge_request_id, head_commit_sha, base_commit_sha,
                    start_commit_sha, real_size, external_diff stored in obj-store)
```

**iid generation:** dedicated table `internal_ids(namespace_id, project_id, usage enum,
last_value)` with `SELECT ... FOR UPDATE` increment inside the issue/MR creation
transaction (GitLab's exact mechanism). Do **not** use per-project Postgres sequences:
they can't be reset safely during import/export and complicate restore.

### Repository-facing metadata

```
protected_branches(id, project_id, name TEXT /* glob */, 
                   push_access_levels jsonb, merge_access_levels jsonb,
                   unprotect_access_levels jsonb, allow_force_push bool,
                   code_owner_approval_required bool, ...)
protected_tags(id, project_id, name /* glob */, create_access_levels jsonb)

releases(id, project_id, tag_name, name, description, author_id,
         released_at, assets_url, asset_links jsonb)
tags are NOT duplicated in SQL except protected rules + release rows;
tag listings come from git-core.

web_hooks(id, project_id, url, secret_token_encrypted, events text[],
          push_events_branch_filter, enable_ssl_verification,
          alert_status, disabled_until, recent_failures smallint, ...)

deploy_keys / deploy_tokens / group_links — see PERMISSIONS.md §7
```

## 3. CI/CD schema (Phase 3)

Modeled on GitLab's proven shape:

```
ci_pipelines(id, project_id, sha, ref, status enum[pending,running,success,failed,
             canceled,skipped,created,waiting_for_resource,...],
             source enum[push,web,trigger,schedule,api,pipeline,mr,...],
             before_sha, tag bool, yaml_errors, duration, started_at, finished_at)
ci_stages(id, pipeline_id, name, position, status)
ci_builds(id, project_id, pipeline_id, stage_id, name, stage_idx, status,
          runner_id NULLABLE FK→ci_runners, commit-sha ref columns,
          allow_failure bool, when_ enum[on_success,on_failure,always,manual,delayed],
          options jsonb, yaml_variables jsonb, erased_at, artifacts metadata...)
PARTITION BY RANGE(created_at) monthly from day one of Phase 3
  (GitLab partitions CI tables; retrofitting partitioning later = full rewrite).
ci_runners(id, runner_type enum[instance,group,project], token_digest,
           authentication_token_digest, description, tags text[], active,
           locked, run_untagged, access_level enum[not_protected,ref_protected],
           contacted_at, ...)
ci_runner_projects(runner_id, project_id)          -- specific-runner assignment
ci_job_artifacts(id, build_id, file_type enum[archive,metadata,trace,junit,sast,...],
                 size, disk/object-store location, expire_at)
ci_pipeline_schedules(id, project_id, cron, cron_timezone, owner_id, active, next_run_at)
ci_variables(id, project_id NULL, group_id NULL, key, value_encrypted,
             protected bool, masked bool, environment_scope)
ci_trigger_requests / pipeline triggers — tokens hashed like PATs
environments / deployments(Phase 3 late):
  environments(id, project_id, name UNIQUE(project_id,name), ...)
  deployments(id, project_id, environment_id, deployable_type/build_id,
              status enum[created,running,success,failed,canceled], finished_at)
```

Runner protocol state machine (pull model): `created → pending → running →
success|failed|canceled`, trace appended via authenticated PATCH, heartbeat
`touch` updates stale-job reaper (jobs whose runner died are retried up to N times).

## 4. Indexing & performance contract

- Hot paths get covering indexes at creation time, not after profiling:
  - `issues(project_id, state, updated_at DESC)` for list views
  - `notes(noteable_type, noteable_id, created_at)`
  - `projects(traversal-based visibility search)` via join to namespaces
  - `ci_builds(status, runner_id)` partial index for job claiming:
    `WHERE status='pending'` — claim uses `FOR UPDATE SKIP LOCKED`.
- Counter caches (`star_count`) maintained transactionally; drift-check rake task.
- Full-text search: start with PG tsvector GIN indexes on issues/MRs titles+descriptions;
  code search delegated to git-core `git grep` streaming behind a search adapter
  interface (swap-in external indexer in Phase 5 without API break).

## 5. Migration & operations discipline

1. Every PR touching schema requires a migration reviewed against the checklist above.
2. Backfills ship as batched background jobs (e.g., 10k rows/batch) with progress metric.
3. `pg_dump` logical backups nightly + WAL archiving when self-hosted docs mature;
   backup includes object-storage buckets (see STORAGE.md §8).
4. All timestamps `timestamptz` UTC. All money-free domain — no decimals needed yet.
5. JSONB used sparingly (CI options, webhook payload templates); anything queried gets a
   real column + expression index instead.

## 6. Open items tracked here

- Group wikis reuse the same repo layout as project wikis keyed by namespace id
  (decided in STORAGE.md §4) — no extra schema beyond `wiki_slug`.
- Snippets: personal vs project snippets both supported (GitLab parity), single table
  with nullable project_id.
