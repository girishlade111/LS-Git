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
]
