# LSGit — Permissions

Status: **PROPOSED (greenfield)**.
Reference: GitLab roles & permissions
(https://docs.gitlab.com/user/permissions/) — access-level numbers, matrix semantics,
and protected-ref rules are adopted; GitLab's EE-only roles (Planner 15,
Security Manager 25) are **deferred** but the numeric scheme leaves room for them.

---

## 1. Access levels

| Level | Name | Numeric | Notes |
|---|---|---|---|
| No access | none | 0 | |
| Guest | guest | 10 | view public/internal project code+issues; create issues/comments |
| Reporter | reporter | 20 | + read reports, labels/milestones mgmt, MR review |
| Developer | developer | 30 | + push non-protected branches, create branches/tags, run pipelines, create MRs, assign to assignee-eligible sets |
| Maintainer | maintainer | 40 | + push/delete protected branches (if rule allows), manage hooks/runners/variables, manage members up to Maintainer, transfer within group |
| Owner | owner | 50 | + delete/archive/transfer project, change visibility, manage group settings, share groups |
| Admin | admin | instance flag, not a member level | bypasses membership checks; every admin action audited |

Rules adopted from GitLab:

- Highest applicable level wins across: direct project membership ⊕ parent-group
  inheritance ⊕ group links (shared-with) ⊕ role of namespace owner.
- Group Owner on a root group ⇒ Owner on all subgroups/projects beneath it.
- Membership `expires_at` demotes access automatically after expiry (worker sweep +
  check-at-eval).
- Namespace owners are implicit full members of their user/group namespaces.

## 2. Visibility levels

| Value | Level | Who can see the project exists & read default-visible features |
|---|---|---|
| 0 | private | members only (+admin) |
| 10 | internal | any authenticated user |
| 20 | public | everyone incl. anonymous |

Non-members interacting with private projects get **404** (not 403) to avoid
existence leaks. Search results, activity feeds, API listings, and webhooks payloads
must all pass through the same visibility filter.

## 3. Feature visibility gates

Per-project toggles (`project_features`) independently restrict each feature beyond
project visibility: issues · repository · merge_requests · forks · wiki · snippets ·
pages · pipelines. Values: disabled(0) / private(10, members-only) / enabled(20,
follows project visibility). UI hides disabled features entirely; API returns 404.

Default matrix at project creation mirrors GitLab defaults (issues/repo/MR/wiki/
snippets enabled at project visibility level).

## 4. Protected branches

Each rule targets a branch glob (e.g., `main`, `release/*`) with:

```
push_access_levels       [roles/users]   default: Maintainer+ (40+)
merge_access_levels      [roles/users]   default: Maintainer+ (40+)  → MR merges
unprotect_access_levels  [roles/users]   default: Maintainer+ (40+)
allow_force_push         bool            default: false
code_owner_approval_required bool        Phase 2 (CODEOWNERS file support)
```

Invariants enforced in git-core gate (via internal `/allowed`):

1. Direct pushes violating push levels ⇒ reject before streaming.
2. Force-push (non-fast-forward) to protected ref ⇒ rejected for everyone below
   instance admin regardless of `allow_force_push=false`; when true, allowed per rule.
3. Deleting protected branch ⇒ requires unprotect rights (GitLab parity).
4. Merge into protected target happens **only** through an MR satisfying merge rules;
   squash commits honor target protection.
5. Default branch is protected with Maintainer-push by default at project creation.

## 5. Protected tags

`create_access_levels` per tag glob (default Maintainer+); deletion follows same rule.
Prevents tag spoofing for releases/deploy triggers.

## 6. Issues & confidentiality

- Guests may create/comment on issues but see confidential issues **only** ones they
  authored or are assigned to (GitLab rule).
- Confidential issues excluded from: search, activity feeds, webhook payloads for
  unauthorized receivers, notification fan-out, issue counters shown to guests.
- MR visibility inherits repo read rights; reviewers/assignees must have repo access.

## 7. Machine identities

| Identity | Grants | Constraints |
|---|---|---|
| Deploy key (SSH) | read or read+write one project | write requires Maintainer to enable |
| Deploy token | username+token for repo read/write and/or packages | scoped, expiring, revocable |
| CI job token | job→platform calls within its project (+explicitly trusted projects) | short-lived; cannot read arbitrary private repos |
| Group/project access tokens | bot-user PAT bound to resource lifetime | counted as members; destroyed with resource |

## 8. Sharing & delegation

- Project shared with group ⇒ effective max(project-member level, group-link level)
  for that group's members; link has its own expiry.
- `share_with_group_lock` on a namespace blocks sharing descendants (inherited lock).
- Transfers require: Owner on source, Maintainer+ (default) or Owner on target
  namespace, no conflicting path; transfer rewrites `traversal_ids` and revalidates
  authorization cache incrementally.

## 9. Authorization evaluation order (normative)

1. Admin? ⇒ allow (audited).
2. Anonymous? ⇒ visibility==public AND feature gate enabled?
3. Resolve effective access level via memberships/links/expiry.
4. Feature-specific checks (confidentiality, protected refs, approval eligibility).
5. Deny ⇒ 404 for existence-sensitive resources, 403 otherwise.

The evaluator is pure & cached per-request; `project_authorizations` table backs step 3
for listing queries (DATABASE.md §2). Cache invalidation events fire on every
membership/link/hierarchy mutation.

## 10. Test obligations

Every permission-relevant feature ships: positive matrix test across all seven levels,
anonymous case, expired-membership case, subgroup-inheritance case, and
protected-ref edge cases. Permission drift between REST/GraphQL/UI/git transport is a
release blocker.
