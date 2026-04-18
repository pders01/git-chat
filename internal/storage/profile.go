package storage

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// LLMProfile is a saved LLM configuration preset.
type LLMProfile struct {
	ID          string
	Name        string
	Backend     string
	BaseURL     string
	Model       string
	APIKey      string // plaintext in memory; caller encrypts before save
	Temperature string
	MaxTokens   string
	CreatedAt   int64
	UpdatedAt   int64
}

// ListProfiles returns all saved profiles ordered by name.
func (d *DB) ListProfiles(ctx context.Context) ([]LLMProfile, error) {
	rows, err := d.QueryContext(ctx, `
		SELECT id, name, backend, base_url, model, api_key,
		       temperature, max_tokens, created_at, updated_at
		FROM llm_profile
		ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []LLMProfile
	for rows.Next() {
		var p LLMProfile
		if err := rows.Scan(&p.ID, &p.Name, &p.Backend, &p.BaseURL,
			&p.Model, &p.APIKey, &p.Temperature, &p.MaxTokens,
			&p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// GetProfile returns a single profile by ID.
func (d *DB) GetProfile(ctx context.Context, id string) (LLMProfile, error) {
	var p LLMProfile
	err := d.QueryRowContext(ctx, `
		SELECT id, name, backend, base_url, model, api_key,
		       temperature, max_tokens, created_at, updated_at
		FROM llm_profile WHERE id = ?`, id).
		Scan(&p.ID, &p.Name, &p.Backend, &p.BaseURL,
			&p.Model, &p.APIKey, &p.Temperature, &p.MaxTokens,
			&p.CreatedAt, &p.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return p, ErrNotFound
	}
	return p, err
}

// SaveProfile upserts a profile. The caller is responsible for
// encrypting the API key before calling this method.
func (d *DB) SaveProfile(ctx context.Context, p LLMProfile) error {
	now := time.Now().Unix()
	_, err := d.ExecContext(ctx, `
		INSERT INTO llm_profile (id, name, backend, base_url, model, api_key,
		                         temperature, max_tokens, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			name = excluded.name,
			backend = excluded.backend,
			base_url = excluded.base_url,
			model = excluded.model,
			api_key = excluded.api_key,
			temperature = excluded.temperature,
			max_tokens = excluded.max_tokens,
			updated_at = excluded.updated_at`,
		p.ID, p.Name, p.Backend, p.BaseURL, p.Model, p.APIKey,
		p.Temperature, p.MaxTokens, now, now)
	return err
}

// DeleteProfile removes a profile by ID.
func (d *DB) DeleteProfile(ctx context.Context, id string) error {
	res, err := d.ExecContext(ctx, `DELETE FROM llm_profile WHERE id = ?`, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}
