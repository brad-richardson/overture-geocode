/**
 * Overture Geocoder - Cloudflare Worker
 *
 * Forward geocoding API using Overture Maps data.
 */

export interface Env {
  // D1 database bindings (one per state)
  DB_MA: D1Database;
  // Add more states as needed:
  // DB_CA: D1Database;
  // DB_TX: D1Database;
}

interface GeocoderResult {
  gers_id: string;
  display_name: string;
  lat: string;
  lon: string;
  boundingbox: string[];
  importance: number;
  type: string;
  address?: AddressDetails;
}

interface AddressDetails {
  house_number?: string;
  road?: string;
  city?: string;
  state?: string;
  postcode?: string;
  country?: string;
  country_code?: string;
}

interface FeatureRow {
  rowid: number;
  gers_id: string;
  type: string;
  display_name: string;
  lat: number;
  lon: number;
  bbox_xmin: number;
  bbox_ymin: number;
  bbox_xmax: number;
  bbox_ymax: number;
  population?: number;
  city?: string;
  state?: string;
  postcode?: string;
  boosted_score: number;
}

/**
 * Get database bindings based on query analysis.
 * For now, only MA is supported.
 */
function getDatabases(env: Env, _query: string): D1Database[] {
  // TODO: Add state detection from query
  // For now, just return MA
  const dbs: D1Database[] = [];
  if (env.DB_MA) dbs.push(env.DB_MA);
  return dbs;
}

/**
 * Prepare FTS5 query from user input.
 * Handles common query patterns and escapes special characters.
 */
function prepareFtsQuery(query: string): string {
  return (
    query
      .toLowerCase()
      // Remove punctuation except hyphens in addresses
      .replace(/[^\w\s-]/g, " ")
      // Collapse whitespace
      .replace(/\s+/g, " ")
      .trim()
      // Split into tokens and filter empty
      .split(" ")
      .filter((t) => t.length > 0)
      // Quote each token to handle special characters
      .map((t) => `"${t}"`)
      .join(" ")
  );
}

/**
 * Search features (addresses and divisions) using FTS5.
 */
async function searchFeatures(
  dbs: D1Database[],
  query: string,
  limit: number,
  addressdetails: boolean
): Promise<GeocoderResult[]> {
  const ftsQuery = prepareFtsQuery(query);
  if (!ftsQuery) return [];

  const results: GeocoderResult[] = [];

  // Query each database in parallel
  const promises = dbs.map(async (db) => {
    try {
      // Use population-based boosted ranking:
      // - BM25 returns negative scores (more negative = better match)
      // - For divisions with population, subtract LOG(population)*2 to boost higher
      // - For divisions without population, subtract 2.0 as base boost
      // - Addresses get no boost (raw BM25 score)
      const stmt = db.prepare(`
        SELECT
          f.rowid,
          f.gers_id,
          f.type,
          f.display_name,
          f.lat,
          f.lon,
          f.bbox_xmin,
          f.bbox_ymin,
          f.bbox_xmax,
          f.bbox_ymax,
          f.population,
          f.city,
          f.state,
          f.postcode,
          CASE
            WHEN f.type != 'address' AND f.population IS NOT NULL
            THEN bm25(features_fts) - (LOG(f.population + 1) * 2.0)
            WHEN f.type != 'address'
            THEN bm25(features_fts) - 2.0
            ELSE bm25(features_fts)
          END as boosted_score
        FROM features_fts
        JOIN features f ON features_fts.rowid = f.rowid
        WHERE features_fts MATCH ?
        ORDER BY boosted_score
        LIMIT ?
      `);

      return await stmt.bind(ftsQuery, limit).all<FeatureRow>();
    } catch (e) {
      console.error("Search error:", e);
      return { results: [] };
    }
  });

  const allResults = await Promise.all(promises);

  // Merge results from all databases
  for (const result of allResults) {
    if (result.results) {
      for (const row of result.results) {
        const geocoderResult: GeocoderResult = {
          gers_id: row.gers_id,
          display_name: row.display_name,
          lat: row.lat.toFixed(7),
          lon: row.lon.toFixed(7),
          boundingbox: [
            row.bbox_ymin.toFixed(7),
            row.bbox_ymax.toFixed(7),
            row.bbox_xmin.toFixed(7),
            row.bbox_xmax.toFixed(7),
          ],
          // Boosted score is negative, lower is better
          importance: Math.min(1, Math.max(0, 1 + row.boosted_score / 20)),
          type: row.type,
        };

        if (addressdetails && row.type === "address") {
          // Parse display_name to extract address components
          // Format: "123 Main St, Boston, MA 02101"
          const parts = row.display_name.split(", ");
          geocoderResult.address = {
            road: parts[0]?.replace(/^\d+\s+/, "") || undefined,
            house_number: parts[0]?.match(/^(\d+)/)?.[1] || undefined,
            city: row.city || parts[1] || undefined,
            state: row.state || undefined,
            postcode: row.postcode || undefined,
            country: "United States",
            country_code: "us",
          };
        }

        results.push(geocoderResult);
      }
    }
  }

  // Results are already sorted by boosted_score (ascending = best first)
  // Just slice to limit
  return results.slice(0, limit);
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
    Math.max(1, parseInt(url.searchParams.get("limit") || "10")),
    40
  );
  const addressdetails = url.searchParams.get("addressdetails") === "1";
  // const countrycodes = url.searchParams.get("countrycodes");
  // const viewbox = url.searchParams.get("viewbox");
  // const bounded = url.searchParams.get("bounded") === "1";

  if (!q.trim()) {
    return jsonResponse([]);
  }

  const dbs = getDatabases(env, q);
  if (dbs.length === 0) {
    return jsonResponse(
      { error: "No database available" },
      400
    );
  }

  const results = await searchFeatures(dbs, q, limit, addressdetails);

  // Handle different output formats
  if (format === "geojson") {
    return jsonResponse({
      type: "FeatureCollection",
      features: results.map((r) => ({
        type: "Feature",
        id: r.gers_id,
        properties: {
          gers_id: r.gers_id,
          display_name: r.display_name,
          importance: r.importance,
          ...r.address,
        },
        bbox: r.boundingbox.map(parseFloat),
        geometry: {
          type: "Point",
          coordinates: [parseFloat(r.lon), parseFloat(r.lat)],
        },
      })),
    });
  }

  return jsonResponse(results);
}

