/**
 * Overture Geocoder v2 - R2 Shards + sql.js
 *
 * Forward geocoding API using Overture Maps data stored in R2 SQLite shards.
 */

// sql.js CDN URLs
const SQL_JS_URL = "https://cdn.jsdelivr.net/npm/sql.js@1.11.0/dist/sql-wasm.js";
const SQL_WASM_URL = "https://cdn.jsdelivr.net/npm/sql.js@1.11.0/dist/sql-wasm.wasm";

// Types for sql.js
interface SqlJsDatabase {
  prepare(sql: string): SqlJsStatement;
  close(): void;
}

interface SqlJsStatement {
  bind(params: unknown[]): void;
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  free(): void;
}

interface SqlJsStatic {
  Database: new (data: Uint8Array) => SqlJsDatabase;
}

type Database = SqlJsDatabase;

export interface Env {
  SHARDS_BUCKET: R2Bucket;
  ENVIRONMENT: string;
}

// STAC catalog types
interface StacCatalog {
  links: Array<{ rel: string; href: string; latest?: boolean }>;
}

interface StacCollection {
  id: string;
  links: Array<{ rel: string; href: string }>;
}

interface StacItem {
  id: string;
  properties: { record_count: number };
  assets: { data: { href: string } };
}

// Geocoder types
interface GeocoderResult {
  gers_id: string;
  name: string;
  type: string;
  lat: number;
  lon: number;
  bbox: [number, number, number, number];
  importance: number;
  country?: string;
  region?: string;
}

interface DivisionRow {
  gers_id: string;
  type: string;
  primary_name: string;
  lat: number;
  lon: number;
  bbox_xmin: number;
  bbox_ymin: number;
  bbox_xmax: number;
  bbox_ymax: number;
  population: number | null;
  country: string | null;
  region: string | null;
  boosted_score: number;
}

// Cache sql.js initialization
let sqlPromise: Promise<SqlJsStatic> | null = null;

async function getSql(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    sqlPromise = (async () => {
      // Fetch WASM from CDN
      const wasmResponse = await fetch(SQL_WASM_URL);
      const wasmBinary = await wasmResponse.arrayBuffer();
      return initSqlJs({ wasmBinary });
    })();
  }
  return sqlPromise;
}

/**
 * Prepare FTS5 query from user input.
 */
function prepareFtsQuery(query: string, autocomplete: boolean = true): string {
  const tokens = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return "";

  return tokens
    .map((t, i) =>
      autocomplete && i === tokens.length - 1 ? `"${t}"*` : `"${t}"`
    )
    .join(" ");
}

/**
 * Load STAC catalog and find the latest version.
 */
async function loadLatestVersion(bucket: R2Bucket): Promise<string> {
  const catalogObj = await bucket.get("catalog.json");
  if (!catalogObj) throw new Error("catalog.json not found");

  const catalog: StacCatalog = await catalogObj.json();
  const latestLink = catalog.links.find((l) => l.rel === "child" && l.latest);
  if (!latestLink) throw new Error("No latest collection found");

  // Extract version from href like "./2026-01-02.0/collection.json"
  const version = latestLink.href.replace("./", "").split("/")[0];
  return version;
}

/**
 * Check if a country shard exists in the collection.
 */
async function hasCountryShard(
  bucket: R2Bucket,
  version: string,
  country: string
): Promise<boolean> {
  const collectionObj = await bucket.get(`${version}/collection.json`);
  if (!collectionObj) return false;

  const collection: StacCollection = await collectionObj.json();
  return collection.links.some(
    (l) => l.rel === "item" && l.href.includes(`/${country}.json`)
  );
}

/**
 * Load a shard database from R2.
 */
async function loadShard(
  bucket: R2Bucket,
  version: string,
  shardId: string,
  SQL: SqlJsStatic
): Promise<Database> {
  // Get shard item metadata
  const itemObj = await bucket.get(`${version}/items/${shardId}.json`);
  if (!itemObj) throw new Error(`Shard item ${shardId} not found`);

  const item: StacItem = await itemObj.json();
  const shardHref = item.assets.data.href.replace("./", "");

  // Load the actual database
  const dbObj = await bucket.get(`${version}/${shardHref}`);
  if (!dbObj) throw new Error(`Shard database ${shardId} not found`);

  const buffer = await dbObj.arrayBuffer();
  console.log(`Loaded shard ${shardId}: ${buffer.byteLength} bytes, ${item.properties.record_count} records`);

  return new SQL.Database(new Uint8Array(buffer));
}

/**
 * Search a shard database using FTS5.
 */
function searchShard(db: Database, ftsQuery: string, limit: number): DivisionRow[] {
  const stmt = db.prepare(`
    SELECT
      d.gers_id,
      d.type,
      d.primary_name,
      d.lat,
      d.lon,
      d.bbox_xmin,
      d.bbox_ymin,
      d.bbox_xmax,
      d.bbox_ymax,
      d.population,
      d.country,
      d.region,
      CASE
        WHEN d.population IS NOT NULL
        THEN bm25(divisions_fts) - (LOG(d.population + 1) * 2.0)
        ELSE bm25(divisions_fts) - 2.0
      END as boosted_score
    FROM divisions_fts
    JOIN divisions d ON divisions_fts.rowid = d.rowid
    WHERE divisions_fts MATCH ?
    ORDER BY boosted_score
    LIMIT ?
  `);

  stmt.bind([ftsQuery, limit]);

  const results: DivisionRow[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject() as unknown as DivisionRow;
    results.push(row);
  }
  stmt.free();

  return results;
}

