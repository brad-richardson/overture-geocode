#!/bin/bash
# Fetch current gers_id and version from production D1 database
#
# Usage: ./scripts/fetch_prod_versions.sh [output_file] [db_name] [table_name]
#
# Arguments:
#   output_file - Output CSV file (default: prod_versions.csv)
#   db_name     - D1 database name (default: geocoder-divisions-global)
#   table_name  - Table to query (default: divisions)
#
# Output: CSV file with gers_id,version columns
# Requires: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID env vars
#
# Notes:
# - Returns empty CSV (header only) if database doesn't exist
# - Handles missing version column (legacy databases)

set -e

OUTPUT_FILE="${1:-prod_versions.csv}"
DB_NAME="${2:-geocoder-divisions-global}"
TABLE_NAME="${3:-divisions}"

echo "Fetching production versions from D1 ($DB_NAME, table: $TABLE_NAME)..."

# First check if the table has a version column
HAS_VERSION=$(npx wrangler d1 execute "$DB_NAME" --remote \
    --command "PRAGMA table_info($TABLE_NAME)" \
    --json 2>&1 | python3 -c "
import json
import sys
try:
    text = sys.stdin.read()
    if 'error' in text.lower() or 'no such table' in text.lower():
        print('false')
    else:
        data = json.loads(text)
        results = data[0].get('results', []) if data else []
        has_version = any(col.get('name') == 'version' for col in results)
        print('true' if has_version else 'false')
except:
    print('false')
")

if [ "$HAS_VERSION" = "false" ]; then
    echo "Warning: Database doesn't exist or missing version column"
    echo "  Creating empty versions file (will treat all records as new)"
    echo "gers_id,version" > "$OUTPUT_FILE"
    echo "Fetched 0 records to $OUTPUT_FILE"
    exit 0
fi

# Query D1 for current versions
echo "Querying $TABLE_NAME table..."
RESULT=$(npx wrangler d1 execute "$DB_NAME" --remote \
    --command "SELECT gers_id, version FROM $TABLE_NAME" \
    --json 2>&1) || {
    echo "Warning: Query failed with error:"
    echo "$RESULT"
    echo "Treating as empty database"
    echo "gers_id,version" > "$OUTPUT_FILE"
    exit 0
}

# Parse JSON output and convert to CSV
echo "$RESULT" | python3 -c "
import json
import sys

try:
    text = sys.stdin.read()
    if 'error' in text.lower():
        print('gers_id,version')
        sys.exit(0)

    data = json.loads(text)
    results = data[0].get('results', []) if data else []

    print('gers_id,version')
    for row in results:
        gers_id = row.get('gers_id', '')
        version = row.get('version', 0)
        print(f'{gers_id},{version}')
except Exception as e:
    print('gers_id,version', file=sys.stderr)
    print(f'Error parsing results: {e}', file=sys.stderr)
    print('gers_id,version')
" > "$OUTPUT_FILE"

COUNT=$(wc -l < "$OUTPUT_FILE")
COUNT=$((COUNT - 1))  # Subtract header
echo "Fetched $COUNT records to $OUTPUT_FILE"
