# LSGit — Roadmap

Status: **PROPOSED (greenfield)**. Scope mirrors the product mandate: repositories,
Git operations, upload/drag-and-drop, branches, commits, tags, code browsing, file
editing, forks, stars, watchers, issues, merge requests, discussions, projects,
releases, packages, deployments, CI/CD, runners, security scanning, organizations,
teams, webhooks, REST API, GraphQL API, Pages, Gists, AI-assisted workflows.

Reference: GitLab CE/FOSS behavior. Each phase has explicit exit criteria; nothing in a
later phase may leak into earlier phases' scope.

---

## Phase 0 — Foundations (blocking)

Scope: repo scaffold for the confirmed stack; docker-compose dev environment
(app, PostgreSQL, Redis, MinIO, git-core stub); CI pipeline (lint+test+build);
migration framework wired; health endpoints; structured logging; config via env.

Exit criteria: `docker compose up` → green smoke test hitting `/healthz` on all
services; migrations run idempotently; CI enforces lint+tests on PRs.

## Phase 1 — Core Git platform

Scope:
- Users, groups/namespaces (nested), projects; visibility levels; members & roles.
- git-core service + hashed storage (STORAGE.md §2); smart-HTTP transport;
  ssh-gateway with internal-API auth.
- Code browsing UI/API: tree, blob, raw, blame, commits, diff, compare,
  branches/tags CRUD, protected branches/tags (PERMISSIONS.md §4–5).
- Web file editing + file upload (single file) incl. LFS pointer handling basics.
- Stars, watchers, activity feed (minimal).
- REST v1 core catalog (API.md §3 Phase 1) + internal API (API.md §5).

Exit criteria: clone/fetch/push over HTTPS and SSH against protected default branch;
rename project does not move disk paths; permission matrix tests green across roles;
404-vs-403 semantics verified.

## Phase 2 — Collaboration

Scope: issues (+iid sequencing, labels, milestones, confidentiality rules),
merge requests (diff views, inline discussions/notes w/ resolution, approvals,
squash-on-merge, merge pipelines pre-check), releases bound to tags,
webhooks (EVENTS.md catalog subset), notifications/email digests, drag-and-drop
attachments (presigned uploads), CODEOWNERS enforcement flag.

Exit criteria: MR merge blocked by failing protected-ref rules & unresolved
discussions per policy; webhook delivery with retry + auto-disable demonstrated by
integration test; iid stability under import/export round-trip.

## Phase 3 — CI/CD & automation

Scope: `.lsgit-ci.yml` schema (stages/jobs/needs/rules/artifacts/cache/variables),
pipeline creation from push/MR/schedule/manual triggers, runner registration &
pull-based job protocol (API.md §6), trace streaming, artifact store + expiry,
protected variables/runners semantics, environments & deployments v1,
group hooks, fork deduplication object pools (STORAGE.md §5),
project export/import, audit log UI.

Exit criteria: sample polyglot repo runs multi-stage pipeline to green with artifact
download; stale-runner reaper recovers killed jobs; partitioned ci_builds proven at
10M synthetic rows without lock contention on inserts.

## Phase 4 — Ecosystem

Scope: package registries (npm/maven/pypi/generic first; publish via CI job token or
deploy token), container registry integration decision executed (upstream Distribution
registry + LSGit token auth, mirroring GitLab's approach), Pages (static site build job
→ bucket → pages daemon with optional access control), gists (personal snippets UX),
GraphQL parity for Phases 1–3 surfaces.

Exit criteria: publish/install package round-trip in CI; Pages site served with access
control honored; GraphQL covers ≥90% of shipped REST read surface.

## Phase 5 — Security & intelligence

Scope: security scanning framework (SAST/secrets/dependency scanning adapters,
report ingestion API, vulnerability report UI — modeled on GitLab analyzers'
report schemas but pluggable), advanced code search adapter slot, AI-assisted
workflows behind provider-agnostic gateway (MR summarization, issue triage
suggestions, commit message assist; opt-in per instance, no code leaves instance
unless configured), rate-limit dashboards, backup/restore drill completion.

Exit criteria: scanning reports render in MR widget with policy gate example;
AI features feature-flagged off by default; documented restore drill passes.

## Cross-cutting non-negotiables (every phase)

1. Permission matrix + negative authz tests ship with each feature.
2. No synchronous side effects in request handlers (events only).
3. Schema changes reviewed against DATABASE.md §1 discipline.
4. Payload/schema versioning respected (EVENTS.md §7, API changelog).

## Risks register

| Risk | Impact | Mitigation |
|---|---|---|
| Wrong stack choice | months of rework | decision gated below before Phase 0 |
| git-core correctness (pack streaming edge cases) | data loss | contract tests vs real `git` client matrix; fsck verification jobs |
| Authorization drift across surfaces | leaks | single evaluator + cross-surface parity tests |
| CI scale unbounded growth | DB bloat | monthly partitions from day one + expiry defaults |
| Object-storage vendor lock-in | ops risk | S3-compatible abstraction only; MinIO dev parity |
| Scope creep toward EE features | delay | this roadmap is the arbiter; deviations require doc update PR |

## Stack decision inputs (feeds the blocking question)

Considerations recorded for the stack follow-up:

- **TypeScript monolith** (`Fastify`/`NestJS` + `Next.js`/React + `BullMQ`):
  one language across web/workers/git-http; strong async I/O for streaming packfiles;
  largest ecosystem for UI work. Git plumbing still shells out to system `git`.
- **Rails monolith**: closest behavioral mirror of the GitLab reference (same idioms,
  Sidekiq, battle-tested patterns); slower runtime; smaller modern hiring pool than TS.
- **Go services + thin TS frontend**: best raw performance for git-core/transport;
  highest early operational complexity if everything is Go; UI velocity lower.

All three satisfy the architecture above because component boundaries are fixed;
the choice changes implementation language only.
