-- 002_kb.sql — knowledge card schema for M5.
--
-- Every LLM answer is cached as a card keyed by (repo_id, normalized
-- question). Subsequent identical questions hit the cache (fast path,
-- no LLM call). Each card records the HEAD commit it was derived at
-- and the blob SHAs of every file that contributed to the answer.
-- When any provenance blob changes, the card is invalidated and the
-- next query falls through to the LLM, which re-derives the answer.
--
-- FTS5 fuzzy matching lands in M5.1; M5.0 uses exact-match on
-- question_normalized.

CREATE TABLE IF NOT EXISTS kb_card (
    id                    TEXT PRIMARY KEY,
    repo_id               TEXT NOT NULL,
    question_normalized   TEXT NOT NULL,    -- lowercase, trimmed, collapsed ws
    answer_md             TEXT NOT NULL,    -- frozen LLM answer
    model                 TEXT NOT NULL,    -- which model produced it
    hit_count             INTEGER NOT NULL DEFAULT 0,
    created_commit        TEXT NOT NULL,    -- HEAD SHA when card was derived
    last_verified_commit  TEXT NOT NULL,    -- SHA at most recent validation
    invalidated_at        INTEGER,          -- NULL = currently valid
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_card_repo_question
    ON kb_card(repo_id, question_normalized);

CREATE TABLE IF NOT EXISTS kb_card_provenance (
    card_id   TEXT NOT NULL REFERENCES kb_card(id) ON DELETE CASCADE,
    path      TEXT NOT NULL,
    blob_sha  TEXT NOT NULL,    -- git blob SHA at time of card derivation
    PRIMARY KEY (card_id, path)
);

CREATE INDEX IF NOT EXISTS idx_kb_provenance_path
    ON kb_card_provenance(path);
