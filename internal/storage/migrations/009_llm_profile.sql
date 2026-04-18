CREATE TABLE IF NOT EXISTS llm_profile (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  backend     TEXT NOT NULL DEFAULT 'openai',
  base_url    TEXT NOT NULL DEFAULT '',
  model       TEXT NOT NULL DEFAULT '',
  api_key     TEXT NOT NULL DEFAULT '',
  temperature TEXT NOT NULL DEFAULT '',
  max_tokens  TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
