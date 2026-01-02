#!/bin/bash
# Upload shards and STAC catalog to R2
#
# Usage:
#   ./scripts/upload_shards.sh [VERSION]
#   ./scripts/upload_shards.sh 2026-01-02.0
#
# Prerequisites:
#   - wrangler CLI installed and authenticated
#   - R2 bucket 'geocoder-shards' created

set -e

BUCKET="geocoder-shards"
VERSION="${1:-}"

# If no version specified, find the latest
if [ -z "$VERSION" ]; then
    VERSION=$(ls -1 shards/ | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+$' | sort -r | head -1)
    if [ -z "$VERSION" ]; then
        echo "Error: No version found in shards/"
        echo "Run: python scripts/build_shards.py"
        exit 1
    fi
fi

echo "Uploading shards for version $VERSION to R2 bucket '$BUCKET'"
echo

# Check if version directory exists
if [ ! -d "shards/$VERSION" ]; then
    echo "Error: shards/$VERSION not found"
    exit 1
fi

# Count files to upload
SHARD_COUNT=$(ls -1 shards/$VERSION/shards/*.db 2>/dev/null | wc -l | tr -d ' ')
ITEM_COUNT=$(ls -1 shards/$VERSION/items/*.json 2>/dev/null | wc -l | tr -d ' ')

echo "Files to upload:"
echo "  - $SHARD_COUNT shard databases"
echo "  - $ITEM_COUNT STAC items"
echo "  - 1 collection.json"
echo "  - 1 catalog.json (root)"
echo

# Upload shard databases
echo "Uploading shard databases..."
for shard in shards/$VERSION/shards/*.db; do
    name=$(basename "$shard")
    echo "  $name"
    wrangler r2 object put "$BUCKET/$VERSION/shards/$name" \
        --file "$shard" \
        --content-type "application/x-sqlite3"
done

# Upload STAC items
echo
echo "Uploading STAC items..."
for item in shards/$VERSION/items/*.json; do
    name=$(basename "$item")
    echo "  $name"
    wrangler r2 object put "$BUCKET/$VERSION/items/$name" \
        --file "$item" \
        --content-type "application/geo+json"
done

# Upload collection
echo
echo "Uploading collection.json..."
wrangler r2 object put "$BUCKET/$VERSION/collection.json" \
    --file "shards/$VERSION/collection.json" \
    --content-type "application/json"

# Upload root catalog (updates "latest" pointer)
echo
echo "Uploading catalog.json..."
wrangler r2 object put "$BUCKET/catalog.json" \
    --file "shards/catalog.json" \
    --content-type "application/json"

echo
echo "Done! Uploaded to R2 bucket '$BUCKET'"
echo
echo "STAC catalog URL:"
echo "  https://<your-r2-domain>/catalog.json"
echo
echo "To test locally:"
echo "  curl https://<your-r2-domain>/catalog.json"
