# Implementation Specification

## Overview

Forward geocoder using Overture Maps address and division data.

## Data Source

**Overture Maps Addresses Theme**
- Location: `s3://overturemaps-us-west-2/release/{release}/theme=addresses/type=address/*.parquet`
- Current release: `2024-12-18.0`
- Schema: [docs.overturemaps.org/schema/reference/addresses/address](https://docs.overturemaps.org/schema/reference/addresses/address/)

### Address Schema (relevant fields)
```
id: string              # GERS UUID
geometry: Point (WKB)   # Location
bbox: struct            # {xmin, ymin, xmax, ymax}
country: string         # ISO 3166-1 alpha-2
postcode: string
street: string
number: string
unit: string
address_levels: array   # [{level: int, value: string}, ...]
                        # Level 1 = state, Level 3 = city (US)
```

## Storage Design

### Minimal Index Schema (SQLite + FTS5)

```sql
CREATE TABLE addresses (
    rowid INTEGER PRIMARY KEY,
    gers_id TEXT NOT NULL,           -- 36-char UUID with dashes
    display_name TEXT NOT NULL,      -- "123 Main St, Boston, MA 02101"
    bbox_xmin REAL NOT NULL,
    bbox_ymin REAL NOT NULL,
    bbox_xmax REAL NOT NULL,
    bbox_ymax REAL NOT NULL
);

CREATE VIRTUAL TABLE addresses_fts USING fts5(
    search_text,                     -- "123 main st boston 02101"
    content=addresses,
    content_rowid=rowid,
    tokenize='porter unicode61 remove_diacritics 1'
);

CREATE INDEX idx_gers ON addresses(gers_id);
```

### Size Estimates

| Component | Per Record | MA (3M) | US (121M) |
|-----------|------------|---------|-----------|
| gers_id (36 chars) | 36B | 108MB | 4.4GB |
| display_name (avg 45 chars) | 45B | 135MB | 5.5GB |
| bbox (4 floats) | 16B | 48MB | 1.9GB |
| FTS tokens + overhead | ~50B | 150MB | 6GB |
| SQLite overhead | ~20B | 60MB | 2.4GB |
| **Total** | ~167B | **~500MB** | **~20GB** |

Note: With compression and FTS5 optimizations, actual size is ~60-70% of raw estimate.

## API Design

### Forward Geocoding: `/search`

**Request**
```
GET /search?q={query}&format=jsonv2&limit=10&countrycodes=US
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| q | string | required | Free-form search query |
| format | string | jsonv2 | Response format (json, jsonv2, geojson) |
| limit | int | 10 | Max results (1-40) |
| countrycodes | string | - | ISO country codes (comma-separated) |
| addressdetails | int | 0 | Include address breakdown (0 or 1) |
| viewbox | string | - | Bounding box `lon1,lat1,lon2,lat2` |
| bounded | int | 0 | Restrict to viewbox (0 or 1) |

**Response**
```json
[
  {
    "gers_id": "01234567-89ab-cdef-0123-456789abcdef",
    "display_name": "123 Main St, Boston, MA 02101",
    "lat": "42.3601",
    "lon": "-71.0589",
    "boundingbox": ["42.360", "42.361", "-71.059", "-71.058"],
    "importance": 0.85,
    "type": "address",
    "address": {
      "house_number": "123",
      "road": "Main St",
      "city": "Boston",
      "state": "MA",
      "postcode": "02101",
      "country": "US",
      "country_code": "us"
    }
  }
]
```

### GERS Lookup: `/lookup`

**Request**
```
GET /lookup?gers_ids={gers_id},{gers_id}&format=geojson
```

**Response**
```json
{
  "type": "Feature",
  "id": "01234567-89ab-cdef-0123-456789abcdef",
  "geometry": {
    "type": "Point",
    "coordinates": [-71.0589, 42.3601]
  },
  "properties": {
    "country": "US",
    "postcode": "02101",
    "street": "Main St",
    "number": "123"
  }
}
```

## Indexing Pipeline

### Step 1: Extract from Overture (DuckDB)

```sql
-- scripts/download_addresses.sql
INSTALL httpfs; LOAD httpfs;
SET s3_region = 'us-west-2';

COPY (
    SELECT
        id as gers_id,
        bbox.xmin, bbox.ymin, bbox.xmax, bbox.ymax,
        country, postcode, street, number, unit,
        address_levels
    FROM read_parquet(
        's3://overturemaps-us-west-2/release/2024-12-18.0/theme=addresses/type=address/*'
    )
    WHERE country = 'US'
      AND list_extract(
          list_filter(address_levels, x -> x.level = 1),
          1
      ).value = 'Massachusetts'
) TO 'exports/US-MA.parquet' (FORMAT PARQUET, COMPRESSION ZSTD);
```

### Step 2: Build FTS Index (Python)

```python
# scripts/build_index.py
import duckdb
import sqlite3

def build_index(parquet_path: str, output_db: str):
    # Read parquet
    con = duckdb.connect()
    df = con.execute(f"""
        SELECT
            gers_id,
            bbox_xmin, bbox_ymin, bbox_xmax, bbox_ymax,
            -- Build display name
            CONCAT_WS(', ',
                CONCAT_WS(' ', number, street, unit),
                city,
                CONCAT(state, ' ', postcode)
            ) as display_name,
            -- Build search tokens
            LOWER(CONCAT_WS(' ', number, street, city, postcode)) as search_text
        FROM read_parquet('{parquet_path}')
    """).fetchdf()

    # Create SQLite with FTS5
    db = sqlite3.connect(output_db)
    # ... insert rows and build FTS index
```

## Client Libraries

### Python Client

```python
# clients/python/overture_geocoder/client.py

class OvertureGeocoder:
    def __init__(self, api_url: str = "https://geocoder.example.com"):
        self.api_url = api_url
        self._duckdb = None  # Lazy init for geometry fetching

    def search(self, query: str, **kwargs) -> List[GeocoderResult]:
        """Nominatim-compatible search."""
        pass

    def get_geometry(self, gers_id: str) -> Optional[GeoJSON]:
        """Fetch full geometry from Overture S3 via DuckDB."""
        pass
```

### JavaScript Client

```typescript
// clients/js/src/client.ts

export class OvertureGeocoder {
    constructor(options?: { apiUrl?: string });

    search(query: string, options?: SearchOptions): Promise<GeocoderResult[]>;

    getGeometry(gersId: string): Promise<GeoJSON.Feature | null>;
}
```

## Hosting

### Cloudflare Stack

| Service | Purpose | Free Tier |
|---------|---------|-----------|
| Workers | API endpoints | 100K req/day |
| D1 | FTS5 index storage | 5GB, 5M reads/day |
| R2 | Geometry cache (optional) | 10GB, 1M reads/mo |

### Deployment

```toml
# wrangler.toml
name = "overture-geocoder"
main = "src/worker.ts"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB_MA"
database_name = "geocoder-us-ma"
database_id = "xxx"
```

## Future: Reverse Geocoding

Add H3 spatial index for point-to-address queries:

```sql
ALTER TABLE addresses ADD COLUMN h3_res10 TEXT;
CREATE INDEX idx_h3 ON addresses(h3_res10);
```

Query pattern:
1. Convert lat/lon → H3 cell (resolution 10, ~66m)
2. Query addresses in cell + neighbors (7-cell ring)
3. Sort by distance, return closest

## Future: Places & Divisions

Extend to search POIs and administrative boundaries:
- Places: 64M POIs with names, categories, addresses
- Divisions: Administrative boundaries for disambiguation

Same FTS5 pattern, separate tables or combined with type filtering.
