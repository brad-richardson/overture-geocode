# Project Roadmap

## Phase 1: Core Forward Geocoding (Massachusetts)

### Indexing Pipeline
- [x] Set up DuckDB extraction script (`scripts/download_addresses.sql`)
- [x] Filter Overture addresses for Massachusetts
- [x] Build display_name and search_text transformations
- [x] Export to Parquet with ZSTD compression
- [x] Create SQLite FTS5 index builder (`scripts/build_index.py`)
- [x] Generate `indexes/US-MA.db`
- [x] Verify index size and query performance

### Cloudflare Worker
- [x] Initialize Wrangler project
- [x] Create `/search` endpoint
- [x] Implement FTS5 query with BM25 ranking
- [ ] Add query parameter parsing (limit, viewbox, bounded)
- [ ] Deploy to Cloudflare Workers
- [ ] Upload MA index to D1

### Divisions Support (Priority!)
- [x] Add STAC client for dynamic release discovery
- [x] Extract Overture divisions for MA (localities, neighborhoods)
- [x] Add divisions table with FTS to index (unified `features` table)
- [x] Update search to query both divisions and addresses
- [x] Rank divisions higher than addresses (cities before street addresses)
- [x] Include population in ranking

### E2E Tests
- [ ] Add E2E tests for search ranking (boston → city first, cambridge → city first)
- [ ] Add E2E tests for division types (locality, neighborhood, county)
- [ ] Add E2E tests for address search (123 main → addresses returned)
- [ ] Add E2E tests for /lookup endpoint with GERS IDs

### Python Client
- [x] Create package structure (`clients/python/`)
- [x] Implement `OvertureGeocoder.search()`
- [x] Add DuckDB-based `get_geometry()` for GERS lookups
- [ ] Write basic tests
- [ ] Publish to PyPI (optional)

### JavaScript Client
- [x] Create package structure (`clients/js/`)
- [x] Implement browser + Node.js client
- [ ] Add DuckDB-WASM support for client-side geometry
- [ ] Write basic tests
- [ ] Publish to npm (optional)

## Phase 2: Full US Coverage

- [ ] Extend extraction script for all 50 states
- [ ] Automate state partitioning and index generation
- [ ] Add state routing logic to Worker (detect state from query)
- [ ] Deploy state-sharded D1 databases
- [ ] Add viewbox/bounded filtering

## Phase 3: Reverse Geocoding

- [ ] Add H3 spatial index to address schema
- [ ] Implement `/reverse` endpoint
- [ ] Add H3 cell query with neighbor expansion
- [ ] Distance-based ranking for results

## Phase 4: Places (POIs)

- [ ] Extract Overture places theme (64M POIs)
- [ ] Create combined search across addresses + places + divisions
- [ ] Add category filtering for places

## Infrastructure

- [x] Add STAC client (`stac.overturemaps.org`) for dynamic release discovery
- [ ] Auto-detect latest Overture release in scripts
- [ ] Set up GitHub Actions for CI/CD

## Stretch Goals

- [ ] Add address autocomplete endpoint (`/autocomplete`)
- [ ] Implement structured query parsing (street, city, state fields)
- [ ] Add batch geocoding endpoint
- [ ] Create OpenAPI/Swagger documentation
- [ ] Add rate limiting and API keys
- [ ] Create hosted demo instance

## Cost Tracking

| Date | Scale | D1 Storage | Monthly Cost |
|------|-------|------------|--------------|
| 2024-12-31 | MA addresses only | 822MB | $0 (local) |
| TBD | MA + divisions | ~850MB | $0 |
| TBD | US full | ~15GB | ~$5 |

## Notes

- Overture release schedule: Monthly updates
- GERS IDs are stable across releases (325M+ retained)
- Cloudflare D1 free tier: 500MB/db, 10 dbs max, 5M reads/day
- Use `stac.overturemaps.org` for discovering latest release
