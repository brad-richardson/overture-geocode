/**
 * Overture Geocoder - Cloudflare Worker
 *
 * Forward geocoding API using Overture Maps data.
 */

// Rate limiter binding type
interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  // Global divisions database (forward geocoding)
  DB_DIVISIONS: D1Database;
  // Reverse geocoding database
  DB_DIVISIONS_REVERSE?: D1Database;
  // Rate limiting
  RATE_LIMITER: RateLimiter;
}

interface GeocoderResult {
  gers_id: string;
  primary_name: string;
  lat: number;
  lon: number;
  boundingbox: [number, number, number, number];
  importance: number;
  type: string;
}

interface DivisionRow {
  rowid: number;
  gers_id: string;
  type: string;
  primary_name: string;
  lat: number;
  lon: number;
  bbox_xmin: number;
  bbox_ymin: number;
  bbox_xmax: number;
  bbox_ymax: number;
  population?: number;
  country?: string;
  region?: string;
  boosted_score: number;
}

// Reverse geocoding types
interface ReverseGeocoderResult {
  gers_id: string;
  primary_name: string;
  subtype: string;
  lat: number;
  lon: number;
  boundingbox: [number, number, number, number];
  distance_km: number;
  confidence: "exact" | "bbox" | "approximate";
  hierarchy?: HierarchyEntry[];
}

interface HierarchyEntry {
  gers_id: string;
  subtype: string;
  name: string;
}

interface DivisionReverseRow {
  gers_id: string;
  subtype: string;
  primary_name: string;
  lat: number;
  lon: number;
  bbox_xmin: number;
  bbox_ymin: number;
  bbox_xmax: number;
  bbox_ymax: number;
  area: number;
  population: number | null;
  country: string | null;
  region: string | null;
}

/**
 * Prepare FTS5 query from user input.
 * Handles common query patterns and escapes special characters.
 * @param query - User search query
 * @param autocomplete - If true, adds prefix wildcard to last token for autocomplete behavior
 */
function prepareFtsQuery(query: string, autocomplete: boolean = true): string {
  const tokens = query
    .toLowerCase()
    // Remove punctuation except hyphens and Unicode letters/numbers
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim()
    // Split into tokens and filter empty
    .split(" ")
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return "";

  // Quote each token; optionally add prefix wildcard to last token for autocomplete
  return tokens
    .map((t, i) =>
      autocomplete && i === tokens.length - 1 ? `"${t}"*` : `"${t}"`
    )
    .join(" ");
}

/**
 * Search global divisions database using FTS5.
 */
