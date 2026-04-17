-- 008_chat_tool_event.sql — persisted agentic tool call + result pairs.

CREATE TABLE chat_tool_event (
    id             TEXT PRIMARY KEY,
    message_id     TEXT NOT NULL REFERENCES chat_message(id) ON DELETE CASCADE,
    tool_call_id   TEXT NOT NULL,
    name           TEXT NOT NULL,
    args_json      TEXT NOT NULL,
    result_content TEXT NOT NULL DEFAULT '',
    is_error       INTEGER NOT NULL DEFAULT 0,
    ordinal        INTEGER NOT NULL,
    created_at     INTEGER NOT NULL
);

CREATE INDEX idx_chat_tool_event_message
    ON chat_tool_event(message_id, ordinal);
