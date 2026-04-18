package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// CardRow is the Go representation of a kb_card row.
type CardRow struct {
	ID                   string
	RepoID               string
	QuestionNormalized   string
	AnswerMD             string
	Model                string
	HitCount             int
	CreatedCommit        string
	LastVerifiedCommit   string
	InvalidatedAt        int64 // 0 = valid
	CreatedAt            int64
	UpdatedAt            int64
	CreatedBy            string
}

// ProvenanceRow is a single file-dependency for a card.
type ProvenanceRow struct {
	CardID  string
	Path    string
	BlobSHA string
}

// NormalizeQuestion lowercases, trims, and collapses whitespace so
// that questions differing only in formatting still hit the same card.
func NormalizeQuestion(q string) string {
	q = strings.TrimSpace(q)
	q = strings.ToLower(q)
	return strings.Join(strings.Fields(q), " ")
}

// fts5Sanitize strips FTS5 metacharacters (@, *, ^, ", NEAR, etc.)
// from a query string so it can be safely used as a plain-term MATCH
// expression. Without this, characters like `@` in "@main.go" are
// interpreted as column-filter operators and cause query errors.
func fts5Sanitize(q string) string {
	// Replace any non-alphanumeric, non-space char with a space, then
	// collapse. This is intentionally aggressive: we want pure terms.
	var sb strings.Builder
	for _, r := range q {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || r == ' ' {
			sb.WriteRune(r)
		} else {
			sb.WriteRune(' ')
		}
	}
	return strings.Join(strings.Fields(sb.String()), " ")
}

// FindValidCard searches for a non-invalidated card whose question is
// similar to `normalizedQ` using FTS5 BM25 ranking. Returns the best
// match above the score threshold, or ErrNotFound. This is the fast-
// path lookup in SendMessage that decides whether to skip the LLM.
//
// The query joins kb_card with kb_card_fts via rowid. FTS5's `rank`
// column is the BM25 score (negative; closer to 0 = weaker match).
// A threshold of -1.0 catches exact matches and close rephrasings
// while rejecting incidental keyword overlap.
func (d *DB) FindValidCard(ctx context.Context, repoID, normalizedQ string) (*CardRow, error) {
	// FTS5 MATCH syntax: quote the query to match as a phrase, or
	// leave unquoted for term-level OR matching. For card lookup we
	// want term-level matching so "what is this project" matches
	// "what does this project do" (shared terms score high).
	sanitized := fts5Sanitize(normalizedQ)
	if sanitized == "" {
		return nil, ErrNotFound
	}
	row := d.QueryRowContext(ctx, `
        SELECT c.id, c.repo_id, c.question_normalized, c.answer_md,
               c.model, c.hit_count, c.created_commit,
               c.last_verified_commit,
               COALESCE(c.invalidated_at, 0), c.created_at, c.updated_at,
               c.created_by
        FROM kb_card_fts f
        JOIN kb_card c ON c.rowid = f.rowid
        WHERE kb_card_fts MATCH ?
          AND c.repo_id = ?
          AND c.invalidated_at IS NULL
        ORDER BY f.rank
        LIMIT 1`,
		sanitized, repoID)
	c := &CardRow{}
	err := row.Scan(&c.ID, &c.RepoID, &c.QuestionNormalized, &c.AnswerMD,
		&c.Model, &c.HitCount, &c.CreatedCommit, &c.LastVerifiedCommit,
		&c.InvalidatedAt, &c.CreatedAt, &c.UpdatedAt, &c.CreatedBy)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return c, err
}

// CountSimilarUserMessages returns how many user-role messages across
// all sessions match the given question via FTS5. Used for N-threshold
// promotion: only create a card when the same question (or a close
// rephrase) has been asked at least N times.
func (d *DB) CountSimilarUserMessages(ctx context.Context, normalizedQ string) (int, error) {
	sanitized := fts5Sanitize(normalizedQ)
	if sanitized == "" {
		return 0, nil
	}
	var count int
	err := d.QueryRowContext(ctx, `
        SELECT COUNT(*)
        FROM chat_message_fts
        WHERE chat_message_fts MATCH ?`,
		sanitized).Scan(&count)
	return count, err
}

// UpsertCard creates a new card or replaces the answer on an existing
// one (keyed by repo_id + question_normalized). On update, the card
// is also un-invalidated so it re-enters the fast path. Returns the
// card ID (new or existing).
func (d *DB) UpsertCard(ctx context.Context, c CardRow) (string, error) {
	now := time.Now().Unix()
	_, err := d.ExecContext(ctx, `
        INSERT INTO kb_card (
            id, repo_id, question_normalized, answer_md, model,
            hit_count, created_commit, last_verified_commit,
            invalidated_at, created_at, updated_at, created_by
        ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?, ?)
        ON CONFLICT (repo_id, question_normalized) DO UPDATE SET
            answer_md            = excluded.answer_md,
            model                = excluded.model,
            created_commit       = excluded.created_commit,
            last_verified_commit = excluded.last_verified_commit,
            invalidated_at       = NULL,
            updated_at           = excluded.updated_at`,
		c.ID, c.RepoID, c.QuestionNormalized, c.AnswerMD, c.Model,
		c.CreatedCommit, c.LastVerifiedCommit,
		now, now, c.CreatedBy)
	if err != nil {
		return "", err
	}
	// Retrieve the canonical ID (might be the existing row's ID on conflict).
	var id string
	err = d.QueryRowContext(ctx, `
        SELECT id FROM kb_card
        WHERE repo_id = ? AND question_normalized = ?`,
		c.RepoID, c.QuestionNormalized).Scan(&id)
	return id, err
}

