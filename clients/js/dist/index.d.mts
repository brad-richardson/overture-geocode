export { StacCatalog, StacLink, clearCache as clearCatalogCache, getLatestRelease, getStacCatalog } from '@bradrichardson/overturemaps';

/**
 * Overture Geocoder JavaScript/TypeScript Client
 *
 * Forward geocoder using Overture Maps data with Nominatim-compatible API.
 */

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
interface AddressDetails {
    house_number?: string;
    road?: string;
    city?: string;
    state?: string;
    postcode?: string;
    country?: string;
    country_code?: string;
}
interface SearchOptions {
    /** Maximum number of results (1-40, default: 10) */
    limit?: number;
    /** Comma-separated ISO 3166-1 alpha-2 country codes */
    countrycodes?: string;
    /** Bounding box [lon1, lat1, lon2, lat2] */
    viewbox?: [number, number, number, number];
    /** Restrict results to viewbox */
    bounded?: boolean;
    /** Include address breakdown in results */
    addressdetails?: boolean;
    /** Response format */
    format?: "json" | "jsonv2" | "geojson";
}
interface ReverseOptions {
    /** Response format */
    format?: "jsonv2" | "geojson";
}
interface HierarchyEntry {
    gers_id: string;
    subtype: string;
    name: string;
}
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
interface OvertureGeocoderConfig {
    /** API base URL (default: 'https://overture-geocoder.bradr.workers.dev') */
    baseUrl?: string;
    /** Request timeout in milliseconds (default: 30000) */
    timeout?: number;
    /** Number of retry attempts for failed requests (default: 0) */
    retries?: number;
    /** Delay between retries in milliseconds (default: 1000) */
    retryDelay?: number;
    /** Custom headers to include in all requests */
    headers?: Record<string, string>;
    /** Custom fetch implementation (useful for testing or custom transports) */
    fetch?: typeof globalThis.fetch;
    /** Request interceptor - modify request before sending */
    onRequest?: (url: string, init: RequestInit) => RequestInit | Promise<RequestInit>;
    /** Response interceptor - process response before returning */
    onResponse?: (response: Response) => Response | Promise<Response>;
}
interface GeoJSONFeature {
    type: "Feature";
    id: string;
    properties: Record<string, unknown>;
    bbox?: [number, number, number, number];
    geometry: GeoJSONGeometry;
}
type GeoJSONGeometry = {
    type: "Point";
    coordinates: [number, number];
} | {
    type: "LineString";
    coordinates: [number, number][];
} | {
    type: "Polygon";
    coordinates: [number, number][][];
} | {
    type: "MultiPoint";
    coordinates: [number, number][];
} | {
    type: "MultiLineString";
    coordinates: [number, number][][];
} | {
    type: "MultiPolygon";
    coordinates: [number, number][][][];
};
interface GeoJSONFeatureCollection {
    type: "FeatureCollection";
    features: GeoJSONFeature[];
}
declare class GeocoderError extends Error {
    readonly status?: number | undefined;
    readonly response?: Response | undefined;
    constructor(message: string, status?: number | undefined, response?: Response | undefined);
}
declare class GeocoderTimeoutError extends GeocoderError {
    constructor(message?: string);
}
declare class GeocoderNetworkError extends GeocoderError {
    readonly cause?: Error | undefined;
    constructor(message: string, cause?: Error | undefined);
}
declare class OvertureGeocoder {
    private readonly baseUrl;
    private readonly timeout;
    private readonly retries;
    private readonly retryDelay;
    private readonly headers;
    private readonly fetchFn;
    private readonly onRequest?;
    private readonly onResponse?;
    constructor(config?: OvertureGeocoderConfig);
    /**
     * Search for addresses matching the query.
     */
    search(query: string, options?: SearchOptions): Promise<GeocoderResult[]>;
    /**
     * Search and return results as GeoJSON FeatureCollection.
     */
    searchGeoJSON(query: string, options?: Omit<SearchOptions, "format">): Promise<GeoJSONFeatureCollection>;
    /**
     * Reverse geocode coordinates to divisions.
     *
     * Returns divisions (localities, neighborhoods, counties, etc.) that
     * contain the given coordinate. Results are sorted by specificity
     * (smallest/most specific first).
     */
    reverse(lat: number, lon: number, options?: ReverseOptions): Promise<ReverseGeocoderResult[]>;
    /**
     * Reverse geocode and return results as GeoJSON FeatureCollection.
     */
    reverseGeoJSON(lat: number, lon: number): Promise<GeoJSONFeatureCollection>;
    /**
     * Verify if a point is inside a division's polygon.
     *
     * Fetches the full geometry from Overture S3 and performs
     * a point-in-polygon check using ray casting algorithm.
     */
    verifyContainsPoint(gersId: string, lat: number, lon: number): Promise<boolean>;
    /**
     * Get the base URL configured for this client.
     */
    getBaseUrl(): string;
    /**
     * Fetch full geometry for a GERS ID directly from Overture S3.
     *
     * Uses the @bradrichardson/overturemaps package for efficient lookup.
     *
     * @param gersId The GERS ID to look up
     * @returns GeoJSON Feature with full geometry, or null if not found
     */
    getFullGeometry(gersId: string): Promise<GeoJSONFeature | null>;
    /**
     * Close DuckDB connection and release resources.
     * Call this when done with geometry fetching to free memory.
     */
    close(): Promise<void>;
    private fetchWithRetry;
    private doFetch;
    private parseResults;
    private parseReverseResults;
    private pointInPolygon;
    private delay;
}
/**
 * Quick geocode function using default settings.
 */
declare function geocode(query: string, options?: SearchOptions): Promise<GeocoderResult[]>;
/**
 * Quick reverse geocode function using default settings.
 */
declare function reverseGeocode(lat: number, lon: number, options?: ReverseOptions): Promise<ReverseGeocoderResult[]>;

export { type AddressDetails, type GeoJSONFeature, type GeoJSONFeatureCollection, type GeoJSONGeometry, GeocoderError, GeocoderNetworkError, type GeocoderResult, GeocoderTimeoutError, type HierarchyEntry, OvertureGeocoder, type OvertureGeocoderConfig, type ReverseGeocoderResult, type ReverseOptions, type SearchOptions, OvertureGeocoder as default, geocode, reverseGeocode };
