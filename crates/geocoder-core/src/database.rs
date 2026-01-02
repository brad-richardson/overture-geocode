//! Native SQLite database wrapper.
//!
//! Provides a high-level interface for querying SQLite geocoding shards.

use std::path::Path;

use rusqlite::{Connection, OpenFlags};

use crate::error::Result;
use crate::query::{calculate_boosted_score, prepare_fts_query, SEARCH_DIVISIONS_SQL};
use crate::types::{DivisionRow, GeocoderQuery, GeocoderResult};

/// A SQLite database connection for geocoding queries.
pub struct Database {
    conn: Connection,
}

impl Database {
    /// Open a database from a file path.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;

        // Configure for read-only performance
        conn.execute_batch(
            "PRAGMA cache_size = -64000; -- 64MB
             PRAGMA mmap_size = 268435456; -- 256MB
             PRAGMA temp_store = MEMORY;",
        )?;

        Ok(Self { conn })
    }

    /// Open a database from bytes (for WASM compatibility testing).
    ///
    /// Note: In actual WASM, we use sqlite3_deserialize instead.
    /// This method creates a temp file for native testing.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        let conn = Connection::open_in_memory()?;

        // Use SQLite's deserialize to load the database
        // This requires the database to be in SQLite format
        conn.execute_batch("PRAGMA page_size = 4096;")?;

        // For testing, we write to a temp file
        let temp_path = std::env::temp_dir().join(format!("geocoder-{}.db", uuid_v4()));
        std::fs::write(&temp_path, bytes)?;

        Self::open(&temp_path)
    }

    /// Search for divisions matching the query.
    pub fn search(&self, query: &GeocoderQuery) -> Result<Vec<GeocoderResult>> {
        let fts_query = prepare_fts_query(&query.text, query.autocomplete);

        if fts_query.is_empty() {
            return Ok(vec![]);
        }

        let mut stmt = self.conn.prepare_cached(SEARCH_DIVISIONS_SQL)?;

        // Fetch more results than requested, then re-rank by population boost.
        // This ensures high-population places with lower BM25 scores still appear.
        let fetch_limit = (query.limit * 10).max(100);

        let rows = stmt.query_map([&fts_query, &fetch_limit.to_string()], |row| {
            let population: Option<i64> = row.get(10)?;
            let bm25_score: f64 = row.get(13)?;
            let boosted_score = calculate_boosted_score(bm25_score, population);

            Ok(DivisionRow {
                rowid: row.get(0)?,
                gers_id: row.get(1)?,
                division_type: row.get(2)?,
                primary_name: row.get(3)?,
                lat: row.get(4)?,
                lon: row.get(5)?,
                bbox_xmin: row.get(6)?,
                bbox_ymin: row.get(7)?,
                bbox_xmax: row.get(8)?,
                bbox_ymax: row.get(9)?,
                population,
                country: row.get(11)?,
                region: row.get(12)?,
                boosted_score,
            })
        })?;

        // Collect and re-sort by boosted score (population boost affects ordering)
        let mut results: Vec<GeocoderResult> = rows
            .filter_map(|r| r.ok())
            .map(|row| row.into_result())
            .collect();

        // Sort by importance (descending) since population boost changes ranking
        results.sort_by(|a, b| {
            b.importance
                .partial_cmp(&a.importance)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        // Truncate to requested limit
        results.truncate(query.limit);

        Ok(results)
    }

    /// Get the number of records in the divisions table.
    pub fn count(&self) -> Result<u64> {
        let count: u64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM divisions", [], |row| row.get(0))?;
        Ok(count)
    }

    /// Get metadata value by key.
    pub fn get_metadata(&self, key: &str) -> Result<Option<String>> {
        let result: std::result::Result<String, _> = self.conn.query_row(
            "SELECT value FROM metadata WHERE key = ?1",
            [key],
            |row| row.get(0),
        );

        match result {
            Ok(value) => Ok(Some(value)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }
}

/// Generate a simple UUID v4 for temp file names.
fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();

    format!("{:032x}", timestamp)
}

// Integration tests for Database are in crates/geocoder-core/tests/
// They require built shards: python scripts/build_shards.py --countries US