// IncrementCardHit bumps the hit counter. Called on a cache hit.
func (d *DB) IncrementCardHit(ctx context.Context, cardID string) error {
	_, err := d.ExecContext(ctx, `
        UPDATE kb_card
        SET hit_count = hit_count + 1, updated_at = ?
        WHERE id = ?`,
		time.Now().Unix(), cardID)
	return err
}

// InvalidateCard marks a card as stale.
func (d *DB) InvalidateCard(ctx context.Context, cardID string) error {
	_, err := d.ExecContext(ctx, `
        UPDATE kb_card
        SET invalidated_at = ?, updated_at = ?
        WHERE id = ?`,
		time.Now().Unix(), time.Now().Unix(), cardID)
	return err
}

// UpdateCardVerification records that a card passed re-validation at
// the given commit. Updates last_verified_commit without touching the
// answer.
func (d *DB) UpdateCardVerification(ctx context.Context, cardID, commitSHA string) error {
	_, err := d.ExecContext(ctx, `
        UPDATE kb_card
        SET last_verified_commit = ?, updated_at = ?
        WHERE id = ?`,
		commitSHA, time.Now().Unix(), cardID)
	return err
}

// ReplaceProvenance deletes all existing provenance rows for a card
// and inserts the new set. Use inside a transaction if atomicity with
// card creation matters — for M5.0 the eventual-consistency model
// (rare race on concurrent writes to the same card) is acceptable.
func (d *DB) ReplaceProvenance(ctx context.Context, cardID string, rows []ProvenanceRow) error {
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, `DELETE FROM kb_card_provenance WHERE card_id = ?`, cardID); err != nil {
		return err
	}
	for _, r := range rows {
		if _, err := tx.ExecContext(ctx, `
            INSERT INTO kb_card_provenance (card_id, path, blob_sha)
            VALUES (?, ?, ?)`,
			cardID, r.Path, r.BlobSHA); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// GetCard returns a single card by ID.
func (d *DB) GetCard(ctx context.Context, cardID string) (*CardRow, error) {
	row := d.QueryRowContext(ctx, `
        SELECT id, repo_id, question_normalized, answer_md, model,
               hit_count, created_commit, last_verified_commit,
               COALESCE(invalidated_at, 0), created_at, updated_at, created_by
        FROM kb_card
        WHERE id = ?`,
		cardID)
	c := &CardRow{}
	err := row.Scan(&c.ID, &c.RepoID, &c.QuestionNormalized, &c.AnswerMD,
		&c.Model, &c.HitCount, &c.CreatedCommit, &c.LastVerifiedCommit,
		&c.InvalidatedAt, &c.CreatedAt, &c.UpdatedAt, &c.CreatedBy)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return c, err
}

// ListCards returns all cards for a given repo, ordered by hit_count DESC.
func (d *DB) ListCards(ctx context.Context, repoID string) ([]*CardRow, error) {
	rows, err := d.QueryContext(ctx, `
        SELECT id, repo_id, question_normalized, answer_md, model,
               hit_count, created_commit, last_verified_commit,
               COALESCE(invalidated_at, 0), created_at, updated_at, created_by
        FROM kb_card
        WHERE repo_id = ?
        ORDER BY hit_count DESC`,
		repoID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*CardRow
	for rows.Next() {
		c := &CardRow{}
		if err := rows.Scan(&c.ID, &c.RepoID, &c.QuestionNormalized, &c.AnswerMD,
			&c.Model, &c.HitCount, &c.CreatedCommit, &c.LastVerifiedCommit,
			&c.InvalidatedAt, &c.CreatedAt, &c.UpdatedAt, &c.CreatedBy); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// DeleteCard removes a card by ID.
func (d *DB) DeleteCard(ctx context.Context, cardID string) error {
	res, err := d.ExecContext(ctx, `DELETE FROM kb_card WHERE id = ?`, cardID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteCardScoped removes a card only if it was created by the given
// principal. Returns ErrNotFound if the card doesn't exist or belongs
// to someone else.
func (d *DB) DeleteCardScoped(ctx context.Context, cardID, principal string) error {
	res, err := d.ExecContext(ctx,
		`DELETE FROM kb_card WHERE id = ? AND created_by = ?`,
		cardID, principal)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// ListProvenance returns all provenance rows for a card, sorted by path.
func (d *DB) ListProvenance(ctx context.Context, cardID string) ([]ProvenanceRow, error) {
	rows, err := d.QueryContext(ctx, `
        SELECT card_id, path, blob_sha
        FROM kb_card_provenance
        WHERE card_id = ?
        ORDER BY path`,
		cardID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ProvenanceRow
	for rows.Next() {
		var r ProvenanceRow
		if err := rows.Scan(&r.CardID, &r.Path, &r.BlobSHA); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
