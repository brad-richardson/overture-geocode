/**
 * Overture Geocoder JavaScript Client
 *
 * Forward geocoder using Overture Maps data.
 */

export interface GeocoderResult {
  gers_id: string;
  display_name: string;
  lat: number;
  lon: number;
  boundingbox: [number, number, number, number];
  importance: number;
  address?: Record<string, string>;
}

export interface SearchOptions {
  limit?: number;
  countrycodes?: string;
  viewbox?: [number, number, number, number];
  bounded?: boolean;
  addressdetails?: boolean;
}

const DEFAULT_API_URL = "http://localhost:8787";
const OVERTURE_RELEASE = "2025-12-17.0";

export class OvertureGeocoder {
  private apiUrl: string;
  private overtureRelease: string;

  constructor(options?: { apiUrl?: string; overtureRelease?: string }) {
    this.apiUrl = (options?.apiUrl || DEFAULT_API_URL).replace(/\/$/, "");
    this.overtureRelease = options?.overtureRelease || OVERTURE_RELEASE;
  }

  async search(
    query: string,
    options: SearchOptions = {}
  ): Promise<GeocoderResult[]> {
    const params = new URLSearchParams({
      q: query,
      format: "jsonv2",
      limit: String(Math.min(options.limit || 10, 40)),
    });

    if (options.countrycodes) params.set("countrycodes", options.countrycodes);
    if (options.viewbox) params.set("viewbox", options.viewbox.join(","));
    if (options.bounded) params.set("bounded", "1");
    if (options.addressdetails) params.set("addressdetails", "1");

    const response = await fetch(`${this.apiUrl}/search?${params}`);
    if (!response.ok) {
      throw new Error(`Search failed: ${response.status} ${response.statusText}`);
    }

    const results = await response.json();
    return results.map((r: Record<string, unknown>) => ({
      gers_id: r.gers_id as string,
      display_name: r.display_name as string,
      lat: parseFloat(r.lat as string),
      lon: parseFloat(r.lon as string),
      boundingbox: (r.boundingbox as string[]).map(parseFloat) as [
        number,
        number,
        number,
        number
      ],
      importance: (r.importance as number) || 0,
      address: r.address as Record<string, string> | undefined,
    }));
  }

  async getGeometry(gersId: string): Promise<GeoJSON.Feature | null> {
    // Try API lookup first
    const response = await fetch(
      `${this.apiUrl}/lookup?gers_ids=${gersId}&format=geojson`
    );

    if (response.ok) {
      return response.json();
    }

    // Fallback: client-side DuckDB (requires duckdb-wasm)
    console.warn(
      "API lookup failed, client-side DuckDB not yet implemented in browser"
    );
    return null;
  }
}

// Default instance for convenience
const defaultGeocoder = new OvertureGeocoder();

export async function geocode(
  query: string,
  options?: SearchOptions
): Promise<GeocoderResult[]> {
  return defaultGeocoder.search(query, options);
}

export default OvertureGeocoder;
