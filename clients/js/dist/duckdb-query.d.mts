/**
 * DuckDB-WASM query utility for Overture S3 data
 *
 * Provides direct SQL queries against Overture Maps S3 data using DuckDB-WASM.
 * Used for nearby places/addresses lookups that aren't in the indexed D1 database.
 *
 * NOTE: Requires @duckdb/duckdb-wasm as an optional peer dependency.
 * If not installed, the S3 query features will throw an error.
 */
/**
 * Execute a query against Overture S3 data
 *
 * @param sql SQL query with __LATEST__ placeholder for release version
 * @returns Array of result rows
 */
declare function queryOverture(sql: string): Promise<Record<string, unknown>[]>;
/**
 * Close DuckDB connection and release resources
 */
declare function closeDuckDB(): Promise<void>;
/**
 * Check if DuckDB is available/initialized
 */
declare function isDuckDBAvailable(): boolean;

export { closeDuckDB, isDuckDBAvailable, queryOverture };
