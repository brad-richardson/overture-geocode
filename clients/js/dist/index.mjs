import "./chunk-OOIUSZB4.mjs";

// src/stac.ts
var STAC_CATALOG_URL = "https://stac.overturemaps.org/catalog.json";
var S3_BASE_URL = "s3://overturemaps-us-west-2";
var catalogCache = null;
async function getStacCatalog(fetchFn = fetch) {
  if (catalogCache) return catalogCache;
  const response = await fetchFn(STAC_CATALOG_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch STAC catalog: ${response.status}`);
  }
  catalogCache = await response.json();
  return catalogCache;
}
function clearCatalogCache() {
  catalogCache = null;
}
async function getLatestRelease(fetchFn = fetch) {
  const catalog = await getStacCatalog(fetchFn);
  for (const link of catalog.links) {
    if (link.latest === true) {
      const match = link.href.match(/\.\/([0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+)\//);
      if (match) {
        return match[1];
      }
    }
  }
  throw new Error("Could not find latest release in STAC catalog");
}
function findRegistryFile(manifest, gersId) {
  if (manifest.length === 0) return null;
  const id = gersId.toLowerCase();
  let left = 0;
  let right = manifest.length - 1;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (manifest[mid][1] < id) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }
  return manifest[left]?.[1] >= id ? manifest[left][0] : null;
}
function getRegistryS3Path(registry, filename) {
  return `${S3_BASE_URL}/${registry.path}/${filename}`;
}
function getDataS3Path(filepath) {
  return `${S3_BASE_URL}/${filepath}`;
}

// src/index.ts
var GeocoderError = class extends Error {
  constructor(message, status, response) {
    super(message);
    this.status = status;
    this.response = response;
    this.name = "GeocoderError";
  }
};
var GeocoderTimeoutError = class extends GeocoderError {
  constructor(message = "Request timed out") {
    super(message);
    this.name = "GeocoderTimeoutError";
  }
};
var GeocoderNetworkError = class extends GeocoderError {
  constructor(message, cause) {
    super(message);
    this.cause = cause;
    this.name = "GeocoderNetworkError";
  }
};
var DEFAULT_BASE_URL = "https://overture-geocoder.bradr.workers.dev";
var DEFAULT_TIMEOUT = 3e4;
var DEFAULT_RETRIES = 0;
var DEFAULT_RETRY_DELAY = 1e3;
var OvertureGeocoder = class {
  baseUrl;
  timeout;
  retries;
  retryDelay;
  headers;
  fetchFn;
  onRequest;
  onResponse;
  // DuckDB-WASM for geometry fetching (lazy loaded)
  duckdb = null;
  duckdbConn = null;
  duckdbInitPromise = null;
  constructor(config = {}) {
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.retries = config.retries ?? DEFAULT_RETRIES;
    this.retryDelay = config.retryDelay ?? DEFAULT_RETRY_DELAY;
    this.headers = config.headers ?? {};
    this.fetchFn = config.fetch ?? globalThis.fetch;
    this.onRequest = config.onRequest;
    this.onResponse = config.onResponse;
  }
  /**
   * Search for addresses matching the query.
   */
  async search(query, options = {}) {
    const params = new URLSearchParams({
      q: query,
      format: options.format || "jsonv2",
      limit: String(Math.min(Math.max(1, options.limit || 10), 40))
    });
    if (options.countrycodes) params.set("countrycodes", options.countrycodes);
    if (options.viewbox) params.set("viewbox", options.viewbox.join(","));
    if (options.bounded) params.set("bounded", "1");
    if (options.addressdetails) params.set("addressdetails", "1");
    const url = `${this.baseUrl}/search?${params}`;
    const response = await this.fetchWithRetry(url);
    const data = await response.json();
    if (options.format === "geojson") {
      return data;
    }
    return this.parseResults(data);
  }
  /**
   * Search and return results as GeoJSON FeatureCollection.
   */
  async searchGeoJSON(query, options = {}) {
    const params = new URLSearchParams({
      q: query,
      format: "geojson",
      limit: String(Math.min(Math.max(1, options.limit || 10), 40))
    });
    if (options.countrycodes) params.set("countrycodes", options.countrycodes);
    if (options.viewbox) params.set("viewbox", options.viewbox.join(","));
    if (options.bounded) params.set("bounded", "1");
    if (options.addressdetails) params.set("addressdetails", "1");
    const url = `${this.baseUrl}/search?${params}`;
    const response = await this.fetchWithRetry(url);
    return response.json();
  }
  /**
   * Get the base URL configured for this client.
   */
  getBaseUrl() {
    return this.baseUrl;
  }
  /**
   * Fetch full geometry for a GERS ID directly from Overture S3 via DuckDB-WASM.
   *
   * Uses the STAC catalog's GERS registry for efficient lookup:
   * 1. Binary search manifest to find registry file
   * 2. Query registry for filepath + bbox (predicate pushdown)
   * 3. Query actual geometry from the specific parquet file
   *
   * Note: Requires @duckdb/duckdb-wasm package (~15MB, lazy loaded on first call):
   *   npm install @duckdb/duckdb-wasm
   *
   * @param gersId The GERS ID to look up
   * @returns GeoJSON Feature with full geometry, or null if not found
   */
  async getFullGeometry(gersId) {
    const catalog = await getStacCatalog(this.fetchFn);
    if (!catalog.registry) {
      throw new GeocoderError("GERS registry not found in STAC catalog");
    }
    const registryFile = findRegistryFile(catalog.registry.manifest, gersId);
    if (!registryFile) {
      return null;
    }
    const conn = await this.initDuckDB();
    const registryPath = getRegistryS3Path(catalog.registry, registryFile);
    const registryResult = await this.queryDuckDB(conn, `
      SELECT filepath, bbox
      FROM read_parquet('${registryPath}')
      WHERE id = '${gersId}'
      LIMIT 1
    `);
    if (registryResult.length === 0) {
      return null;
    }
    const registryRow = registryResult[0];
    const filepath = registryRow.filepath;
    const bbox = registryRow.bbox;
    if (!filepath) {
      return null;
    }
    const dataPath = getDataS3Path(filepath);
    const geometryResult = await this.queryDuckDB(conn, `
      SELECT id, ST_AsGeoJSON(geometry) as geojson, names
      FROM read_parquet('${dataPath}')
      WHERE id = '${gersId}'
      LIMIT 1
    `);
    if (geometryResult.length === 0) {
      return null;
    }
    const row = geometryResult[0];
    const geometry = JSON.parse(row.geojson);
    return {
      type: "Feature",
      id: gersId,
      properties: {
        names: row.names
      },
      bbox: bbox ? [bbox.xmin, bbox.ymin, bbox.xmax, bbox.ymax] : void 0,
      geometry
    };
  }
  /**
   * Close DuckDB connection and release resources.
   * Call this when done with geometry fetching to free memory.
   */
  async close() {
    if (this.duckdbConn) {
      const conn = this.duckdbConn;
      await conn.close();
      this.duckdbConn = null;
    }
    if (this.duckdb) {
      const db = this.duckdb;
      await db.terminate();
      this.duckdb = null;
    }
    this.duckdbInitPromise = null;
  }
  // ==========================================================================
  // Private methods
  // ==========================================================================
  /**
   * Initialize DuckDB-WASM with httpfs extension.
   * Lazy loaded on first geometry fetch call.
   */
  async initDuckDB() {
    if (this.duckdbConn) {
      return this.duckdbConn;
    }
    if (this.duckdbInitPromise) {
      return this.duckdbInitPromise;
    }
    this.duckdbInitPromise = this.doInitDuckDB();
    return this.duckdbInitPromise;
  }
  async doInitDuckDB() {
    try {
      const duckdb = await import("./duckdb-node-KLXLGZSD.mjs");
      const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
      const worker = new Worker(bundle.mainWorker);
      const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
      const db = new duckdb.AsyncDuckDB(logger, worker);
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      this.duckdb = db;
      const conn = await db.connect();
      this.duckdbConn = conn;
      await conn.query("INSTALL httpfs;");
      await conn.query("LOAD httpfs;");
      await conn.query("SET s3_region = 'us-west-2';");
      await conn.query("INSTALL spatial;");
      await conn.query("LOAD spatial;");
      return conn;
    } catch (error) {
      this.duckdbInitPromise = null;
      if (error instanceof Error && error.message.includes("Cannot find module")) {
        throw new GeocoderError(
          "@duckdb/duckdb-wasm required for geometry fetching. Install with: npm install @duckdb/duckdb-wasm"
        );
      }
      throw error;
    }
  }
  async queryDuckDB(conn, sql) {
    const connection = conn;
    const result = await connection.query(sql);
    const table = result;
    return table.toArray();
  }
  async fetchWithRetry(url, attempt = 0) {
    try {
      const response = await this.doFetch(url);
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
          throw new GeocoderError(
            `Request failed: ${response.status} ${response.statusText}`,
            response.status,
            response
          );
        }
        if (attempt < this.retries) {
          await this.delay(this.retryDelay);
          return this.fetchWithRetry(url, attempt + 1);
        }
        throw new GeocoderError(
          `Request failed after ${attempt + 1} attempts: ${response.status} ${response.statusText}`,
          response.status,
          response
        );
      }
      return response;
    } catch (error) {
      if (error instanceof GeocoderError) throw error;
      if (error instanceof Error) {
        if (error.name === "AbortError") {
          if (attempt < this.retries) {
            await this.delay(this.retryDelay);
            return this.fetchWithRetry(url, attempt + 1);
          }
          throw new GeocoderTimeoutError(
            `Request timed out after ${this.timeout}ms (${attempt + 1} attempts)`
          );
        }
        if (attempt < this.retries) {
          await this.delay(this.retryDelay);
          return this.fetchWithRetry(url, attempt + 1);
        }
        throw new GeocoderNetworkError(
          `Network error after ${attempt + 1} attempts: ${error.message}`,
          error
        );
      }
      throw error;
    }
  }
  async doFetch(url) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    try {
      let init = {
        method: "GET",
        headers: {
          Accept: "application/json",
          ...this.headers
        },
        signal: controller.signal
      };
      if (this.onRequest) {
        init = await this.onRequest(url, init);
      }
      let response = await this.fetchFn(url, init);
      if (this.onResponse) {
        response = await this.onResponse(response);
      }
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }
  parseResults(data) {
    if (!Array.isArray(data)) return [];
    return data.map((r) => {
      const record = r;
      return {
        gers_id: record.gers_id,
        primary_name: record.primary_name,
        lat: parseFloat(record.lat),
        lon: parseFloat(record.lon),
        boundingbox: record.boundingbox.map(parseFloat),
        importance: record.importance || 0,
        type: record.type,
        address: record.address
      };
    });
  }
  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
};
async function geocode(query, options) {
  const client = new OvertureGeocoder();
  return client.search(query, options);
}
var index_default = OvertureGeocoder;
export {
  GeocoderError,
  GeocoderNetworkError,
  GeocoderTimeoutError,
  OvertureGeocoder,
  clearCatalogCache,
  index_default as default,
  findRegistryFile,
  geocode,
  getLatestRelease,
  getStacCatalog
};
