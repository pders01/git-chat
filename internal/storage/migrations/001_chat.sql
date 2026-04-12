-- 001_chat.sql — initial schema for M3 chat persistence.
-- FTS5 tables for similarity matching arrive in M5 alongside the KB.

CREATE TABLE chat_session (
    id         TEXT PRIMARY KEY,
    repo_id    TEXT NOT NULL,
    principal  TEXT NOT NULL,
    title      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX idx_chat_session_principal_repo
    ON chat_session(principal, repo_id);

CREATE INDEX idx_chat_session_updated
    ON chat_session(updated_at DESC);

CREATE TABLE chat_message (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES chat_session(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content         TEXT NOT NULL,
    model           TEXT,
    token_count_in  INTEGER NOT NULL DEFAULT 0,
    token_count_out INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL
);

CREATE INDEX idx_chat_message_session
    ON chat_message(session_id, created_at);
