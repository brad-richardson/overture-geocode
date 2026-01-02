# Implementation Specification

## Overview

Forward and reverse geocoder using Overture Maps division data (administrative boundaries).

## Data Source

**Overture Maps Divisions Theme**
- Location: `s3://overturemaps-us-west-2/release/{release}/theme=divisions/type=division/*.parquet`
- Current release: `2024-12-18.0`
- Schema: [docs.overturemaps.org/schema/reference/divisions/division](https://docs.overturemaps.org/schema/reference/divisions/division/)

### Division Schema (relevant fields)
```
id: string              # GERS UUID
geometry: Polygon (WKB) # Boundary polygon
bbox: struct            # {xmin, ymin, xmax, ymax}
subtype: string         # locality, county, region, country, etc.
names: struct           # Primary and alternate names
population: int         # Population count (where available)
```

## Storage Design

### Forward Geocoding Schema (SQLite + FTS5)

```sql
CREATE TABLE divisions (
    rowid INTEGER PRIMARY KEY,
    gers_id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,              -- Division subtype
    primary_name TEXT NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    bbox_xmin REAL NOT NULL,
    bbox_ymin REAL NOT NULL,
    bbox_xmax REAL NOT NULL,
    bbox_ymax REAL NOT NULL,
    population INTEGER,
    country TEXT,
    region TEXT
);

CREATE VIRTUAL TABLE divisions_fts USING fts5(
    search_text,
    content=divisions,
    content_rowid=rowid,
    tokenize='porter unicode61 remove_diacritics 1',
    prefix='2 3'                     -- For autocomplete support
);
```

### Reverse Geocoding Schema

```sql
CREATE TABLE divisions_reverse (
    rowid INTEGER PRIMARY KEY,
    gers_id TEXT NOT NULL UNIQUE,
    subtype TEXT NOT NULL,
    primary_name TEXT NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    bbox_xmin REAL NOT NULL,
    bbox_ymin REAL NOT NULL,
    bbox_xmax REAL NOT NULL,
    bbox_ymax REAL NOT NULL,
    area REAL NOT NULL,              -- For sorting by specificity
    population INTEGER,
    country TEXT,
    region TEXT
);

CREATE INDEX idx_bbox ON divisions_reverse(bbox_xmin, bbox_xmax, bbox_ymin, bbox_ymax);
CREATE INDEX idx_area ON divisions_reverse(area);
```

### Size Estimates

| Component | Per Record | Global (~500K) |
|-----------|------------|----------------|
| gers_id (36 chars) | 36B | 18MB |
| primary_name (avg 30 chars) | 30B | 15MB |
| bbox (4 floats) | 16B | 8MB |
| FTS tokens + overhead | ~40B | 20MB |
| SQLite overhead | ~20B | 10MB |
| **Total** | ~142B | **~70MB** |

Note: With compression and FTS5 optimizations, actual size is ~60-70% of raw estimate.

## API Design

### Forward Geocoding: `/search`

**Request**
```
GET /search?q={query}&format=jsonv2&limit=10
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| q | string | required | Free-form search query |
| format | string | jsonv2 | Response format (json, jsonv2, geojson) |
| limit | int | 10 | Max results (1-40) |
| autocomplete | int | 1 | Enable autocomplete mode (0 or 1) |

**Response**
```json
[
  {
    "gers_id": "01234567-89ab-cdef-0123-456789abcdef",
    "primary_name": "Boston",
    "lat": 42.3601,
    "lon": -71.0589,
    "boundingbox": [42.227, 42.397, -71.191, -70.923],
    "importance": 0.85,
    "type": "locality"
  }
]
```

### Reverse Geocoding: `/reverse`

**Request**
```
GET /reverse?lat={lat}&lon={lon}&format=jsonv2
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| lat | float | required | Latitude (-90 to 90) |
| lon | float | required | Longitude (-180 to 180) |
| format | string | jsonv2 | Response format (jsonv2, geojson) |

**Response**
```json
[
  {
    "gers_id": "01234567-89ab-cdef-0123-456789abcdef",
    "primary_name": "Boston",
    "subtype": "locality",
    "lat": 42.3601,
    "lon": -71.0589,
    "boundingbox": [42.227, 42.397, -71.191, -70.923],
    "distance_km": 0.12,
    "confidence": "bbox",
    "hierarchy": [
      {"gers_id": "...", "subtype": "locality", "name": "Boston"},
      {"gers_id": "...", "subtype": "county", "name": "Suffolk County"},
      {"gers_id": "...", "subtype": "region", "name": "Massachusetts"}
    ]
  }
]
```

**Note:** Reverse geocoding uses bounding box filtering only, not precise point-in-polygon checks. Results include all divisions whose bounding box contains the query point. For precise containment checks, use the client library's `verifyContainsPoint()` method which fetches the full polygon from Overture S3.

## Indexing Pipeline

### Step 1: Extract from Overture (DuckDB)

```sql
-- scripts/download_divisions.sql
INSTALL httpfs; LOAD httpfs;
SET s3_region = 'us-west-2';

COPY (
    SELECT
        id as gers_id,
        subtype,
        names.primary as primary_name,
        ST_Y(ST_Centroid(geometry)) as lat,
        ST_X(ST_Centroid(geometry)) as lon,
        bbox.xmin, bbox.ymin, bbox.xmax, bbox.ymax,
        population
    FROM read_parquet(
        's3://overturemaps-us-west-2/release/2024-12-18.0/theme=divisions/type=division/*'
    )
) TO 'exports/divisions-global.parquet' (FORMAT PARQUET, COMPRESSION ZSTD);
```

### Step 2: Build FTS Index (Python)

```python
# scripts/build_divisions_index.py
import duckdb
import sqlite3

def build_index(parquet_path: str, output_db: str):
    con = duckdb.connect()
    df = con.execute(f"""
        SELECT
            gers_id, subtype, primary_name,
            lat, lon,
            bbox_xmin, bbox_ymin, bbox_xmax, bbox_ymax,
            population,
            LOWER(primary_name) as search_text
        FROM read_parquet('{parquet_path}')
    """).fetchdf()

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
binding = "DB_DIVISIONS"
database_name = "geocoder-divisions"
database_id = "xxx"

[[d1_databases]]
binding = "DB_DIVISIONS_REVERSE"
database_name = "geocoder-divisions-reverse"
database_id = "yyy"
```

### Why Cloudflare?

**Decision factors:**
1. **Simplicity** - Native D1/Workers integration, zero configuration
2. **Edge performance** - Queries served from nearest data center globally
3. **Scaling model** - Per-state databases fit D1's 10GB limit naturally
4. **Cost at scale** - ~$50-60/mo for full US + global (well under $100 threshold)

**Alternatives considered:**

| Option | Pros | Why Not |
|--------|------|---------|
| Turso | Same SQLite/FTS5, better free tier (9GB) | Migration work for marginal savings |
| Self-hosted VPS | Cheapest (~$7/mo Hetzner) | Single region, operational burden |
| Supabase | Managed PostgreSQL | 8GB limit, would need FTS5 rewrite |

**Cost projections:**

| Scale | D1 Storage | Reads | Total |
|-------|------------|-------|-------|
| 5 states (demo) | ~5GB | Free tier | ~$0-4/mo |
| 50 states (full US) | ~45GB | Free tier | ~$34/mo |
| US + global places | ~65GB | + buffer | ~$50-60/mo |

D1's free tier includes 5M reads/day - sufficient for demo/moderate production use.

## Future Improvements

### Address Geocoding (Client-Side)

Future: Add client-side address geocoding using the overturemaps library to query the Overture addresses theme directly from S3. This would allow street-level address lookup without server-side storage.

### Point-in-Polygon Verification

Current reverse geocoding uses bounding box filtering only. For precise containment verification:
- Client libraries provide `verifyContainsPoint()` which fetches full polygon from Overture S3
- Future: Consider server-side verification using lightweight polygon representations

### Places Integration

Extend to search POIs from the Overture Places theme:
- 64M POIs with names, categories, addresses
- Same FTS5 pattern, separate table with category filtering
