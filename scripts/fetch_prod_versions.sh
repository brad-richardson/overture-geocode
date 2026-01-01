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
# - Uses pagination to handle large tables (D1 has row limits per query)
# - Returns empty CSV (header only) if database doesn't exist
# - Handles missing version column (legacy databases)

set -e

OUTPUT_FILE="${1:-prod_versions.csv}"
DB_NAME="${2:-geocoder-divisions-global}"
TABLE_NAME="${3:-divisions}"
BATCH_SIZE=50000  # D1 can handle ~100K but we use 50K for safety

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

# Get total count first
echo "Counting records in $TABLE_NAME..."
TOTAL_COUNT=$(npx wrangler d1 execute "$DB_NAME" --remote \
    --command "SELECT COUNT(*) as count FROM $TABLE_NAME" \
    --json 2>&1 | python3 -c "
import json
import sys
try:
    data = json.loads(sys.stdin.read())
    results = data[0].get('results', []) if data else []
    print(results[0].get('count', 0) if results else 0)
except:
    print(0)
")

echo "Found $TOTAL_COUNT records in production"

# Write CSV header
echo "gers_id,version" > "$OUTPUT_FILE"

if [ "$TOTAL_COUNT" -eq 0 ]; then
    echo "Fetched 0 records to $OUTPUT_FILE"
    exit 0
fi

# Paginated fetch using LIMIT/OFFSET
OFFSET=0
FETCHED=0

while [ $OFFSET -lt $TOTAL_COUNT ]; do
    echo "  Fetching batch: offset=$OFFSET, limit=$BATCH_SIZE..."

    RESULT=$(npx wrangler d1 execute "$DB_NAME" --remote \
        --command "SELECT gers_id, version FROM $TABLE_NAME ORDER BY gers_id LIMIT $BATCH_SIZE OFFSET $OFFSET" \
        --json 2>&1) || {
        echo "Warning: Query failed at offset $OFFSET"
        echo "$RESULT"
        break
    }

    # Parse and append to CSV
    BATCH_COUNT=$(echo "$RESULT" | python3 -c "
import json
import sys

try:
    data = json.loads(sys.stdin.read())
    results = data[0].get('results', []) if data else []

    for row in results:
        gers_id = row.get('gers_id', '')
        version = row.get('version', 0)
        print(f'{gers_id},{version}')

    print(len(results), file=sys.stderr)
except Exception as e:
    print(f'Error: {e}', file=sys.stderr)
    print(0, file=sys.stderr)
" >> "$OUTPUT_FILE" 2>&1 | tail -1)

    # Extract batch count from stderr
    BATCH_COUNT=$(echo "$RESULT" | python3 -c "
import json
import sys
try:
    data = json.loads(sys.stdin.read())
    results = data[0].get('results', []) if data else []
    print(len(results))
except:
    print(0)
")

    FETCHED=$((FETCHED + BATCH_COUNT))
    OFFSET=$((OFFSET + BATCH_SIZE))

    # Break if we got fewer results than batch size (end of data)
    if [ "$BATCH_COUNT" -lt "$BATCH_SIZE" ]; then
        break
    fi
done

echo "Fetched $FETCHED records to $OUTPUT_FILE"
