#!/bin/bash
# Download addresses for a US state using the latest Overture release
#
# Usage: ./scripts/download_addresses.sh [STATE] [RELEASE]
#
# If STATE is not provided, defaults to MA.
# If RELEASE is not provided, fetches the latest from STAC catalog.
# Example: ./scripts/download_addresses.sh CA 2025-01-15.0

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
FALLBACK_RELEASE="2025-12-17.0"

# Use provided state or default to MA
STATE="${1:-MA}"
echo "Downloading addresses for state: $STATE"

# Use provided release or fetch latest from STAC
if [ -n "$2" ]; then
    RELEASE="$2"
    echo "Using provided Overture release: $RELEASE"
else
    echo "Fetching latest Overture release from STAC..."
    RELEASE=$(python3 scripts/stac.py 2>/dev/null | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+') || {
        echo "Warning: Failed to fetch latest release, using fallback: $FALLBACK_RELEASE"
        RELEASE="$FALLBACK_RELEASE"
    }
    echo "Using Overture release: $RELEASE"
fi

# Create exports directory
mkdir -p "$PROJECT_DIR/exports"

# Run SQL with release and state substituted
cd "$PROJECT_DIR"
sed -e "s|__OVERTURE_RELEASE__|$RELEASE|g" -e "s|__STATE__|$STATE|g" scripts/download_addresses.sql | duckdb

# Verify data was actually downloaded (sanity check for expired data)
OUTPUT_FILE="$PROJECT_DIR/exports/US-$STATE.parquet"
if [ ! -f "$OUTPUT_FILE" ]; then
    echo "ERROR: Output file not created - release $RELEASE may be expired (data removed after 90 days)"
    exit 1
fi

ROW_COUNT=$(duckdb -c "SELECT COUNT(*) FROM read_parquet('$OUTPUT_FILE')" 2>/dev/null | grep -oE '[0-9]+' | head -1)
if [ -z "$ROW_COUNT" ] || [ "$ROW_COUNT" -eq 0 ]; then
    echo "ERROR: No data returned - release $RELEASE may be expired (data removed after 90 days)"
    exit 1
fi

echo "Done! Output: exports/US-$STATE.parquet ($ROW_COUNT rows)"
