// Package store persists models, chains, and keys in PostgreSQL (pure-Go driver,
// no cgo) so the binary stays distroless-compatible.
package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// DB wraps the postgres handle.
type DB struct{ sql *sql.DB }

// Open creates/opens the postgres connection and runs migrations.
// connStr: "postgres://jimesh:jimesh_secure_pass@postgres:5432/jimesh?sslmode=disable"
func Open(connStr string) (*DB, error) {
	if connStr == "" || !strings.HasPrefix(connStr, "postgres://") {
		// Fallback for tests or unconfigured envs
		connStr = "postgres://jimesh:jimesh_secure_pass@localhost:5432/jimesh?sslmode=disable"
	}
	db, err := sql.Open("pgx", connStr)
	if err != nil {
		return nil, err
	}
	if err := db.Ping(); err != nil {
		return nil, err
	}
	d := &DB{sql: db}
	if err := d.migrate(); err != nil {
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return d, nil
}

// toPostgresSQL sequentially translates '?' placeholders to Postgres '$1, $2'
// parameters, protecting against index mismatches and keeping SQLite-ported
// queries 100% standard-compliant.
func toPostgresSQL(query string) string {
	var b strings.Builder
	paramIdx := 1
	for i := 0; i < len(query); i++ {
		if query[i] == '?' {
			b.WriteString(fmt.Sprintf("$%d", paramIdx))
			paramIdx++
		} else {
			b.WriteByte(query[i])
		}
	}
	return b.String()
}

func (d *DB) exec(query string, args ...any) (sql.Result, error) {
	return d.sql.Exec(toPostgresSQL(query), args...)
}

func (d *DB) query(query string, args ...any) (*sql.Rows, error) {
	return d.sql.Query(toPostgresSQL(query), args...)
}

func (d *DB) queryRow(query string, args ...any) *sql.Row {
	return d.sql.QueryRow(toPostgresSQL(query), args...)
}

// columnExists checks if a column exists in a given table.
func (d *DB) columnExists(table, column string) bool {
	var count int
	err := d.sql.QueryRow(`SELECT count(*) FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, table, column).Scan(&count)
	return err == nil && count > 0
}

func (d *DB) migrate() error {
	// Attempt to add is_paid_model to existing models table safely
	if !d.columnExists("models", "is_paid_model") {
		_, _ = d.exec(`ALTER TABLE models ADD COLUMN is_paid_model INTEGER DEFAULT 0`)
	}
	// Attempt to add is_paid to existing keys table safely
	if !d.columnExists("keys", "is_paid") {
		_, _ = d.exec(`ALTER TABLE keys ADD COLUMN is_paid INTEGER DEFAULT 0`)
	}
	// Attempt to add model_scope to existing keys table safely
	if !d.columnExists("keys", "model_scope") {
		_, _ = d.exec(`ALTER TABLE keys ADD COLUMN model_scope TEXT`)
	}

	// Attempt to add chain-specific routing columns to existing chains table safely
	if !d.columnExists("chains", "strategy") {
		_, _ = d.exec(`ALTER TABLE chains ADD COLUMN strategy TEXT DEFAULT 'balanced'`)
	}
	if !d.columnExists("chains", "weight_reliability") {
		_, _ = d.exec(`ALTER TABLE chains ADD COLUMN weight_reliability REAL DEFAULT 0.5`)
	}
	if !d.columnExists("chains", "weight_speed") {
		_, _ = d.exec(`ALTER TABLE chains ADD COLUMN weight_speed REAL DEFAULT 0.25`)
	}
	if !d.columnExists("chains", "weight_intelligence") {
		_, _ = d.exec(`ALTER TABLE chains ADD COLUMN weight_intelligence REAL DEFAULT 0.25`)
	}
	if !d.columnExists("chains", "key_selection") {
		_, _ = d.exec(`ALTER TABLE chains ADD COLUMN key_selection TEXT DEFAULT 'auto'`)
	}
	if !d.columnExists("chains", "explore_enabled") {
		_, _ = d.exec(`ALTER TABLE chains ADD COLUMN explore_enabled INTEGER DEFAULT 0`)
	}
	if !d.columnExists("chains", "peak_adjust") {
		_, _ = d.exec(`ALTER TABLE chains ADD COLUMN peak_adjust INTEGER DEFAULT 0`)
	}

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
			tier TEXT DEFAULT 'B',
			is_paid_model INTEGER DEFAULT 0
		);`,
		`CREATE TABLE IF NOT EXISTS chains (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			tier TEXT NOT NULL,
			type TEXT DEFAULT 'MAIN',
			description TEXT,
			tags TEXT DEFAULT '[]',
			auto_skip_exhausted INTEGER DEFAULT 1,
			metadata TEXT DEFAULT '{}',
			strategy TEXT DEFAULT 'balanced',
			weight_reliability REAL DEFAULT 0.5,
			weight_speed REAL DEFAULT 0.25,
			weight_intelligence REAL DEFAULT 0.25,
			key_selection TEXT DEFAULT 'auto',
			explore_enabled INTEGER DEFAULT 0,
			peak_adjust INTEGER DEFAULT 0
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
			enabled INTEGER DEFAULT 1,
			is_paid INTEGER DEFAULT 0,
			model_scope TEXT
		);`,
		`CREATE TABLE IF NOT EXISTS settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);`,
		`CREATE TABLE IF NOT EXISTS agent_types (
			id TEXT PRIMARY KEY,
			label TEXT NOT NULL,
			description TEXT,
			default_tags TEXT DEFAULT '[]',
			default_fallback_chain TEXT DEFAULT '[]'
		);`,
		`CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			agent_type_id TEXT,
			metadata TEXT DEFAULT '{}',
			tags TEXT DEFAULT '[]',
			created_at TEXT DEFAULT CURRENT_TIMESTAMP
		);`,
		`CREATE TABLE IF NOT EXISTS chain_nodes (
			id TEXT PRIMARY KEY,
			chain_id TEXT NOT NULL REFERENCES chains(id) ON DELETE CASCADE,
			type TEXT NOT NULL,
			priority INTEGER NOT NULL,
			enabled INTEGER DEFAULT 1,
			static_model_id TEXT,
			static_platform TEXT,
			static_api_key_id TEXT,
			static_self_retry INTEGER DEFAULT 0,
			target_chain_id TEXT
		);`,
		`CREATE TABLE IF NOT EXISTS container_strategies (
			node_id TEXT PRIMARY KEY REFERENCES chain_nodes(id) ON DELETE CASCADE,
			strategy TEXT DEFAULT 'balanced',
			weight_reliability REAL DEFAULT 0.5,
			weight_speed REAL DEFAULT 0.25,
			weight_intelligence REAL DEFAULT 0.25,
			key_selection TEXT DEFAULT 'auto',
			explore_enabled INTEGER DEFAULT 0,
			peak_adjust INTEGER DEFAULT 0
		);`,
		`CREATE TABLE IF NOT EXISTS container_members (
			node_id TEXT NOT NULL REFERENCES chain_nodes(id) ON DELETE CASCADE,
			model_id TEXT NOT NULL,
			platform TEXT NOT NULL,
			enabled INTEGER DEFAULT 1,
			is_paid_model INTEGER DEFAULT 0,
			api_key_id TEXT,
			user_preference REAL DEFAULT 0.0,
			self_retry INTEGER DEFAULT 0,
			PRIMARY KEY (node_id, model_id, platform)
		);`,
		`CREATE INDEX IF NOT EXISTS idx_models_platform ON models(platform);`,
		`CREATE INDEX IF NOT EXISTS idx_chain_entries ON chain_entries(chain_id, priority);`,
		`CREATE INDEX IF NOT EXISTS idx_chains_type ON chains(type);`,
		`CREATE INDEX IF NOT EXISTS idx_chain_nodes ON chain_nodes(chain_id, priority);`,
		`CREATE INDEX IF NOT EXISTS idx_container_members ON container_members(node_id);`,
		// ---- Quota tracking (Sprint 6, ported from FreeLLMAPI provider-quota) ----
		`CREATE TABLE IF NOT EXISTS quota_state (
			platform TEXT NOT NULL,
			key_id INTEGER NOT NULL DEFAULT 0,
			quota_pool_key TEXT NOT NULL,
			metric TEXT NOT NULL,
			limit_value INTEGER,
			remaining_value INTEGER,
			reset_at TEXT,
			reset_strategy TEXT DEFAULT 'unknown',
			source TEXT,
			confidence REAL DEFAULT 0,
			notes TEXT,
			observed_at TEXT,
			updated_at TEXT,
			PRIMARY KEY (platform, key_id, quota_pool_key, metric)
		);`,
		`CREATE TABLE IF NOT EXISTS quota_observations (
			id TEXT PRIMARY KEY,
			platform TEXT NOT NULL,
			key_id INTEGER NOT NULL,
			model_id TEXT,
			quota_pool_key TEXT NOT NULL,
			metric TEXT NOT NULL,
			status_code INTEGER,
			limit_value INTEGER,
			remaining_value INTEGER,
			reset_at TEXT,
			retry_after_ms INTEGER,
			reset_strategy TEXT,
			source TEXT,
			confidence REAL,
			notes TEXT,
			endpoint TEXT,
			observed_at TEXT,
			created_at TEXT
		);`,
		`CREATE INDEX IF NOT EXISTS idx_quota_obs_platform ON quota_observations(platform, created_at);`,
		`CREATE INDEX IF NOT EXISTS idx_quota_state_platform ON quota_state(platform);`,
		// ---- Projects & Container deployment persistence (Sprint 8, Postgres logical replication) ----
		`CREATE TABLE IF NOT EXISTS projects (
			id VARCHAR(64) PRIMARY KEY,
			name VARCHAR(255) NOT NULL,
			status VARCHAR(64),
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		);`,
		`CREATE TABLE IF NOT EXISTS containers (
			id VARCHAR(64) PRIMARY KEY,
			project_id VARCHAR(64) REFERENCES projects(id) ON DELETE CASCADE,
			container_id VARCHAR(128) NOT NULL,
			name VARCHAR(255),
			status VARCHAR(64)
		);`,
		`CREATE INDEX IF NOT EXISTS idx_containers_project ON containers(project_id);`,
	}
	for _, s := range stmts {
		if _, err := d.exec(s); err != nil {
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
	IsPaidModel  bool
}

// UpsertModel inserts or updates a model row.
func (d *DB) UpsertModel(m ModelRow) error {
	_, err := d.exec(`INSERT INTO models
		(id, platform, display_name, intelligence_rank, speed_rank, context_window,
		 supports_vision, supports_tools, enabled, input_price_per_m, output_price_per_m, tier, is_paid_model)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET
			platform=excluded.platform, display_name=excluded.display_name,
			intelligence_rank=excluded.intelligence_rank, speed_rank=excluded.speed_rank,
			context_window=excluded.context_window, supports_vision=excluded.supports_vision,
			supports_tools=excluded.supports_tools, enabled=excluded.enabled,
			input_price_per_m=excluded.input_price_per_m, output_price_per_m=excluded.output_price_per_m,
			tier=excluded.tier, is_paid_model=excluded.is_paid_model`,
		m.ID, m.Platform, m.DisplayName, m.IntRank, m.SpeedRank, m.ContextWin,
		b2i(m.Vision), b2i(m.Tools), b2i(m.Enabled), m.InputPerM, m.OutputPerM, m.Tier, b2i(m.IsPaidModel))
	return err
}

// ListModels returns models, optionally filtered by tier / enabled.
func (d *DB) ListModels(tier string, enabledOnly bool) ([]ModelRow, error) {
	q := `SELECT id, platform, COALESCE(display_name,''), intelligence_rank, speed_rank,
		context_window, supports_vision, supports_tools, enabled,
		input_price_per_m, output_price_per_m, tier, is_paid_model FROM models WHERE 1=1`
	var args []any
	if tier != "" {
		q += ` AND tier = ?`
		args = append(args, tier)
	}
	if enabledOnly {
		q += ` AND enabled = 1`
	}
	rows, err := d.query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ModelRow
	for rows.Next() {
		var m ModelRow
		var vis, tools, en, paid int
		if err := rows.Scan(&m.ID, &m.Platform, &m.DisplayName, &m.IntRank, &m.SpeedRank,
			&m.ContextWin, &vis, &tools, &en, &m.InputPerM, &m.OutputPerM, &m.Tier, &paid); err != nil {
			return nil, err
		}
		m.Vision, m.Tools, m.Enabled, m.IsPaidModel = vis == 1, tools == 1, en == 1, paid == 1
		out = append(out, m)
	}
	return out, rows.Err()
}

// ChainRow is a fallback chain with its entries.
type ChainRow struct {
	ID                 string
	Name               string
	Tier               string
	Type               string              // MAIN | FALLBACK | ESCALATION | SPECIALIZED
	Description        string
	Tags               []string
	AutoSkipExhausted  bool
	Metadata            map[string]string
	Entries             []ChainEntryRow
	Strategy           string
	WeightReliability  float64
	WeightSpeed        float64
	WeightIntelligence float64
	KeySelection       string
	ExploreEnabled     bool
	PeakAdjust         bool
	Nodes              []ChainNodeRow // Visually configured hybrid node-flow!
}

type ChainNodeRow struct {
	ID              string
	Type            string // 'STATIC' | 'SMART_CONTAINER' | 'SUB_CHAIN'
	Priority        int32
	Enabled         bool
	StaticModelID   string
	StaticPlatform  string
	StaticAPIKeyID  string
	StaticSelfRetry bool
	SmartConfig     ContainerStrategyRow
	SmartMembers    []ContainerMemberRow
	TargetChainID   string
}

type ContainerStrategyRow struct {
	Strategy           string
	WeightReliability  float64
	WeightSpeed        float64
	WeightIntelligence float64
	KeySelection       string
	ExploreEnabled     bool
	PeakAdjust         bool
}

type ContainerMemberRow struct {
	ModelID        string
	Platform       string
	Enabled        bool
	IsPaidModel    bool
	APIKeyID       string
	UserPreference float64
	SelfRetry      bool
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
	rows, err := d.query(`SELECT id, name, tier, type, description, tags, auto_skip_exhausted, metadata,
		strategy, weight_reliability, weight_speed, weight_intelligence, key_selection, explore_enabled, peak_adjust
		FROM chains ORDER BY tier, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ChainRow
	for rows.Next() {
		var c ChainRow
		var tagsJSON, metaJSON string
		var autoSkip, explore, peak int
		if err := rows.Scan(&c.ID, &c.Name, &c.Tier, &c.Type, &c.Description, &tagsJSON, &autoSkip, &metaJSON,
			&c.Strategy, &c.WeightReliability, &c.WeightSpeed, &c.WeightIntelligence, &c.KeySelection, &explore, &peak); err != nil {
			return nil, err
		}
		c.AutoSkipExhausted = autoSkip == 1
		c.ExploreEnabled = explore == 1
		c.PeakAdjust = peak == 1
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

		nodes, err := d.chainNodes(out[i].ID)
		if err != nil {
			return nil, err
		}
		out[i].Nodes = nodes
	}
	return out, nil
}

func (d *DB) chainNodes(chainID string) ([]ChainNodeRow, error) {
	rows, err := d.query(`SELECT id, type, priority, enabled, 
		COALESCE(static_model_id,''), COALESCE(static_platform,''), COALESCE(static_api_key_id,''), static_self_retry,
		COALESCE(target_chain_id,'')
		FROM chain_nodes WHERE chain_id = ? ORDER BY priority`, chainID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ChainNodeRow
	for rows.Next() {
		var n ChainNodeRow
		var en, retry int
		if err := rows.Scan(&n.ID, &n.Type, &n.Priority, &en,
			&n.StaticModelID, &n.StaticPlatform, &n.StaticAPIKeyID, &retry, &n.TargetChainID); err != nil {
			return nil, err
		}
		n.Enabled = en == 1
		n.StaticSelfRetry = retry == 1
		
		if n.Type == "SMART_CONTAINER" {
			// Load Strategy config
			var s ContainerStrategyRow
			var exp, pk int
			err := d.queryRow(`SELECT strategy, weight_reliability, weight_speed, weight_intelligence, key_selection, explore_enabled, peak_adjust 
				FROM container_strategies WHERE node_id = ?`, n.ID).Scan(&s.Strategy, &s.WeightReliability, &s.WeightSpeed, &s.WeightIntelligence, &s.KeySelection, &exp, &pk)
			if err == nil {
				s.ExploreEnabled = exp == 1
				s.PeakAdjust = pk == 1
				n.SmartConfig = s
			}
			
			// Load members
			memRows, err := d.query(`SELECT model_id, platform, enabled, is_paid_model, COALESCE(api_key_id,''), user_preference, self_retry
				FROM container_members WHERE node_id = ? ORDER BY model_id`, n.ID)
			if err == nil {
				var members []ContainerMemberRow
				for memRows.Next() {
					var m ContainerMemberRow
					var mEn, mPaid, mRet int
					if err := memRows.Scan(&m.ModelID, &m.Platform, &mEn, &mPaid, &m.APIKeyID, &m.UserPreference, &mRet); err == nil {
						m.Enabled = mEn == 1
						m.IsPaidModel = mPaid == 1
						m.SelfRetry = mRet == 1
						members = append(members, m)
					}
				}
				memRows.Close()
				n.SmartMembers = members
			}
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

func (d *DB) chainEntries(chainID string) ([]ChainEntryRow, error) {
	rows, err := d.query(`SELECT model_id, platform, priority, enabled, 
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
	
	if _, err := tx.Exec(toPostgresSQL(`INSERT INTO chains (id, name, tier, type, description, tags, auto_skip_exhausted, metadata,
		strategy, weight_reliability, weight_speed, weight_intelligence, key_selection, explore_enabled, peak_adjust)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET 
			name=excluded.name, tier=excluded.tier, type=excluded.type,
			description=excluded.description, tags=excluded.tags,
			auto_skip_exhausted=excluded.auto_skip_exhausted, metadata=excluded.metadata,
			strategy=excluded.strategy, weight_reliability=excluded.weight_reliability,
			weight_speed=excluded.weight_speed, weight_intelligence=excluded.weight_intelligence,
			key_selection=excluded.key_selection, explore_enabled=excluded.explore_enabled,
			peak_adjust=excluded.peak_adjust`),
		c.ID, c.Name, c.Tier, c.Type, c.Description, string(tagsJSON), b2i(c.AutoSkipExhausted), string(metaJSON),
		c.Strategy, c.WeightReliability, c.WeightSpeed, c.WeightIntelligence, c.KeySelection, b2i(c.ExploreEnabled), b2i(c.PeakAdjust)); err != nil {
		return err
	}
	if _, err := tx.Exec(toPostgresSQL(`DELETE FROM chain_entries WHERE chain_id = ?`), c.ID); err != nil {
		return err
	}
	for _, e := range c.Entries {
		paramsJSON, _ := json.Marshal(e.Parameters)
		entryMetaJSON, _ := json.Marshal(e.Metadata)
		if _, err := tx.Exec(toPostgresSQL(`INSERT INTO chain_entries 
			(chain_id, model_id, platform, priority, enabled, is_paid_model, api_key_id, user_preference, is_fallback, model_type, parameters, metadata)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
			c.ID, e.ModelID, e.Platform, e.Priority, b2i(e.Enabled),
			b2i(e.IsPaidModel), e.APIKeyID, e.UserPreference, b2i(e.IsFallback), e.ModelType,
			string(paramsJSON), string(entryMetaJSON)); err != nil {
			return err
		}
	}

	// Clean up legacy nodes
	if _, err := tx.Exec(toPostgresSQL(`DELETE FROM chain_nodes WHERE chain_id = ?`), c.ID); err != nil {
		return err
	}
	// Insert new nodes
	for _, n := range c.Nodes {
		if _, err := tx.Exec(toPostgresSQL(`INSERT INTO chain_nodes 
			(id, chain_id, type, priority, enabled, static_model_id, static_platform, static_api_key_id, static_self_retry, target_chain_id)
			VALUES (?,?,?,?,?,?,?,?,?,?)`),
			n.ID, c.ID, n.Type, n.Priority, b2i(n.Enabled),
			n.StaticModelID, n.StaticPlatform, n.StaticAPIKeyID, b2i(n.StaticSelfRetry), n.TargetChainID); err != nil {
			return err
		}
		
		if n.Type == "SMART_CONTAINER" {
			// Insert strategy
			if _, err := tx.Exec(toPostgresSQL(`INSERT INTO container_strategies
				(node_id, strategy, weight_reliability, weight_speed, weight_intelligence, key_selection, explore_enabled, peak_adjust)
				VALUES (?,?,?,?,?,?,?,?)`),
				n.ID, n.SmartConfig.Strategy, n.SmartConfig.WeightReliability, n.SmartConfig.WeightSpeed, n.SmartConfig.WeightIntelligence,
				n.SmartConfig.KeySelection, b2i(n.SmartConfig.ExploreEnabled), b2i(n.SmartConfig.PeakAdjust)); err != nil {
				return err
			}
			
			// Insert members
			for _, m := range n.SmartMembers {
				if _, err := tx.Exec(toPostgresSQL(`INSERT INTO container_members
					(node_id, model_id, platform, enabled, is_paid_model, api_key_id, user_preference, self_retry)
					VALUES (?,?,?,?,?,?,?,?)`),
					n.ID, m.ModelID, m.Platform, b2i(m.Enabled), b2i(m.IsPaidModel), m.APIKeyID, m.UserPreference, b2i(m.SelfRetry)); err != nil {
					return err
				}
			}
		}
	}

	return tx.Commit()
}

// Keys returns all registered key rows.
func (d *DB) Keys() ([]KeyRow, error) {
	rows, err := d.query(`SELECT id, platform, COALESCE(label,''), enabled, is_paid, COALESCE(model_scope,'') FROM keys ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []KeyRow
	for rows.Next() {
		var k KeyRow
		var en, paid int
		var scopeJSON string
		if err := rows.Scan(&k.ID, &k.Platform, &k.Label, &en, &paid, &scopeJSON); err != nil {
			return nil, err
		}
		k.Enabled = en == 1
		k.IsPaid = paid == 1
		k.ModelScope = parseJSONArray(scopeJSON)
		out = append(out, k)
	}
	return out, rows.Err()
}

// AddKey inserts a new API key into the SQLite database.
func (d *DB) AddKey(platform, value, label string, enabled bool, isPaid bool) (int64, error) {
	res, err := d.exec(`INSERT INTO keys (platform, value, label, enabled, is_paid) VALUES (?,?,?,?,?)`,
		platform, value, label, b2i(enabled), b2i(isPaid))
	if err != nil {
		return 0, err
	}
	id, _ := res.LastInsertId()
	return id, nil
}

type KeyRow struct {
	ID         int64
	Platform   string
	Label      string
	Enabled    bool
	IsPaid     bool
	ModelScope []string
}

// SeedDefaults cleans and purges all hardcoded default models, profiles, and fallback pools, but ensures exactly one clean, empty "default" core router is seeded!
func (d *DB) SeedDefaults() error {
	// Wipe all hardcoded, pre-seeded default profiles and models to start with a 100% blank slate!
	_, _ = d.exec("DELETE FROM chain_entries WHERE chain_id LIKE 'auto:%'")
	_, _ = d.exec("DELETE FROM chains WHERE id LIKE 'auto:%'")
	_, _ = d.exec("DELETE FROM models WHERE platform IN ('openai', 'anthropic', 'google', 'groq', 'mistral', 'deepseek', 'ollama')")

	// Ensure exactly one clean, empty core router profile "default" exists in SQLite!
	var one string
	err := d.queryRow(`SELECT id FROM chains WHERE id = ?`, "default").Scan(&one)
	if err == sql.ErrNoRows {
		chain := ChainRow{
			ID:          "default",
			Name:        "Core Fallback Router",
			Tier:        "S",
			Type:        "MAIN",
			Description: "Your primary, clean fallback mesh router.",
		}
		chain.Entries = []ChainEntryRow{} // 100% empty, clean slate!
		_ = d.UpsertChain(chain)
	}

	// Auto-generate secure, unique jimesh-sk- key on startup if it doesn't exist yet!
	if val, err := d.GetSetting("api-key"); err != nil || val == "" {
		bytes := make([]byte, 16)
		_, _ = rand.Read(bytes)
		newKey := fmt.Sprintf("jimesh-sk-%x", bytes)
		jsonBytes, _ := json.Marshal(map[string]string{"apiKey": newKey})
		_ = d.SaveSetting("api-key", string(jsonBytes))
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
	var autoSkip, explore, peak int
	err := d.queryRow(`SELECT id, name, tier, type, description, tags, auto_skip_exhausted, metadata,
		strategy, weight_reliability, weight_speed, weight_intelligence, key_selection, explore_enabled, peak_adjust 
		FROM chains WHERE id = ?`, id).Scan(&c.ID, &c.Name, &c.Tier, &c.Type, &c.Description, &tagsJSON, &autoSkip, &metaJSON,
		&c.Strategy, &c.WeightReliability, &c.WeightSpeed, &c.WeightIntelligence, &c.KeySelection, &explore, &peak)
	if err != nil {
		return ChainRow{}, err
	}
	c.AutoSkipExhausted = autoSkip == 1
	c.ExploreEnabled = explore == 1
	c.PeakAdjust = peak == 1
	c.Tags = parseJSONArray(tagsJSON)
	c.Metadata = parseJSONMap(metaJSON)
	ents, err := d.chainEntries(c.ID)
	if err != nil {
		return ChainRow{}, err
	}
	c.Entries = ents
	
	nodes, err := d.chainNodes(c.ID)
	if err != nil {
		return ChainRow{}, err
	}
	c.Nodes = nodes
	return c, nil
}

// ChainByTier loads a single chain by tier.
func (d *DB) ChainByTier(tier string) (ChainRow, error) {
	var c ChainRow
	var tagsJSON, metaJSON string
	var autoSkip, explore, peak int
	err := d.queryRow(`SELECT id, name, tier, type, description, tags, auto_skip_exhausted, metadata,
		strategy, weight_reliability, weight_speed, weight_intelligence, key_selection, explore_enabled, peak_adjust 
		FROM chains WHERE lower(tier) = lower(?) LIMIT 1`, tier).Scan(&c.ID, &c.Name, &c.Tier, &c.Type, &c.Description, &tagsJSON, &autoSkip, &metaJSON,
		&c.Strategy, &c.WeightReliability, &c.WeightSpeed, &c.WeightIntelligence, &c.KeySelection, &explore, &peak)
	if err != nil {
		return ChainRow{}, err
	}
	c.AutoSkipExhausted = autoSkip == 1
	c.ExploreEnabled = explore == 1
	c.PeakAdjust = peak == 1
	c.Tags = parseJSONArray(tagsJSON)
	c.Metadata = parseJSONMap(metaJSON)
	ents, err := d.chainEntries(c.ID)
	if err != nil {
		return ChainRow{}, err
	}
	c.Entries = ents

	nodes, err := d.chainNodes(c.ID)
	if err != nil {
		return ChainRow{}, err
	}
	c.Nodes = nodes
	return c, nil
}

// ModelByIDPlatform loads a single model row by ID and platform.
func (d *DB) ModelByIDPlatform(modelID, platform string) (ModelRow, error) {
	q := `SELECT id, platform, COALESCE(display_name,''), intelligence_rank, speed_rank,
		context_window, supports_vision, supports_tools, enabled,
		input_price_per_m, output_price_per_m, tier, is_paid_model FROM models WHERE id = ? AND platform = ?`
	var m ModelRow
	var vis, tools, en, paid int
	err := d.queryRow(q, modelID, platform).Scan(&m.ID, &m.Platform, &m.DisplayName, &m.IntRank, &m.SpeedRank,
		&m.ContextWin, &vis, &tools, &en, &m.InputPerM, &m.OutputPerM, &m.Tier, &paid)
	if err != nil {
		return ModelRow{}, err
	}
	m.Vision, m.Tools, m.Enabled, m.IsPaidModel = vis == 1, tools == 1, en == 1, paid == 1
	return m, nil
}

// GetSetting retrieves a setting value from SQLite.
func (d *DB) GetSetting(key string) (string, error) {
	var val string
	err := d.queryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&val)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return val, err
}

// SaveSetting upserts a setting value in SQLite.
func (d *DB) SaveSetting(key, value string) error {
	_, err := d.exec(`INSERT INTO settings (key, value) VALUES (?,?)
		ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value)
	return err
}

// DeleteKey removes a key from SQLite.
func (d *DB) DeleteKey(id int64) error {
	_, err := d.exec(`DELETE FROM keys WHERE id = ?`, id)
	return err
}

// BulkDeleteKeys removes multiple keys from SQLite at once.
func (d *DB) BulkDeleteKeys(ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	tx, err := d.sql.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	for _, id := range ids {
		if _, err := tx.Exec(toPostgresSQL(`DELETE FROM keys WHERE id = ?`), id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// DeleteChain removes a chain and its entries from SQLite.
func (d *DB) DeleteChain(id string) error {
	tx, err := d.sql.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(toPostgresSQL(`DELETE FROM chain_entries WHERE chain_id = ?`), id); err != nil {
		return err
	}
	if _, err := tx.Exec(toPostgresSQL(`DELETE FROM chains WHERE id = ?`), id); err != nil {
		return err
	}
	return tx.Commit()
}

// ToggleKey enables or disables a key in SQLite.
func (d *DB) ToggleKey(id int64, enabled bool) error {
	_, err := d.exec(`UPDATE keys SET enabled = ? WHERE id = ?`, b2i(enabled), id)
	return err
}

// BulkToggleKeys mass-enables or mass-disables all API keys in the SQLite database.
func (d *DB) BulkToggleKeys(enabled bool) error {
	_, err := d.exec(`UPDATE keys SET enabled = ?`, b2i(enabled))
	return err
}

// ToggleKeyPaid updates the is_paid status of a key in PostgreSQL.
func (d *DB) ToggleKeyPaid(id int64, isPaid bool) error {
	_, err := d.exec(`UPDATE keys SET is_paid = ? WHERE id = ?`, b2i(isPaid), id)
	return err
}

// UpdateKeyScope updates the model_scope array of a key in PostgreSQL.
func (d *DB) UpdateKeyScope(id int64, scopeJSON string) error {
	_, err := d.exec(`UPDATE keys SET model_scope = ? WHERE id = ?`, scopeJSON, id)
	return err
}

// GetKeyValue retrieves the raw API key value string from PostgreSQL.
func (d *DB) GetKeyValue(id int64) (string, error) {
	var val string
	err := d.queryRow(`SELECT value FROM keys WHERE id = ?`, id).Scan(&val)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return val, err
}

// ---------- DSH Advanced Schema & CRUD Functions ----------

type AgentTypeRow struct {
	ID                   string `json:"id"`
	Label                string `json:"label"`
	Description          string `json:"description"`
	DefaultTags          string `json:"default_tags"`          // JSON string array
	DefaultFallbackChain string `json:"default_fallback_chain"` // JSON string array
}

type SessionRow struct {
	ID          string `json:"id"`
	AgentTypeID string `json:"agent_type_id"`
	Metadata    string `json:"metadata"` // JSON string map
	Tags        string `json:"tags"`     // JSON string array
	CreatedAt   string `json:"created_at"`
}

func (d *DB) UpsertAgentType(at AgentTypeRow) error {
	q := `INSERT INTO agent_types (id, label, description, default_tags, default_fallback_chain)
		VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
		label=excluded.label, description=excluded.description,
		default_tags=excluded.default_tags, default_fallback_chain=excluded.default_fallback_chain`
	_, err := d.exec(q, at.ID, at.Label, at.Description, at.DefaultTags, at.DefaultFallbackChain)
	return err
}

func (d *DB) ListAgentTypes() ([]AgentTypeRow, error) {
	q := `SELECT id, label, COALESCE(description,''), default_tags, default_fallback_chain FROM agent_types ORDER BY id`
	rows, err := d.query(q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []AgentTypeRow
	for rows.Next() {
		var at AgentTypeRow
		if err := rows.Scan(&at.ID, &at.Label, &at.Description, &at.DefaultTags, &at.DefaultFallbackChain); err != nil {
			return nil, err
		}
		out = append(out, at)
	}
	return out, rows.Err()
}

func (d *DB) UpsertSession(s SessionRow) error {
	q := `INSERT INTO sessions (id, agent_type_id, metadata, tags)
		VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET
		agent_type_id=excluded.agent_type_id, metadata=excluded.metadata, tags=excluded.tags`
	_, err := d.exec(q, s.ID, s.AgentTypeID, s.Metadata, s.Tags)
	return err
}

func (d *DB) ListSessions() ([]SessionRow, error) {
	q := `SELECT id, COALESCE(agent_type_id,''), metadata, tags, created_at FROM sessions ORDER BY created_at DESC`
	rows, err := d.query(q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []SessionRow
	for rows.Next() {
		var s SessionRow
		if err := rows.Scan(&s.ID, &s.AgentTypeID, &s.Metadata, &s.Tags, &s.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (d *DB) QuerySessions(agentTypeID string, tag string) ([]SessionRow, error) {
	var q string
	var args []any
	if agentTypeID != "" && tag != "" {
		q = `SELECT id, agent_type_id, metadata, tags, created_at FROM sessions WHERE agent_type_id = ? AND tags LIKE ? ORDER BY created_at DESC`
		args = append(args, agentTypeID, "%"+tag+"%")
	} else if agentTypeID != "" {
		q = `SELECT id, agent_type_id, metadata, tags, created_at FROM sessions WHERE agent_type_id = ? ORDER BY created_at DESC`
		args = append(args, agentTypeID)
	} else if tag != "" {
		q = `SELECT id, COALESCE(agent_type_id,''), metadata, tags, created_at FROM sessions WHERE tags LIKE ? ORDER BY created_at DESC`
		args = append(args, "%"+tag+"%")
	} else {
		return d.ListSessions()
	}

	rows, err := d.query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []SessionRow
	for rows.Next() {
		var s SessionRow
		if err := rows.Scan(&s.ID, &s.AgentTypeID, &s.Metadata, &s.Tags, &s.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// SaveProject persists a deployed project in PostgreSQL (Sprint 8 Enterprise).
func (d *DB) SaveProject(id, name, status string) error {
	_, err := d.exec(`INSERT INTO projects (id, name, status) VALUES (?,?,?)
		ON CONFLICT(id) DO UPDATE SET name=excluded.name, status=excluded.status`, id, name, status)
	return err
}

// SaveContainer persists a project's container information in PostgreSQL (Sprint 8 Enterprise).
func (d *DB) SaveContainer(id, projectID, containerID, name, status string) error {
	_, err := d.exec(`INSERT INTO containers (id, project_id, container_id, name, status) VALUES (?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, container_id=excluded.container_id, name=excluded.name, status=excluded.status`, id, projectID, containerID, name, status)
	return err
}
