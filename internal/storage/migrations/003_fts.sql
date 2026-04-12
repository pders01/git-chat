-- 003_fts.sql — FTS5 indexes for fuzzy card lookup and cross-session
-- question similarity. Both use content-sync mode so the FTS index
-- stays in lockstep with the source table without manual triggers.
--
-- BM25 scoring in FTS5 is built-in: queries use
--   SELECT ... FROM fts_table WHERE fts_table MATCH ? ORDER BY rank
-- where `rank` is the BM25 score (lower = better match).

-- FTS5 over knowledge cards. Lets FindValidCard match rephrased
-- questions like "What is this project?" ≈ "What does this project do?"
-- via term overlap rather than exact string equality.
CREATE VIRTUAL TABLE IF NOT EXISTS kb_card_fts USING fts5(
    question_normalized,
    content='kb_card',
    content_rowid='rowid'
);

-- Triggers to keep the FTS index in sync with kb_card.
CREATE TRIGGER IF NOT EXISTS kb_card_fts_ai AFTER INSERT ON kb_card BEGIN
    INSERT INTO kb_card_fts(rowid, question_normalized)
    VALUES (new.rowid, new.question_normalized);
END;

CREATE TRIGGER IF NOT EXISTS kb_card_fts_ad AFTER DELETE ON kb_card BEGIN
    INSERT INTO kb_card_fts(kb_card_fts, rowid, question_normalized)
    VALUES ('delete', old.rowid, old.question_normalized);
END;

CREATE TRIGGER IF NOT EXISTS kb_card_fts_au AFTER UPDATE ON kb_card BEGIN
    INSERT INTO kb_card_fts(kb_card_fts, rowid, question_normalized)
    VALUES ('delete', old.rowid, old.question_normalized);
    INSERT INTO kb_card_fts(rowid, question_normalized)
    VALUES (new.rowid, new.question_normalized);
END;

-- FTS5 over chat messages (user role only). Used for cross-session
-- similarity counting: "has this question been asked N times before?"
-- to support N-threshold promotion in M5.1.
CREATE VIRTUAL TABLE IF NOT EXISTS chat_message_fts USING fts5(
    content_text,
    content='chat_message',
    content_rowid='rowid'
);

-- Only index user messages (not assistant replies) — we're matching
-- question similarity, not answer similarity. The trigger filters on
-- role = 'user'.
CREATE TRIGGER IF NOT EXISTS chat_message_fts_ai AFTER INSERT ON chat_message
WHEN new.role = 'user' BEGIN
    INSERT INTO chat_message_fts(rowid, content_text)
    VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS chat_message_fts_ad AFTER DELETE ON chat_message
WHEN old.role = 'user' BEGIN
    INSERT INTO chat_message_fts(chat_message_fts, rowid, content_text)
    VALUES ('delete', old.rowid, old.content);
END;
