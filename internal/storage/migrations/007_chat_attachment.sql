-- 007_chat_attachment.sql — binary attachments for chat user turns.

CREATE TABLE chat_attachment (
    id          TEXT PRIMARY KEY,
    message_id  TEXT NOT NULL REFERENCES chat_message(id) ON DELETE CASCADE,
    mime_type   TEXT NOT NULL,
    filename    TEXT NOT NULL,
    size        INTEGER NOT NULL,
    data        BLOB NOT NULL,
    created_at  INTEGER NOT NULL
);

CREATE INDEX idx_chat_attachment_message
    ON chat_attachment(message_id);
