package storage

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"strconv"
	"time"
)

// ErrNotFound is returned by CRUD lookups when the row doesn't exist or
// belongs to another principal. Conflating "missing" and "not yours" is a
// deliberate safety-through-obscurity move: unauthenticated enumeration
// of session IDs never reveals whether an ID is in use.
var ErrNotFound = errors.New("storage: not found")

// defaultSessionLimit is the default number of sessions returned by
// ListSessions when the caller passes limit <= 0.
var defaultSessionLimit = envIntStorage("GITCHAT_DEFAULT_SESSION_LIMIT", 100)

// SessionRow is the DB-facing shape of a chat session.
type SessionRow struct {
	ID           string
	RepoID       string
	Principal    string
	Title        string
	CreatedAt    int64
	UpdatedAt    int64
	MessageCount int
}

// MessageRow is the DB-facing shape of a single chat message.
type MessageRow struct {
	ID            string
	SessionID     string
	Role          string
	Content       string
	Model         string
	TokenCountIn  int
	TokenCountOut int
	CreatedAt     int64
}

// CreateSession inserts a new chat session and returns it.
func (d *DB) CreateSession(ctx context.Context, id, principal, repoID, title string) (*SessionRow, error) {
	now := time.Now().Unix()
	_, err := d.ExecContext(ctx, `
        INSERT INTO chat_session (id, repo_id, principal, title, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
		id, repoID, principal, title, now, now)
	if err != nil {
		return nil, err
	}
	return &SessionRow{
		ID:        id,
		RepoID:    repoID,
		Principal: principal,
		Title:     title,
		CreatedAt: now,
		UpdatedAt: now,
	}, nil
}

// GetSession fetches a session by ID, scoped to the authenticated
// principal. Returns ErrNotFound if the row doesn't exist or belongs to a
// different principal.
func (d *DB) GetSession(ctx context.Context, principal, id string) (*SessionRow, error) {
	row := d.QueryRowContext(ctx, `
        SELECT s.id, s.repo_id, s.principal, s.title, s.created_at, s.updated_at,
               (SELECT COUNT(*) FROM chat_message m WHERE m.session_id = s.id)
        FROM chat_session s
        WHERE s.id = ? AND s.principal = ?`,
		id, principal)
	s := &SessionRow{}
	if err := row.Scan(&s.ID, &s.RepoID, &s.Principal, &s.Title, &s.CreatedAt, &s.UpdatedAt, &s.MessageCount); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return s, nil
}

// ListSessions returns sessions for (principal, repoID), newest first.
// Uses a LEFT JOIN for message count (was N+1 correlated subquery).
// Limit 0 means 100 (default). Offset for pagination.
func (d *DB) ListSessions(ctx context.Context, principal, repoID string, limit, offset int) ([]*SessionRow, error) {
	if limit <= 0 {
		limit = defaultSessionLimit
	}
	rows, err := d.QueryContext(ctx, `
        SELECT s.id, s.repo_id, s.principal, s.title,
               s.created_at, s.updated_at,
               COUNT(m.id) AS msg_count
        FROM chat_session s
        LEFT JOIN chat_message m ON m.session_id = s.id
        WHERE s.principal = ? AND s.repo_id = ?
        GROUP BY s.id
        ORDER BY s.updated_at DESC
        LIMIT ? OFFSET ?`,
		principal, repoID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*SessionRow
	for rows.Next() {
		s := &SessionRow{}
		if err := rows.Scan(&s.ID, &s.RepoID, &s.Principal, &s.Title, &s.CreatedAt, &s.UpdatedAt, &s.MessageCount); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// UpdateSessionTitle replaces the session title and bumps updated_at.
func (d *DB) UpdateSessionTitle(ctx context.Context, id, title string) error {
	_, err := d.ExecContext(ctx, `
        UPDATE chat_session SET title = ?, updated_at = ? WHERE id = ?`,
		title, time.Now().Unix(), id)
	return err
}

// TouchSession bumps updated_at on a session. Called after each new message.
func (d *DB) TouchSession(ctx context.Context, id string) error {
	_, err := d.ExecContext(ctx,
		`UPDATE chat_session SET updated_at = ? WHERE id = ?`,
		time.Now().Unix(), id)
	return err
}

// DeleteSession removes a session (principal-scoped). Messages cascade
// via the foreign key. Returns ErrNotFound if the row didn't exist or
// belongs to a different principal.
func (d *DB) DeleteSession(ctx context.Context, principal, id string) error {
	res, err := d.ExecContext(ctx,
		`DELETE FROM chat_session WHERE id = ? AND principal = ?`,
		id, principal)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// CreateMessage inserts a new chat message.
func (d *DB) CreateMessage(ctx context.Context, m MessageRow) error {
	if m.CreatedAt == 0 {
		m.CreatedAt = time.Now().Unix()
	}
	_, err := d.ExecContext(ctx, `
        INSERT INTO chat_message
            (id, session_id, role, content, model, token_count_in, token_count_out, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		m.ID, m.SessionID, m.Role, m.Content, nullString(m.Model),
		m.TokenCountIn, m.TokenCountOut, m.CreatedAt)
	return err
}

// UpdateMessageContent replaces the body of an existing message (used for
// the assistant turn that streams in over time).
func (d *DB) UpdateMessageContent(ctx context.Context, id, content string, tokIn, tokOut int) error {
	_, err := d.ExecContext(ctx, `
        UPDATE chat_message
        SET content = ?, token_count_in = ?, token_count_out = ?
        WHERE id = ?`,
		content, tokIn, tokOut, id)
	return err
}

// ListMessages returns all messages for a session in chronological order.
//
// Ordering uses SQLite's implicit rowid as the tiebreaker so two
// messages that happen to land in the same unix second still come out
// in insertion order. UUID string ordering (the previous tiebreaker)
// was non-deterministic and caused a flaky test once prompt-build time
// grew enough to push multiple inserts into the same second.
func (d *DB) ListMessages(ctx context.Context, sessionID string) ([]*MessageRow, error) {
	rows, err := d.QueryContext(ctx, `
        SELECT id, session_id, role, content, COALESCE(model, ''),
               token_count_in, token_count_out, created_at
        FROM chat_message
        WHERE session_id = ?
        ORDER BY created_at ASC, rowid ASC`,
		sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*MessageRow
	for rows.Next() {
		m := &MessageRow{}
		if err := rows.Scan(&m.ID, &m.SessionID, &m.Role, &m.Content, &m.Model, &m.TokenCountIn, &m.TokenCountOut, &m.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func nullString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// envIntStorage reads an env var as int, returning def if unset or invalid.
func envIntStorage(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return def
}
