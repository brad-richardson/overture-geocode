#!/bin/bash
# Upload SQLite database to Cloudflare D1
#
# Prerequisites:
#   1. Run download_addresses.sql to create exports/US-MA.parquet
#   2. Run build_index.py to create indexes/US-MA.db
#   3. Create D1 database: wrangler d1 create geocoder-us-ma
#   4. Update wrangler.toml with the database_id
#
# Usage:
#   ./scripts/upload_to_d1.sh

set -e

DB_NAME="geocoder-us-ma"
SQLITE_DB="indexes/US-MA.db"

if [ ! -f "$SQLITE_DB" ]; then
    echo "Error: $SQLITE_DB not found"
    echo "Run: python scripts/build_index.py exports/US-MA.parquet indexes/US-MA.db"
    exit 1
fi

echo "Generating SQL from SQLite database..."

# Export schema
sqlite3 "$SQLITE_DB" ".schema" > indexes/US-MA.sql

# Export data as INSERT statements
sqlite3 "$SQLITE_DB" <<EOF >> indexes/US-MA.sql
.mode insert addresses
SELECT * FROM addresses;
EOF

# Export FTS data
sqlite3 "$SQLITE_DB" <<EOF >> indexes/US-MA.sql
.mode insert addresses_fts
SELECT rowid, search_text FROM addresses_fts;
EOF

echo "SQL export complete: indexes/US-MA.sql"
echo ""
echo "To upload to D1, run:"
echo "  wrangler d1 execute $DB_NAME --remote --file=indexes/US-MA.sql"
echo ""
echo "Note: For large databases, you may need to split the SQL file"
echo "or use wrangler d1 execute with --batch-size flag."
