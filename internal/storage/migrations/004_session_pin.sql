-- 004_session_pin.sql — add pinned column for session pinning/starring.
ALTER TABLE chat_session ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
