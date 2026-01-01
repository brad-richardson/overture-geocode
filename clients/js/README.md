# Overture Geocoder - JavaScript/TypeScript Client

Forward geocoder using Overture Maps data with Nominatim-compatible API.

## Installation

### From GitHub (during development)

```bash
npm install github:Brad-Richardson/overture-geocoder#path:clients/js
```

### From npm (when published)

```bash
npm install overture-geocoder
```

## Usage

### Basic Search

```typescript
import { OvertureGeocoder } from 'overture-geocoder';

const geocoder = new OvertureGeocoder();

// Search for a place
const results = await geocoder.search('Boston, MA');
console.log(results[0].primary_name); // "Boston, MA"
console.log(results[0].lat, results[0].lon); // 42.3588336, -71.0578303

// Lookup by GERS ID
const lookup = await geocoder.lookup('5df2793f-5a0a-4fcf-bd3c-7edb8cc495d8');
```

### Convenience Functions

```typescript
import { geocode, lookup } from 'overture-geocoder';

// Quick one-off search
const results = await geocode('Cambridge, MA', { limit: 5 });

// Quick lookup
const places = await lookup(['gers-id-1', 'gers-id-2']);
```

### GeoJSON Output

```typescript
const geojson = await geocoder.searchGeoJSON('Boston');
// Returns FeatureCollection with Point geometries
```

### Full Geometry Fetching (Optional)

To fetch full geometries from Overture S3, install the optional DuckDB dependency:

```bash
npm install @duckdb/duckdb-wasm
```

Then use:

```typescript
const geometry = await geocoder.getGeometry('gers-id');
// Returns full polygon/multipolygon geometry from Overture
```

**Note:** DuckDB-WASM is ~15MB and only needed for `getGeometry()`. Basic search and lookup work without it.

## Configuration

```typescript
const geocoder = new OvertureGeocoder({
  baseUrl: 'https://overture-geocoder.bradr.workers.dev', // default
  timeout: 30000, // ms
  retries: 3,
  retryDelay: 1000, // ms
});
```

## Types

All types are exported for TypeScript users:

```typescript
import type {
  GeocoderResult,
  SearchOptions,
  OvertureGeocoderConfig,
  GeoJSONFeature,
  GeoJSONFeatureCollection,
  // STAC types for advanced usage
  StacCatalog,
  GersRegistry,
} from 'overture-geocoder';
```

## API Reference

### `OvertureGeocoder`

- `search(query: string, options?: SearchOptions): Promise<GeocoderResult[]>`
- `searchGeoJSON(query: string, options?: SearchOptions): Promise<GeoJSONFeatureCollection>`
- `lookup(gersIds: string | string[]): Promise<GeocoderResult[]>`
- `lookupGeoJSON(gersIds: string | string[]): Promise<GeoJSONFeatureCollection>`
- `getGeometry(gersId: string): Promise<GeoJSONFeature | null>` (requires @duckdb/duckdb-wasm)
- `close(): Promise<void>` - Release DuckDB resources if initialized

### `SearchOptions`

```typescript
interface SearchOptions {
  limit?: number;        // 1-40, default: 10
  countrycodes?: string; // e.g., "us,ca"
  viewbox?: [number, number, number, number]; // [lon1, lat1, lon2, lat2]
  bounded?: boolean;     // Restrict to viewbox
  addressdetails?: boolean;
  format?: 'json' | 'jsonv2' | 'geojson';
}
```

### `GeocoderResult`

```typescript
interface GeocoderResult {
  gers_id: string;
  primary_name: string;
  lat: number;
  lon: number;
  boundingbox: [number, number, number, number];
  importance: number;
  type?: string;
  address?: AddressDetails;
}
```

## License

MIT
