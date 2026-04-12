package storage

import (
	"context"
)

// SearchResult is a unified search hit from any source.
type SearchResult struct {
	Source string // "card", "message", "commit", "file"
	ID     string
	Title  string
	Body   string // excerpt or preview
	Score  float64
}

// SearchCards searches KB cards via FTS5.
func (d *DB) SearchCards(ctx context.Context, query string, limit int) ([]SearchResult, error) {
	if limit <= 0 {
		limit = 10
	}
	sanitized := fts5Sanitize(query)
	if sanitized == "" {
		return nil, nil
	}
	rows, err := d.QueryContext(ctx, `
        SELECT c.id, c.question_normalized, c.answer_md, f.rank
        FROM kb_card_fts f
        JOIN kb_card c ON c.rowid = f.rowid
        WHERE kb_card_fts MATCH ?
          AND c.invalidated_at IS NULL
        ORDER BY f.rank
        LIMIT ?`,
		sanitized, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SearchResult
	for rows.Next() {
		var r SearchResult
		var answer string
		var rank float64
		if err := rows.Scan(&r.ID, &r.Title, &answer, &rank); err != nil {
			return nil, err
		}
		r.Source = "card"
		r.Score = -rank
		if len(answer) > 200 {
			r.Body = answer[:200] + "…"
		} else {
			r.Body = answer
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// SearchMessages searches chat messages via FTS5.
func (d *DB) SearchMessages(ctx context.Context, query, principal string, limit int) ([]SearchResult, error) {
	if limit <= 0 {
		limit = 10
	}
	sanitized := fts5Sanitize(query)
	if sanitized == "" {
		return nil, nil
	}
	rows, err := d.QueryContext(ctx, `
        SELECT m.id, m.content, m.session_id, COALESCE(s.title, m.session_id)
        FROM chat_message_fts f
        JOIN chat_message m ON m.rowid = f.rowid
        JOIN chat_session s ON s.id = m.session_id
        WHERE chat_message_fts MATCH ? AND s.principal = ?
        ORDER BY f.rank
        LIMIT ?`,
		sanitized, principal, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SearchResult
	for rows.Next() {
		var r SearchResult
		var content, messageID, sessionID, title string
		if err := rows.Scan(&messageID, &content, &sessionID, &title); err != nil {
			return nil, err
		}
		r.Source = "message"
		r.ID = sessionID
		r.Title = title
		if len(content) > 200 {
			r.Body = content[:200] + "…"
		} else {
			r.Body = content
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
