# LSGit API server

Fastify 5 + `node:sqlite` identity/authentication service.

## Run

```powershell
cd server
npm install
npm run dev            # http://127.0.0.1:4000  (API only; UI is ../web)
```

Environment variables (see `src/config.ts`):

| Variable | Default | Purpose |
|---|---|---|
| `LSGIT_SECRET` | ephemeral in dev | Cookie/HMAC secret. REQUIRED in production. |
| `LSGIT_DB` | `./data/lsgit.db` | SQLite file (`:memory:` supported). |
| `PORT` | 4000 | Listen port. |
| `LSGIT_SESSION_TTL_MINUTES` | 10080 (7 days, GitLab parity) | Sliding session window. |
| `LSGIT_MAX_FAILED_LOGINS` / `LSGIT_LOCKOUT_MINUTES` | 10 / 60 | Account lockout. |
| `LSGIT_AUTH_RATE_MAX` / `LSGIT_AUTH_RATE_WINDOW_S` | 20 / 60 | Per-IP auth endpoint limits. |
| `LSGIT_SCRYPT_N/R/P` | 16384/8/1 | Password KDF cost (tests lower it). |

## Tests

```powershell
npm test        # unit + integration (fast, in-memory DB per app instance)
```

## Dev/test conveniences

- Emails (verification, password reset) are persisted to the `mail_outbox`
  table rather than SMTP — inspect via any SQLite client while developing.
- The first registered account becomes the instance administrator
  (GitLab CE parity).
