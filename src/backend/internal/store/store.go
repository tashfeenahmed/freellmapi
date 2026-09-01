// Package store persists models, chains, and keys in SQLite (pure-Go driver,
// no cgo) so the binary stays distroless-compatible.
package store

import (
	"database/sql"
	"encoding/json"
	"fmt"

	_ "modernc.org/sqlite"
)

// DB wraps the sqlite handle.
type DB struct{ sql *sql.DB }

// Open creates/opens the sqlite file and runs migrations.
func Open(path string) (*DB, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	if err := db.Ping(); err != nil {
		return nil, err
	}
	if err := migrate(db); err != nil {
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return &DB{sql: db}, nil
}

func migrate(db *sql.DB) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS models (
			id TEXT PRIMARY KEY,
			platform TEXT NOT NULL,
			display_name TEXT,
			intelligence_rank INTEGER DEFAULT 99,
			speed_rank INTEGER DEFAULT 99,
			context_window INTEGER DEFAULT 0,
			supports_vision INTEGER DEFAULT 0,
			supports_tools INTEGER DEFAULT 0,
			enabled INTEGER DEFAULT 1,
			input_price_per_m REAL DEFAULT 0,
			output_price_per_m REAL DEFAULT 0,
			tier TEXT DEFAULT 'B'
		);`,
		`CREATE TABLE IF NOT EXISTS chains (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			tier TEXT NOT NULL,
			type TEXT DEFAULT 'MAIN',
			description TEXT,
			tags TEXT DEFAULT '[]',
			auto_skip_exhausted INTEGER DEFAULT 1,
			metadata TEXT DEFAULT '{}'
		);`,
		`CREATE TABLE IF NOT EXISTS chain_entries (
			chain_id TEXT NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
			model_id TEXT NOT NULL,
			platform TEXT NOT NULL,
			priority INTEGER NOT NULL,
			enabled INTEGER DEFAULT 1,
			is_paid_model INTEGER DEFAULT 0,
			api_key_id TEXT,
			user_preference REAL DEFAULT 0.0,
			is_fallback INTEGER DEFAULT 0,
			model_type TEXT,
			parameters TEXT DEFAULT '{}',
			metadata TEXT DEFAULT '{}'
		);`,
		`CREATE TABLE IF NOT EXISTS keys (
			id INTEGER PRIMARY KEY,
			platform TEXT NOT NULL,
			label TEXT,
			value TEXT,
			enabled INTEGER DEFAULT 1
		);`,
		`CREATE INDEX IF NOT EXISTS idx_models_platform ON models(platform);`,
		`CREATE INDEX IF NOT EXISTS idx_chain_entries ON chain_entries(chain_id, priority);`,
		`CREATE INDEX IF NOT EXISTS idx_chains_type ON chains(type);`,
	}
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			return err
		}
	}
	return nil
}

// ModelRow is one models-table row.
type ModelRow struct {
	ID           string
	Platform     string
	DisplayName  string
	IntRank      int32
	SpeedRank    int32
	ContextWin   int32
	Vision       bool
	Tools        bool
	Enabled      bool
	InputPerM    float64
	OutputPerM   float64
	Tier         string
}

// UpsertModel inserts or updates a model row.
func (d *DB) UpsertModel(m ModelRow) error {
	_, err := d.sql.Exec(`INSERT INTO models
		(id, platform, display_name, intelligence_rank, speed_rank, context_window,
		 supports_vision, supports_tools, enabled, input_price_per_m, output_price_per_m, tier)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET
			platform=excluded.platform, display_name=excluded.display_name,
			intelligence_rank=excluded.intelligence_rank, speed_rank=excluded.speed_rank,
			context_window=excluded.context_window, supports_vision=excluded.supports_vision,
			supports_tools=excluded.supports_tools, enabled=excluded.enabled,
			input_price_per_m=excluded.input_price_per_m, output_price_per_m=excluded.output_price_per_m,
			tier=excluded.tier`,
		m.ID, m.Platform, m.DisplayName, m.IntRank, m.SpeedRank, m.ContextWin,
		b2i(m.Vision), b2i(m.Tools), b2i(m.Enabled), m.InputPerM, m.OutputPerM, m.Tier)
	return err
}

// ListModels returns models, optionally filtered by tier / enabled.
func (d *DB) ListModels(tier string, enabledOnly bool) ([]ModelRow, error) {
	q := `SELECT id, platform, COALESCE(display_name,''), intelligence_rank, speed_rank,
		context_window, supports_vision, supports_tools, enabled,
		input_price_per_m, output_price_per_m, tier FROM models WHERE 1=1`
	var args []any
	if tier != "" {
		q += ` AND tier = ?`
		args = append(args, tier)
	}
	if enabledOnly {
		q += ` AND enabled = 1`
	}
	rows, err := d.sql.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ModelRow
	for rows.Next() {
		var m ModelRow
		var vis, tools, en int
		if err := rows.Scan(&m.ID, &m.Platform, &m.DisplayName, &m.IntRank, &m.SpeedRank,
			&m.ContextWin, &vis, &tools, &en, &m.InputPerM, &m.OutputPerM, &m.Tier); err != nil {
			return nil, err
		}
		m.Vision, m.Tools, m.Enabled = vis == 1, tools == 1, en == 1
		out = append(out, m)
	}
	return out, rows.Err()
}

// ChainRow is a fallback chain with its entries.
type ChainRow struct {
	ID                  string
	Name                string
	Tier                string
	Type                string              // MAIN | FALLBACK | ESCALATION | SPECIALIZED
	Description         string
	Tags                []string
	AutoSkipExhausted   bool
	Metadata            map[string]string
	Entries             []ChainEntryRow
}

type ChainEntryRow struct {
	ModelID          string
	Platform         string
	Priority         int32
	Enabled          bool
	IsPaidModel      bool
	APIKeyID         string
	UserPreference   float64
	IsFallback       bool
	ModelType        string
	Parameters       map[string]string
	Metadata         map[string]string
}

// ListChains loads all chains + entries.
func (d *DB) ListChains() ([]ChainRow, error) {
	rows, err := d.sql.Query(`SELECT id, name, tier, type, description, tags, auto_skip_exhausted, metadata 
		FROM chains ORDER BY tier, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ChainRow
	for rows.Next() {
		var c ChainRow
		var tagsJSON, metaJSON string
		var autoSkip int
		if err := rows.Scan(&c.ID, &c.Name, &c.Tier, &c.Type, &c.Description, &tagsJSON, &autoSkip, &metaJSON); err != nil {
			return nil, err
		}
		c.AutoSkipExhausted = autoSkip == 1
		c.Tags = parseJSONArray(tagsJSON)
		c.Metadata = parseJSONMap(metaJSON)
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		ents, err := d.chainEntries(out[i].ID)
		if err != nil {
			return nil, err
		}
		out[i].Entries = ents
	}
	return out, nil
}

