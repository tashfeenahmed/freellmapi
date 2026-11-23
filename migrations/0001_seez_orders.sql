CREATE TABLE IF NOT EXISTS seez_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  address TEXT NOT NULL,
  perfume TEXT NOT NULL,
  volume_ml INTEGER NOT NULL CHECK (volume_ml > 0),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_seez_orders_created_at
  ON seez_orders(created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS seez_admin_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_seez_admin_sessions_expiry
  ON seez_admin_sessions(expires_at);

CREATE TABLE IF NOT EXISTS seez_rate_limits (
  bucket TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
