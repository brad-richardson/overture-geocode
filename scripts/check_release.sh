#!/bin/bash
# Check if a new Overture release is available compared to production
#
# Usage: ./scripts/check_release.sh
#
# Output:
#   Sets environment variables:
#     OVERTURE_RELEASE - Latest available release
#     PROD_RELEASE - Current production release (or "none")
#     RELEASE_CHANGED - "true" or "false"
#
# For GitHub Actions, outputs are set via GITHUB_OUTPUT

set -e

DB_NAME="geocoder-divisions-global"

# Get latest Overture release
echo "Fetching latest Overture release..."
LATEST_RELEASE=$(python3 scripts/stac.py 2>/dev/null) || {
    echo "Warning: Could not fetch latest release, using fallback"
    LATEST_RELEASE="2025-12-17.0"
}
# Extract just the version if there's extra text
LATEST_RELEASE=$(echo "$LATEST_RELEASE" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+' | head -1)
echo "Latest Overture release: $LATEST_RELEASE"

# Get current production release
echo "Checking production release..."
PROD_RELEASE=$(npx wrangler d1 execute "$DB_NAME" --remote \
    --command "SELECT value FROM metadata WHERE key = 'overture_release'" \
    --json 2>&1 | python3 -c "
import json
import sys
try:
    text = sys.stdin.read()
    # Check for common errors (no table, no database, etc.)
    if 'no such table' in text.lower() or 'error' in text.lower():
        print('none')
    else:
        data = json.loads(text)
        results = data[0].get('results', []) if data else []
        print(results[0]['value'] if results else 'none')
except:
    print('none')
")

# Ensure we have a valid value
PROD_RELEASE="${PROD_RELEASE:-none}"

echo "Production release: $PROD_RELEASE"

# Compare releases
if [ "$LATEST_RELEASE" != "$PROD_RELEASE" ]; then
    RELEASE_CHANGED="true"
    echo "Release changed: $PROD_RELEASE -> $LATEST_RELEASE"
else
    RELEASE_CHANGED="false"
    echo "Release unchanged"
fi

# Export for shell usage
export OVERTURE_RELEASE="$LATEST_RELEASE"
export PROD_RELEASE="$PROD_RELEASE"
export RELEASE_CHANGED="$RELEASE_CHANGED"

# Set GitHub Actions outputs if running in CI
if [ -n "$GITHUB_OUTPUT" ]; then
    echo "overture_release=$LATEST_RELEASE" >> "$GITHUB_OUTPUT"
    echo "prod_release=$PROD_RELEASE" >> "$GITHUB_OUTPUT"
    echo "release_changed=$RELEASE_CHANGED" >> "$GITHUB_OUTPUT"
fi

# Print summary
echo ""
echo "Summary:"
echo "  OVERTURE_RELEASE=$LATEST_RELEASE"
echo "  PROD_RELEASE=$PROD_RELEASE"
echo "  RELEASE_CHANGED=$RELEASE_CHANGED"
