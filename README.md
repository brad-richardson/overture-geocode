# Overture Geocoder

A forward (and eventually reverse) geocoder built on [Overture Maps](https://overturemaps.org/) data with minimal infrastructure costs.

## Features

- **Forward geocoding**: Search addresses and places by free-form text query
- **Divisions support**: Cities and neighborhoods rank higher than street addresses
- **Minimal storage**: Index only searchable tokens + GERS IDs (~100MB per state)
- **On-demand geometry**: Full Overture data fetched via GERS ID when needed
- **Zero egress costs**: Client-side DuckDB queries Overture S3 directly

## Architecture

```
Client (Python/JS)
    │
    ├── /search ──────► Cloudflare Worker ──► D1 (FTS5 Index)
    │
    └── getGeometry() ──► DuckDB ──► Overture S3 (free egress)
```

## Quick Start

### Python

```python
from overture_geocoder import geocode

results = geocode("123 main st boston ma")
print(results[0].display_name)
# "123 Main St, Boston, MA 02101"

# Get full geometry (queries Overture S3 directly)
geometry = results[0].get_geometry()
```

### JavaScript

```typescript
import { geocode } from 'overture-geocoder';

const results = await geocode("123 main st boston ma");
console.log(results[0].display_name);

const geometry = await results[0].getGeometry();
```

## Cost Estimates

| Scale | Storage | Monthly Cost |
|-------|---------|--------------|
| Prototype (MA) | ~100MB | $0 (Cloudflare free tier) |
| US (50 states) | ~15GB | $0-5 (D1 paid tier) |
| Global | ~50GB | $5-20 (D1 + R2 cache) |

## Data Source

Uses [Overture Maps](https://overturemaps.org/) address data:
- 455M global addresses
- GERS IDs for stable entity references
- Monthly releases with incremental updates

## License

MIT