/**
 * Handle /lookup endpoint for GERS ID lookups.
 */
async function handleLookup(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const idsParam = url.searchParams.get("gers_ids") || url.searchParams.get("ids") || "";
  const format = url.searchParams.get("format") || "jsonv2";

  // Parse GERS IDs (comma-separated UUIDs)
  const gersIds = idsParam
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  if (gersIds.length === 0) {
    return jsonResponse([]);
  }

  // For now, just search in MA database
  const db = env.DB_MA;
  if (!db) {
    return jsonResponse({ error: "No database available" }, 400);
  }

  const placeholders = gersIds.map(() => "?").join(",");
  const result = await db
    .prepare(
      `
      SELECT
        rowid,
        gers_id,
        type,
        display_name,
        lat,
        lon,
        bbox_xmin,
        bbox_ymin,
        bbox_xmax,
        bbox_ymax,
        population,
        city,
        state,
        postcode
      FROM features
      WHERE gers_id IN (${placeholders})
    `
    )
    .bind(...gersIds)
    .all<FeatureRow>();

  const results: GeocoderResult[] = (result.results || []).map((row) => ({
    gers_id: row.gers_id,
    display_name: row.display_name,
    lat: row.lat.toFixed(7),
    lon: row.lon.toFixed(7),
    boundingbox: [
      row.bbox_ymin.toFixed(7),
      row.bbox_ymax.toFixed(7),
      row.bbox_xmin.toFixed(7),
      row.bbox_xmax.toFixed(7),
    ],
    importance: 1,
    type: row.type,
    address: row.type === "address" ? {
      city: row.city || undefined,
      state: row.state || undefined,
      postcode: row.postcode || undefined,
      country: "United States",
      country_code: "us",
    } : undefined,
  }));

  if (format === "geojson") {
    return jsonResponse({
      type: "FeatureCollection",
      features: results.map((r) => ({
        type: "Feature",
        id: r.gers_id,
        properties: {
          gers_id: r.gers_id,
          display_name: r.display_name,
          ...r.address,
        },
        geometry: {
          type: "Point",
          coordinates: [parseFloat(r.lon), parseFloat(r.lat)],
        },
      })),
    });
  }

  return jsonResponse(results);
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

    const url = new URL(request.url);

    switch (url.pathname) {
      case "/search":
        return handleSearch(request, env);

      case "/lookup":
        return handleLookup(request, env);

      case "/":
        return jsonResponse({
          name: "Overture Geocoder",
          version: "0.1.0",
          endpoints: {
            search: "/search?q={query}",
            lookup: "/lookup?gers_ids={gers_id},{gers_id}",
          },
          documentation: "https://github.com/bradrichardson/overture-geocode",
        });

      default:
        return jsonResponse({ error: "Not found" }, 404);
    }
  },
};