func (d *DB) chainEntries(chainID string) ([]ChainEntryRow, error) {
	rows, err := d.sql.Query(`SELECT model_id, platform, priority, enabled, 
		is_paid_model, api_key_id, user_preference, is_fallback, model_type, parameters, metadata
		FROM chain_entries WHERE chain_id = ? ORDER BY priority`, chainID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ChainEntryRow
	for rows.Next() {
		var e ChainEntryRow
		var en, paid, fallback int
		var paramsJSON, metaJSON string
		if err := rows.Scan(&e.ModelID, &e.Platform, &e.Priority, &en,
			&paid, &e.APIKeyID, &e.UserPreference, &fallback, &e.ModelType, &paramsJSON, &metaJSON); err != nil {
			return nil, err
		}
		e.Enabled = en == 1
		e.IsPaidModel = paid == 1
		e.IsFallback = fallback == 1
		// Parse JSON maps
		e.Parameters = parseJSONMap(paramsJSON)
		e.Metadata = parseJSONMap(metaJSON)
		out = append(out, e)
	}
	return out, rows.Err()
}

// UpsertChain replaces a chain and its entries atomically.
func (d *DB) UpsertChain(c ChainRow) error {
	tx, err := d.sql.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	
	tagsJSON, _ := json.Marshal(c.Tags)
	metaJSON, _ := json.Marshal(c.Metadata)
	
	if _, err := tx.Exec(`INSERT INTO chains (id, name, tier, type, description, tags, auto_skip_exhausted, metadata)
		VALUES (?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET 
			name=excluded.name, tier=excluded.tier, type=excluded.type,
			description=excluded.description, tags=excluded.tags,
			auto_skip_exhausted=excluded.auto_skip_exhausted, metadata=excluded.metadata`,
		c.ID, c.Name, c.Tier, c.Type, c.Description, string(tagsJSON), b2i(c.AutoSkipExhausted), string(metaJSON)); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM chain_entries WHERE chain_id = ?`, c.ID); err != nil {
		return err
	}
	for _, e := range c.Entries {
		paramsJSON, _ := json.Marshal(e.Parameters)
		entryMetaJSON, _ := json.Marshal(e.Metadata)
		if _, err := tx.Exec(`INSERT INTO chain_entries 
			(chain_id, model_id, platform, priority, enabled, is_paid_model, api_key_id, user_preference, is_fallback, model_type, parameters, metadata)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
			c.ID, e.ModelID, e.Platform, e.Priority, b2i(e.Enabled),
			b2i(e.IsPaidModel), e.APIKeyID, e.UserPreference, b2i(e.IsFallback), e.ModelType,
			string(paramsJSON), string(entryMetaJSON)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Keys returns all registered key rows.
func (d *DB) Keys() ([]KeyRow, error) {
	rows, err := d.sql.Query(`SELECT id, platform, COALESCE(label,''), enabled FROM keys ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []KeyRow
	for rows.Next() {
		var k KeyRow
		var en int
		if err := rows.Scan(&k.ID, &k.Platform, &k.Label, &en); err != nil {
			return nil, err
		}
		k.Enabled = en == 1
		out = append(out, k)
	}
	return out, rows.Err()
}

// AddKey inserts a new API key into the SQLite database.
func (d *DB) AddKey(platform, value, label string, enabled bool) (int64, error) {
	res, err := d.sql.Exec(`INSERT INTO keys (platform, value, label, enabled) VALUES (?,?,?,?)`,
		platform, value, label, b2i(enabled))
	if err != nil {
		return 0, err
	}
	id, _ := res.LastInsertId()
	return id, nil
}

type KeyRow struct {
	ID       int64
	Platform string
	Label    string
	Enabled  bool
}

// SeedDefaults inserts the S/A/B auto chains if missing (idempotent).
func (d *DB) SeedDefaults() error {
	for _, tier := range []string{"S", "A", "B"} {
		var one string
		err := d.sql.QueryRow(`SELECT id FROM chains WHERE id = ?`, "auto:"+lower(tier)).Scan(&one)
		if err == sql.ErrNoRows {
			id := "auto:" + lower(tier)
			if err := d.UpsertChain(ChainRow{ID: id, Name: tier + "-Tier", Tier: tier}); err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
	}
	return nil
}

func lower(s string) string {
	b := []byte(s)
	for i := range b {
		if b[i] >= 'A' && b[i] <= 'Z' {
			b[i] += 32
		}
	}
	return string(b)
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

// Close closes the DB.
func (d *DB) Close() error { return d.sql.Close() }

func parseJSONMap(s string) map[string]string {
	if s == "" || s == "{}" {
		return map[string]string{}
	}
	var m map[string]string
	_ = json.Unmarshal([]byte(s), &m)
	if m == nil {
		return map[string]string{}
	}
	return m
}

func parseJSONArray(s string) []string {
	if s == "" || s == "[]" {
		return []string{}
	}
	var a []string
	_ = json.Unmarshal([]byte(s), &a)
	if a == nil {
		return []string{}
	}
	return a
}

// ChainByID loads a single chain by ID.
func (d *DB) ChainByID(id string) (ChainRow, error) {
	var c ChainRow
	var tagsJSON, metaJSON string
	var autoSkip int
	err := d.sql.QueryRow(`SELECT id, name, tier, type, description, tags, auto_skip_exhausted, metadata 
		FROM chains WHERE id = ?`, id).Scan(&c.ID, &c.Name, &c.Tier, &c.Type, &c.Description, &tagsJSON, &autoSkip, &metaJSON)
	if err != nil {
		return ChainRow{}, err
	}
	c.AutoSkipExhausted = autoSkip == 1
	c.Tags = parseJSONArray(tagsJSON)
	c.Metadata = parseJSONMap(metaJSON)
	ents, err := d.chainEntries(c.ID)
	if err != nil {
		return ChainRow{}, err
	}
	c.Entries = ents
	return c, nil
}

// ChainByTier loads a single chain by tier.
func (d *DB) ChainByTier(tier string) (ChainRow, error) {
	var c ChainRow
	var tagsJSON, metaJSON string
	var autoSkip int
	err := d.sql.QueryRow(`SELECT id, name, tier, type, description, tags, auto_skip_exhausted, metadata 
		FROM chains WHERE lower(tier) = lower(?) LIMIT 1`, tier).Scan(&c.ID, &c.Name, &c.Tier, &c.Type, &c.Description, &tagsJSON, &autoSkip, &metaJSON)
	if err != nil {
		return ChainRow{}, err
	}
	c.AutoSkipExhausted = autoSkip == 1
	c.Tags = parseJSONArray(tagsJSON)
	c.Metadata = parseJSONMap(metaJSON)
	ents, err := d.chainEntries(c.ID)
	if err != nil {
		return ChainRow{}, err
	}
	c.Entries = ents
	return c, nil
}

// ModelByIDPlatform loads a single model row by ID and platform.
func (d *DB) ModelByIDPlatform(modelID, platform string) (ModelRow, error) {
	q := `SELECT id, platform, COALESCE(display_name,''), intelligence_rank, speed_rank,
		context_window, supports_vision, supports_tools, enabled,
		input_price_per_m, output_price_per_m, tier FROM models WHERE id = ? AND platform = ?`
	var m ModelRow
	var vis, tools, en int
	err := d.sql.QueryRow(q, modelID, platform).Scan(&m.ID, &m.Platform, &m.DisplayName, &m.IntRank, &m.SpeedRank,
		&m.ContextWin, &vis, &tools, &en, &m.InputPerM, &m.OutputPerM, &m.Tier)
	if err != nil {
		return ModelRow{}, err
	}
	m.Vision, m.Tools, m.Enabled = vis == 1, tools == 1, en == 1
	return m, nil
}
