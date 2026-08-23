# LSGit — Events

Status: **PROPOSED (greenfield)**.
Reference: GitLab webhook events & system hooks
(https://docs.gitlab.com/user/project/integrations/webhook_events/) — payload shapes,
limits, and failure behavior are adopted conceptually with LSGit naming.

---

## 1. Event flow model

```
Domain action (web UI / API / git push post-receive / CI transition)
        │  same transaction? NO — emit AFTER commit
        ▼
events table (durable outbox) ──► dispatcher worker ──► fan-out queues:
                                                        ├─ webhook_delivery
                                                        ├─ notifications (email)
                                                        ├─ activity feed writer
                                                        ├─ search indexer
                                                        └─ ci pipeline creator
```

Contracts:

1. **At-least-once delivery** internally; consumers must be idempotent
   (dedupe key = event uuid).
2. Events are emitted after DB commit via an outbox row (no lost events on crash;
   dispatcher sweeps unsent rows). Ordering is best-effort per aggregate
   (project-scoped partition key).
3. Payload versioning: every webhook payload carries `object_kind`, `event_type`,
   and `schema_version`; additive fields only within a schema_version.

## 2. Internal event catalog (canonical names)

| Event | Trigger |
|---|---|
| `repo.push` | successful receive-pack (per ref change) |
| `repo.tag_push` | tag create/delete |
| `repo.destroyed` | repo deleted/purged |
| `issue.created/updated/closed/reopened` | issue lifecycle |
| `merge_request.created/updated/approved/unapproved/merged/closed/reopened` | MR lifecycle incl. system-triggered approval resets (flagged `system:true`) |
| `note.created/updated` | comments on issue/MR/commit/snippet |
| `pipeline.created/success/failed/canceled` | CI transitions |
| `job.status_changed` | build transitions |
| `deployment.started/succeeded/failed/canceled` | env deployments |
| `release.created/updated/deleted` | releases |
| `member.added/updated/removed` | group/project membership |
| `project.created/updated/transferred/destroyed` | project lifecycle |
| `wiki_page.created/updated/deleted` | wiki repo pushes translated to page events |
| `runner.registered/touched/failed` | runner health |

Internal consumers subscribe declaratively (queue name, filter) — no direct coupling
from domain services to side effects.

## 3. Outbound webhook catalog (external contract)

Header conventions (LSGit equivalents of GitLab's):

```
X-LSGit-Event: Push Hook            # kind, matching GitLab naming semantics
X-LSGit-Token: <configured secret>  # receiver verifies
X-LSGit-Webhook-UUID: <hook id>     # identifies the hook config
X-LSGit-Event-UUID: <delivery id>   # idempotency on receiver side
```

Event kinds shipped (Phase mapping in ROADMAP):

Push Hook · Tag Push Hook · Issue Hook · Note Hook · Merge Request Hook ·
Wiki Page Hook · Pipeline Hook · Job Hook · Deployment Hook · Release Hook ·
Member Hook · Project Hook.

### Push Hook payload shape (contract)

```json
{
  "object_kind": "push",
  "event_type": "push",
  "schema_version": 1,
  "before": "<old sha>", "after": "<new sha>", "ref": "refs/heads/main",
  "user_id": 1, "user_name": "...", "user_username": "...",
  "project": { "id": 5, "path_with_namespace": "grp/proj", "web_url": "...", ... },
  "total_commits_count": 3,
  "commits": [ { "id": "...", "message": "...", "timestamp": "...",
                 "added": [], "modified": [], "removed": [] } ]
}
```

Adopted GitLab behavioral limits (documented, not accidental):

- Pushes touching **more than 3 branches/tags trigger no webhooks** for that push
  (`push_event_hooks_limit`, admin-tunable).
- `commits[]` capped at newest **20** entries; `total_commits_count` remains exact.
- Branch created without commits ⇒ empty `commits`.
- Author email redacted when the author has no public profile email.

## 4. Filtering & configuration

Per-hook config mirrors GitLab: enable/disable per event kind, push branch filter
(all / wildcard pattern / regex), SSL verification toggle, secret token,
optional custom payload template (top-level property interpolation only — arrays not
addressable, documented limitation).

Group-level hooks (Phase 3+) receive union of member-project events.
System hooks (admin-only) mirror instance-wide events for automation tooling.

## 5. Delivery guarantees & failure policy

- Retries with exponential backoff (e.g., 8 attempts over ~6h window).
- Response must complete within timeout; slow receivers get cut off (log captures
  status + first N KB).
- **Auto-disable:** hook disabled automatically after threshold of consecutive failing
  deliveries (4xx/5xx/timeouts); owner emailed; manual/reactive re-enable supported.
- 4xx responses indicate receiver misconfiguration (counted toward disable faster);
  receivers should ignore unknown kinds rather than 500-ing — documented guidance.
- Delivery log retained per hook (recent N results) queryable via API for debugging.

## 6. Activity feed & notifications (consumers)

- Activity feed rows written by consumer (not inline) — eventual consistency accepted.
- Notification decisions (participating/on-mention/watch levels) resolve against
  PERMISSIONS.md visibility rules before send; confidential issues notify only
  authorized participants.
- Emails batched/digested per user preference profile (Phase 2).

## 7. Testing requirements

Contract tests pin payload JSON schemas (golden files) — breaking payload changes
require schema_version bump + changelog entry. Dispatcher idempotency tested by
duplicate-event injection. Auto-disable logic covered by simulated failure sequences.
