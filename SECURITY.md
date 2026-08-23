# LSGit — Security

Status: **PROPOSED (greenfield)**.
Reference: GitLab security architecture, token model, and webhook hardening behaviors.

---

## 1. Authentication surfaces

| Surface | Mechanism | Notes |
|---|---|---|
| Web UI | email+password (argon2id), optional TOTP/WebAuthn 2FA | session cookie: HttpOnly, Secure, SameSite=Lax; rotation on privilege change |
| REST/GraphQL | PAT (`PRIVATE-TOKEN` / `Bearer`) or OAuth2 code+PKCE | scopes per API.md §2; `sudo` admin-only |
| Git over HTTPS | PAT/deploy-token as password, CI job token, OAuth token | basic auth realm; constant-time comparisons |
| Git over SSH | ed25519/ecdsa/rsa keys; single system user | key→user via internal API with Redis cache; fingerprints sha256 |
| Runners | registration + rotating authentication tokens | hashed at rest |
| Packages registries | deploy tokens / CI job tokens / scoped PATs | per-ecosystem auth adapters |

Password/key/token policies: min length, breach-list check (k-anonymity), expiry
optional per instance setting. All secrets stored as SHA-256 digests; plaintext shown
exactly once at creation. Token revocation is synchronous and global.

## 2. Authorization model

Single evaluator (PERMISSIONS.md) is the ONLY authorization decision point:
web routes, REST, GraphQL resolvers, internal `/allowed` gate for git transport,
and runner job delivery all call it. No feature may implement bespoke role checks.

Protected refs enforce: push/merge/unprotect access levels, force-push denial
(nobody below instance-admin), protected variables only on protected refs,
protected runners only run protected-ref jobs.

## 3. Threat model highlights & mitigations

| Threat | Mitigation |
|---|---|
| Stored XSS via markdown/comments/filenames | server-side sanitizer allowlist pipeline for all markdown; autolink scheme allowlist; uploaded SVG never served inline as image/svg+xml from app origin; CSP default-src 'self' + nonce'd scripts |
| CSRF | SameSite cookies + per-form CSRF tokens for state-changing browser routes; API exempted (token-authenticated) |
| SSRF via webhooks/import URLs/mirrors | DNS-resolve-then-connect pinning; deny private/link-local/multicast ranges unless instance allowlist; TLS certificate verification mandatory; redirect policy = revalidate each hop |
| Path traversal in uploads/archives/extraction | hashed storage removes name-based paths; zip-slip guard on archive extraction; filename normalization; no user-controlled paths ever reach disk joins |
| Repo poisoning via malicious hooks/config in pushed repos | platform hooks live outside repo working trees; git-core refuses to execute anything inside pushed content; submodule URL validation on browse render only (no auto-fetch) |
| Credential leakage in CI logs | masked variables rendered redacted in traces; protected variables withheld from non-protected refs and fork MR pipelines; debug-mode logs restricted to Maintainer+ |
| Fork-MR exfiltration of secrets | pipelines for MRs from forks run with read-only public vars unless target-project approval flow grants otherwise (GitLab parity rule) |
| Brute force / credential stuffing | progressive rate limits per IP+account, lockout backoff, CAPTCHA hook point |
| Session fixation | new session id on login/privilege change |
| Clickjacking | X-Frame-Options DENY / frame-ancestors 'none' |
| Supply-chain of LSGit itself | pinned dependencies, SBOM generated in CI, container images signed |

## 4. Secrets handling

- CI variables encrypted at rest (envelope encryption; KMS-managed master key or
  file-backed key with documented rotation).
- Webhook secrets, mirror credentials, import tokens: encrypted columns, decrypted
  only in workers at delivery time.
- Error reporting scrubbers strip known secret headers/patterns before any external sink.

## 5. Auditability

Audit event rows (who, what, target ip, ua, when) for: auth success/failure,
membership changes, permission escalations, project visibility changes,
key/token lifecycle, protected-ref changes, admin actions, export/download of
private data by admins. Retention configurable; admin UI queryable (Phase 3).

## 6. Rate limiting buckets (defaults)

anonymous API · authenticated API · authentication endpoints · webhook deliveries
(outbound) · Git HTTP unauthenticated info/refs · GraphQL complexity budget.
All instance-configurable; responses carry `RateLimit-*` headers; 429 includes
`Retry-After`.

## 7. Transport

TLS 1.2+ everywhere client-facing; HSTS once enabled; internal service traffic
on private network with mTLS between edge/git-http/ssh-gateway/lsgit-web
(internal API MUST NOT be internet-reachable).

## 8. Secure defaults checklist for every phase exit

- [ ] New endpoints covered by authz tests incl. negative cases (403/404 semantics: 404 for private resources to avoid existence leaks)
- [ ] Upload paths fuzz-tested for traversal
- [ ] Markdown renderer snapshot-tested against XSS corpus
- [ ] Dependency audit green (fail build on critical)
- [ ] No secret material in logs (automated log scan in CI)
