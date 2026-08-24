/** Embedded migrations. Each runs once, inside a transaction. */

export const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        email TEXT NOT NULL COLLATE NOCASE UNIQUE,
        name TEXT,
        password_hash TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',
        admin INTEGER NOT NULL DEFAULT 0,
        email_verified INTEGER NOT NULL DEFAULT 0,
        failed_login_count INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT,
        bio TEXT,
        location TEXT,
        website_url TEXT,
        public_email TEXT,
        avatar_content_type TEXT,
        avatar_bytes BLOB,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_digest TEXT NOT NULL UNIQUE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        ip TEXT,
        user_agent TEXT
      );
      CREATE INDEX idx_sessions_user ON sessions(user_id);

      CREATE TABLE ssh_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        key_type TEXT NOT NULL,
        bits INTEGER,
        fingerprint TEXT NOT NULL UNIQUE,
        public_key TEXT NOT NULL,
        comment TEXT,
        usage_mode TEXT NOT NULL DEFAULT 'auth_and_signing',
        expires_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_ssh_keys_user ON ssh_keys(user_id);

      CREATE TABLE access_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        scopes TEXT NOT NULL,
        token_digest TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        last_used_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_access_tokens_user ON access_tokens(user_id);

      CREATE TABLE password_resets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_digest TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE email_verifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_digest TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        verified_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        event TEXT NOT NULL,
        ip TEXT,
        user_agent TEXT,
        detail TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_audit_user ON audit_events(user_id, created_at DESC);

      CREATE TABLE mail_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        to_email TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id INTEGER NOT NULL REFERENCES users(id),
        name TEXT NOT NULL,
        path TEXT NOT NULL COLLATE NOCASE,
        visibility TEXT NOT NULL DEFAULT 'private'
          CHECK (visibility IN ('private', 'internal', 'public')),
        description TEXT NOT NULL DEFAULT '',
        website_url TEXT NOT NULL DEFAULT '',
        default_branch TEXT NOT NULL DEFAULT 'main',
        archived INTEGER NOT NULL DEFAULT 0,
        is_template INTEGER NOT NULL DEFAULT 0,
        repository_storage TEXT NOT NULL DEFAULT 'default',
        disk_path TEXT NOT NULL UNIQUE,
        initialized INTEGER NOT NULL DEFAULT 0,
        last_activity_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_projects_owner ON projects(owner_id);
      CREATE INDEX idx_projects_visibility ON projects(visibility);

      -- Canonical topic registry: lowercase-normalized, case-insensitively unique.
      CREATE TABLE project_topics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL COLLATE NOCASE UNIQUE
      );

      CREATE TABLE project_topic_links (
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        topic_id INTEGER NOT NULL REFERENCES project_topics(id) ON DELETE CASCADE,
        PRIMARY KEY (project_id, topic_id)
      );
      CREATE INDEX idx_topic_links_topic ON project_topic_links(topic_id);

      -- Old owner/path → project mappings so renames and transfers do not break URLs.
      CREATE TABLE project_redirects (
        owner_username TEXT NOT NULL,
        path TEXT NOT NULL COLLATE NOCASE,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (owner_username, path)
      );
    `,
  },
  {
    version: 3,
    sql: `
      -- Staged uploads: temp-file bookkeeping between initiate and commit/cancel.
      CREATE TABLE uploads (
        id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id),
        file_path TEXT NOT NULL,
        declared_size INTEGER NOT NULL,
        received_size INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK (state IN ('pending', 'completed', 'cancelled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_uploads_project ON uploads(project_id, state);

      -- Durable event outbox (EVENTS.md §1). Consumers fan out async; rows are the
      -- authoritative emission record for repository mutations.
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        type TEXT NOT NULL,
        payload TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_events_project ON events(project_id, id DESC);
    `,
  },
  {
    version: 4,
    sql: `
      -- Multi-file upload sessions (folder/project upload). A batch groups the
      -- per-file staging rows so the whole set lands as ONE git commit and ONE
      -- event — never one database transaction per file.
      CREATE TABLE upload_batches (
        id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id),
        state TEXT NOT NULL DEFAULT 'open'
          CHECK (state IN ('open', 'completed', 'cancelled')),
        declared_files INTEGER NOT NULL DEFAULT 0,
        declared_bytes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_upload_batches_project ON upload_batches(project_id, state);

      ALTER TABLE uploads ADD COLUMN batch_id TEXT REFERENCES upload_batches(id) ON DELETE CASCADE;
      CREATE INDEX idx_uploads_batch ON uploads(batch_id, state);

      -- Minimal protected-ref enforcement (PERMISSIONS.md §4–5). Exact branch
      -- names only for now; glob patterns arrive with the collaboration phase.
      -- The default branch is protected with Maintainer-push at project creation.
      CREATE TABLE protected_branches (
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL COLLATE NOCASE,
        push_access_level TEXT NOT NULL DEFAULT 'maintainer'
          CHECK (push_access_level IN ('no_one', 'maintainer')),
        PRIMARY KEY (project_id, name)
      );
    `,
  },
  {
    version: 5,
    sql: `
      -- Resumable upload sessions (UPLOADS.md). Headless infrastructure: the
      -- browser (or any API client) stages chunks, resumes after interruption,
      -- and finalizes into exactly one commit. Chunk bytes NEVER enter
      -- PostgreSQL — only bookkeeping. The staging store is authoritative for
      -- which chunks exist; DB counters are advisory progress state.
      CREATE TABLE upload_sessions (
        id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id),
        state TEXT NOT NULL DEFAULT 'open'
          CHECK (state IN ('open', 'committed', 'failed', 'cancelled', 'expired')),
        declared_files INTEGER NOT NULL,
        declared_bytes INTEGER NOT NULL,
        received_bytes INTEGER NOT NULL DEFAULT 0,
        received_chunks INTEGER NOT NULL DEFAULT 0,
        committed_branch TEXT,
        committed_sha TEXT,
        committed_files INTEGER,
        finalized_at TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_upload_sessions_project ON upload_sessions(project_id, state);
      CREATE INDEX idx_upload_sessions_user ON upload_sessions(user_id, state);
      CREATE INDEX idx_upload_sessions_expiry ON upload_sessions(state, expires_at);

      CREATE TABLE upload_session_items (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mime TEXT NOT NULL,
        last_modified INTEGER,
        sha256 TEXT,
        chunk_size INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL,
        received_chunks INTEGER NOT NULL DEFAULT 0,
        received_bytes INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK (state IN ('pending', 'transferring', 'transferred', 'verified', 'failed', 'skipped')),
        attempts INTEGER NOT NULL DEFAULT 0,
        failure_code TEXT,
        failure_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_upload_items_session ON upload_session_items(session_id, state);

      -- One finalize per session, ever: unique partial index makes duplicate
      -- finalization a database-level impossibility, not just an app check.
      CREATE UNIQUE INDEX idx_upload_sessions_commit
        ON upload_sessions(committed_sha) WHERE committed_sha IS NOT NULL;
    `,
  },
  {
    version: 6,
    sql: `
      -- Fork relationships (GitLab fork-network parity).
      -- forked_from_project_id: the DIRECT upstream of this fork.
      -- fork_network_id: id of the network's ROOT project (the original that
      --   itself has no upstream). Every member carries it, so the whole
      --   network loads with ONE indexed query — no recursive traversal on
      --   page load.
      ALTER TABLE projects ADD COLUMN forked_from_project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
      ALTER TABLE projects ADD COLUMN fork_network_id INTEGER;
      CREATE INDEX idx_projects_fork_network ON projects(fork_network_id);
      CREATE INDEX idx_projects_forked_from ON projects(forked_from_project_id);
    `,
  },
]