/**
 * Apply location bias to results.
 */
function applyLocationBias(
  results: GeocoderResult[],
  biasCountry: string | null
): GeocoderResult[] {
  if (!biasCountry) return results;

  // Boost results from the bias country
  return results
    .map((r) => ({
      ...r,
      importance: r.country === biasCountry ? r.importance + 0.2 : r.importance,
    }))
    .sort((a, b) => b.importance - a.importance);
}

/**
 * Deduplicate results by gers_id.
 */
function deduplicateResults(results: GeocoderResult[]): GeocoderResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    if (seen.has(r.gers_id)) return false;
    seen.add(r.gers_id);
    return true;
  });
}

/**
 * Handle /search endpoint.
 */
async function handleSearch(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);

  // Parse query parameters
  const q = url.searchParams.get("q") || "";
  const format = url.searchParams.get("format") || "json";
  const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") || "10") || 10), 40);
  const autocomplete = url.searchParams.get("autocomplete") !== "0";

  if (!q.trim()) {
    return jsonResponse({ results: [] });
  }

  if (q.length > 200) {
    return jsonResponse({ error: "Query too long: max 200 characters" }, 400);
  }

  const ftsQuery = prepareFtsQuery(q, autocomplete);
  if (!ftsQuery) {
    return jsonResponse({ results: [] });
  }

  try {
    const SQL = await getSql();
    const version = await loadLatestVersion(env.SHARDS_BUCKET);

    // Get country from Cloudflare headers for bias
    const cfCountry = request.headers.get("CF-IPCountry");

    // Load HEAD shard (always)
    const headDb = await loadShard(env.SHARDS_BUCKET, version, "HEAD", SQL);
    let allResults = searchShard(headDb, ftsQuery, limit * 5);
    headDb.close();

    // Load country shard if available
    if (cfCountry && await hasCountryShard(env.SHARDS_BUCKET, version, cfCountry)) {
      try {
        const countryDb = await loadShard(env.SHARDS_BUCKET, version, cfCountry, SQL);
        const countryResults = searchShard(countryDb, ftsQuery, limit * 5);
        allResults = allResults.concat(countryResults);
        countryDb.close();
      } catch (e) {
        console.log(`Warning: failed to load country shard ${cfCountry}:`, e);
      }
    }

    // Convert to GeocoderResult format
    let results: GeocoderResult[] = allResults.map((row) => ({
      gers_id: row.gers_id,
      name: row.primary_name,
      type: row.type,
      lat: row.lat,
      lon: row.lon,
      // GeoJSON bbox order: [min_lon, min_lat, max_lon, max_lat]
      bbox: [row.bbox_xmin, row.bbox_ymin, row.bbox_xmax, row.bbox_ymax],
      importance: Math.max(0, Math.min(1, -row.boosted_score / 50)),
      country: row.country || undefined,
      region: row.region || undefined,
    }));

    // Deduplicate, apply bias, sort, and truncate
    results = deduplicateResults(results);
    results = applyLocationBias(results, cfCountry);
    results.sort((a, b) => b.importance - a.importance);
    results = results.slice(0, limit);

    // Format response
    if (format === "geojson") {
      return jsonResponse({
        type: "FeatureCollection",
        features: results.map((r) => ({
          type: "Feature",
          properties: {
            gers_id: r.gers_id,
            name: r.name,
            type: r.type,
            importance: r.importance,
            country: r.country,
            region: r.region,
          },
          geometry: {
            type: "Point",
            coordinates: [r.lon, r.lat],
          },
          bbox: r.bbox,
        })),
      });
    }

    return jsonResponse({ results });
  } catch (e) {
    console.error("Search error:", e);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}

/**
 * Handle /reverse endpoint (stub).
 */
async function handleReverse(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  const lat = parseFloat(url.searchParams.get("lat") || "");
  const lon = parseFloat(url.searchParams.get("lon") || "");

  if (isNaN(lat) || lat < -90 || lat > 90) {
    return jsonResponse({ error: "lat must be between -90 and 90" }, 400);
  }
  if (isNaN(lon) || lon < -180 || lon > 180) {
    return jsonResponse({ error: "lon must be between -180 and 180" }, 400);
  }

  return jsonResponse({ error: "Reverse geocoding not yet implemented for R2 shards" }, 501);
}

/**
 * Create JSON response with CORS headers.
 */
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const url = new URL(request.url);

    switch (url.pathname) {
      case "/search":
        return handleSearch(request, env);

      case "/reverse":
        return handleReverse(request, env);

      case "/health":
        return new Response("ok");

      case "/":
        return jsonResponse({
          name: "overture-geocoder",
          version: "0.2.0",
          endpoints: ["/search", "/reverse"],
        });

      default:
        return jsonResponse({ error: "Not found" }, 404);
    }
  },
};
