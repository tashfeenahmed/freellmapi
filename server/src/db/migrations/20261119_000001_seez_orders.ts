import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
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
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_seez_orders_created_at;
    DROP TABLE IF EXISTS seez_orders;
  `);
}
