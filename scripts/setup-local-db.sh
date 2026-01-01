#!/bin/bash
# Setup local D1 databases for development
#
# Wrangler v4 uses hash-based filenames for D1 databases. This script:
# 1. Starts wrangler briefly to create the empty hash-named database files
# 2. Identifies which files are for which database
# 3. Replaces them with our pre-built databases
#
# Usage: npm run setup-db

set -e

PERSIST_DIR=".wrangler/local-state"
D1_DIR="$PERSIST_DIR/v3/d1/miniflare-D1DatabaseObject"

echo "Setting up local D1 databases..."

# Check source databases exist
if [ ! -f "indexes/divisions-global.db" ]; then
    echo "⚠ indexes/divisions-global.db not found"
    echo "  Run: python scripts/build_divisions_index.py"
    exit 1
fi

if [ ! -f "indexes/us-ma.db" ]; then
    echo "⚠ indexes/us-ma.db not found"
    echo "  Run: python scripts/build_index.py"
    exit 1
fi

# Create persist directory
mkdir -p "$D1_DIR"

# Start wrangler briefly to create hash-named database files
echo "Starting wrangler to initialize databases..."
npx wrangler dev --persist-to="$PERSIST_DIR" --port 9999 2>&1 &
WRANGLER_PID=$!

# Wait for wrangler to be ready
sleep 4

# Make a request to trigger D1 database creation
curl -s "http://localhost:9999/search?q=test" >/dev/null 2>&1 || true
sleep 2

# Kill wrangler
kill $WRANGLER_PID 2>/dev/null || true
wait $WRANGLER_PID 2>/dev/null || true

# Find small (<1MB) sqlite files that wrangler created (these are the empty ones)
echo "Finding empty D1 databases..."
EMPTY_FILES=$(find "$D1_DIR" -name "*.sqlite" -size -1M -type f 2>/dev/null | head -2)

if [ -z "$EMPTY_FILES" ]; then
    echo "No empty database files found. They may already be populated."
    echo "To force reset: rm -rf $D1_DIR && npm run setup-db"
    exit 0
fi

# The hash names are deterministic based on database config.
# We need to identify which is which by checking the content after wrangler creates them.
# Unfortunately wrangler doesn't make this easy, so we use a workaround:
# Copy both databases to both files (one will work for each binding)
for FILE in $EMPTY_FILES; do
    BASENAME=$(basename "$FILE")
    # Try to figure out which is which based on prior knowledge
    # d3e... hash is for DB_MA (local-dev), 6a59... is for DB_DIVISIONS
    if [[ "$BASENAME" == d3e* ]]; then
        cp "indexes/us-ma.db" "$FILE"
        echo "✓ Copied us-ma.db → $BASENAME"
    elif [[ "$BASENAME" == 6a59* ]]; then
        cp "indexes/divisions-global.db" "$FILE"
        echo "✓ Copied divisions-global.db → $BASENAME"
    else
        echo "⚠ Unknown hash file: $BASENAME"
    fi
done

echo ""
echo "Local databases ready. Run: npm run dev"