async function searchDivisions(
  db: D1Database | undefined,
  query: string,
  limit: number,
  autocomplete: boolean = true
): Promise<GeocoderResult[]> {
  if (!db) return [];

  const ftsQuery = prepareFtsQuery(query, autocomplete);
  if (!ftsQuery) return [];

  try {
    // Use population-based boosted ranking for divisions
    const stmt = db.prepare(`
      SELECT
        d.rowid,
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

    const result = await stmt.bind(ftsQuery, limit).all<DivisionRow>();

    return (result.results || []).map((row) => ({
      gers_id: row.gers_id,
      primary_name: row.primary_name,
      lat: row.lat,
      lon: row.lon,
      boundingbox: [row.bbox_ymin, row.bbox_ymax, row.bbox_xmin, row.bbox_xmax] as [number, number, number, number],
      // boosted_score is negative (lower = better match + higher population)
      // Convert to 0-1 importance: more negative = higher importance
      importance: Math.max(0, Math.min(1, -row.boosted_score / 50)),
      type: row.type,
    }));
  } catch (e) {
    console.error("Division search error:", e);
    throw e; // Propagate error for proper 500 response
  }
}

/**
 * Haversine distance between two points in km.
 */
function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Type priority for hierarchy ordering (lower = more specific)
const TYPE_PRIORITY: Record<string, number> = {
  neighborhood: 1,
  macrohood: 2,
  locality: 3,
  localadmin: 4,
  county: 5,
  region: 6,
  country: 7,
};

/**
 * Build hierarchy for a specific division.
 * Returns the division itself plus all containing (larger) divisions.
 * Sorted by type priority (most specific first).
 */
function buildHierarchyForDivision(
  currentDiv: DivisionReverseRow,
  allCandidates: DivisionReverseRow[]
): HierarchyEntry[] {
  // Filter to divisions with area >= current (includes itself and larger containing divisions)
  const containing = allCandidates.filter((div) => div.area >= currentDiv.area);

  // Deduplicate by subtype, keeping smallest area (candidates already sorted by area ASC)
  const seenSubtypes = new Set<string>();
  const deduped = containing.filter((div) => {
    if (seenSubtypes.has(div.subtype)) {
      return false;
    }
    seenSubtypes.add(div.subtype);
    return true;
  });

  return deduped
    .sort((a, b) => (TYPE_PRIORITY[a.subtype] || 0) - (TYPE_PRIORITY[b.subtype] || 0))
    .map((div) => ({
      gers_id: div.gers_id,
      subtype: div.subtype,
      name: div.primary_name,
    }));
}

/**
 * Handle /reverse endpoint.
 * Returns divisions containing or near the given coordinate.
 */
async function handleReverse(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);

  // Parse parameters
  const lat = parseFloat(url.searchParams.get("lat") || "");
  const lon = parseFloat(url.searchParams.get("lon") || "");
  const format = url.searchParams.get("format") || "jsonv2";

  // Validate coordinates
  if (isNaN(lat) || isNaN(lon)) {
    return jsonResponse({ error: "lat and lon parameters required" }, 400);
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return jsonResponse({ error: "Invalid coordinates" }, 400);
  }

  const db = env.DB_DIVISIONS_REVERSE;
  if (!db) {
    return jsonResponse({ error: "Reverse geocoding not available" }, 503);
  }

  try {
    // Find divisions whose bbox contains the point, sorted by area (smallest first)
    const stmt = db.prepare(`
      SELECT
        gers_id, subtype, primary_name,
        lat, lon,
        bbox_xmin, bbox_ymin, bbox_xmax, bbox_ymax,
        area, population, country, region
      FROM divisions_reverse
      WHERE bbox_xmin <= ?
        AND bbox_xmax >= ?
        AND bbox_ymin <= ?
        AND bbox_ymax >= ?
      ORDER BY area ASC
      LIMIT 50
    `);

    const result = await stmt.bind(lon, lon, lat, lat).all<DivisionReverseRow>();
    const candidates = result.results || [];

    if (candidates.length === 0) {
      return jsonResponse([]);
    }

    // Format results with per-division hierarchy
    const results: ReverseGeocoderResult[] = candidates.map((div) => ({
      gers_id: div.gers_id,
      primary_name: div.primary_name,
      subtype: div.subtype,
      lat: div.lat,
      lon: div.lon,
      boundingbox: [div.bbox_ymin, div.bbox_ymax, div.bbox_xmin, div.bbox_xmax],
      distance_km: Math.round(haversineDistance(lat, lon, div.lat, div.lon) * 100) / 100,
      confidence: "bbox" as const,
      hierarchy: buildHierarchyForDivision(div, candidates),
    }));

    if (format === "geojson") {
      return jsonResponse({
        type: "FeatureCollection",
        features: results.map((r) => ({
          type: "Feature",
          id: r.gers_id,
          properties: {
            gers_id: r.gers_id,
            primary_name: r.primary_name,
            subtype: r.subtype,
            distance_km: r.distance_km,
            confidence: r.confidence,
            hierarchy: r.hierarchy,
          },
          bbox: r.boundingbox,
          geometry: {
            type: "Point",
            coordinates: [r.lon, r.lat],
          },
        })),
      });
    }

    return jsonResponse(results);
  } catch (e) {
    console.error("Reverse geocoding error:", e);
    return jsonResponse({ error: "Internal error" }, 500);
  }
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
  const format = url.searchParams.get("format") || "jsonv2";
  const limit = Math.min(
    Math.max(1, parseInt(url.searchParams.get("limit") || "10") || 10),
    40
  );
  // autocomplete: default to 1 (enabled) for prefix matching on last token
  const autocomplete = url.searchParams.get("autocomplete") !== "0";

  if (!q.trim()) {
    return jsonResponse([]);
  }

  try {
    const results = await searchDivisions(env.DB_DIVISIONS, q, limit, autocomplete);

    // Handle different output formats
    if (format === "geojson") {
      return jsonResponse({
        type: "FeatureCollection",
        features: results.map((r) => ({
          type: "Feature",
          id: r.gers_id,
          properties: {
            gers_id: r.gers_id,
            primary_name: r.primary_name,
            importance: r.importance,
            type: r.type,
          },
          bbox: r.boundingbox,
          geometry: {
            type: "Point",
            coordinates: [r.lon, r.lat],
          },
        })),
      });
    }

    return jsonResponse(results);
  } catch (e) {
    console.error("Search error:", e);
    return jsonResponse({ error: "Internal error" }, 500);
  }
}

/**
 * Check rate limit for incoming request.
 * Returns a 429 response if limit exceeded, null otherwise.
 */
async function checkRateLimit(
  env: Env,
  request: Request
): Promise<Response | null> {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const { success } = await env.RATE_LIMITER.limit({ key: ip });

  if (!success) {
    return new Response(
      JSON.stringify({ error: "Rate limit exceeded. Please slow down." }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "60",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      }
    );
  }
  return null;
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

/**
 * Main request handler.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // Rate limit check
    const rateLimitResponse = await checkRateLimit(env, request);
    if (rateLimitResponse) return rateLimitResponse;

    const url = new URL(request.url);

    switch (url.pathname) {
      case "/search":
        return handleSearch(request, env);

      case "/reverse":
        return handleReverse(request, env);

      case "/":
        return jsonResponse({
          name: "Overture Geocoder",
          version: "0.2.0",
          endpoints: {
            search: "/search?q={query}",
            reverse: "/reverse?lat={lat}&lon={lon}",
          },
          documentation: "https://github.com/bradrichardson/overture-geocode",
        });

      default:
        return jsonResponse({ error: "Not found" }, 404);
    }
  },
};
