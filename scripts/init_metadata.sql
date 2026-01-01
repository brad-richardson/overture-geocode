-- Initialize metadata table if it doesn't exist
-- Run this once when setting up a new D1 database or migrating existing ones

-- Create metadata table
CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Add version column to divisions if it doesn't exist
-- Note: SQLite doesn't support ADD COLUMN IF NOT EXISTS, so we check first
-- This is handled via a migration approach

-- For new databases, the version column is already in the schema
-- For existing databases, you may need to:
-- 1. Export data
-- 2. Drop and recreate table with version column
-- 3. Re-import data

-- Set initial metadata (use INSERT OR IGNORE to not overwrite existing)
INSERT OR IGNORE INTO metadata (key, value) VALUES ('overture_release', 'none');
INSERT OR IGNORE INTO metadata (key, value) VALUES ('created_at', datetime('now'));
