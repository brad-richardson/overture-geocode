//! STAC catalog loading and shard management with edge caching.

use geocoder_core::{query::apply_location_bias, Database, GeocoderQuery, GeocoderResult, LocationBias, ReverseResult};
use serde::Deserialize;
use worker::*;

// Cache TTLs for different resource types
const CATALOG_CACHE_TTL: u64 = 300;    // 5 minutes - need fresh version pointers
const COLLECTION_CACHE_TTL: u64 = 300; // 5 minutes - contains shard list
const SHARD_CACHE_TTL: u64 = 3600;     // 1 hour - versioned paths = natural invalidation

// Cache key prefix (uses custom domain for Cache API to work)
const CACHE_PREFIX: &str = "https://geocoder.bradr.dev/__cache/";

/// Loads and caches shards from R2 with edge caching via Cache API.
pub struct ShardLoader<'a> {
    env: &'a Env,
    bucket: Bucket,
    cache: Cache,
}

#[derive(Debug, Deserialize)]
struct StacCatalog {
    links: Vec<StacLink>,
}

#[derive(Debug, Deserialize)]
struct StacLink {
    rel: String,
    href: String,
    #[serde(default)]
    latest: bool,
}

/// Embedded item metadata in collection.json
#[derive(Debug, Deserialize)]
struct EmbeddedItem {
    record_count: u64,
    #[allow(dead_code)]
    size_bytes: u64,
    #[allow(dead_code)]
    sha256: String,
    href: String,
}

#[derive(Debug, Deserialize)]
struct StacCollection {
    #[allow(dead_code)]
    id: String,
    /// Embedded items (new format) - keyed by shard ID (e.g., "US", "HEAD")
    #[serde(default)]
    items: std::collections::HashMap<String, EmbeddedItem>,
    /// Legacy links to individual item files
    links: Vec<StacLink>,
}

/// Legacy STAC item format (for backward compatibility with old catalogs)
#[derive(Debug, Deserialize)]
struct StacItem {
    #[allow(dead_code)]
    id: String,
    properties: StacItemProperties,
    assets: StacAssets,
}

#[derive(Debug, Deserialize)]
struct StacItemProperties {
    record_count: u64,
    #[allow(dead_code)]
    size_bytes: u64,
    #[allow(dead_code)]
    sha256: String,
}

#[derive(Debug, Deserialize)]
struct StacAssets {
    data: StacAsset,
}

#[derive(Debug, Deserialize)]
struct StacAsset {
    href: String,
}

impl<'a> ShardLoader<'a> {
    pub fn new(env: &'a Env) -> Result<Self> {
        let bucket = env.bucket("SHARDS_BUCKET")?;
        let cache = Cache::default();
        Ok(Self { env, bucket, cache })
    }

    /// Fetch from R2 with edge caching via Cache API.
    async fn cached_get(&self, key: &str, ttl: u64) -> Result<Option<Vec<u8>>> {
        let cache_key = format!("{}{}", CACHE_PREFIX, key);

        // Try cache first
        let request = Request::new(&cache_key, Method::Get)?;
        if let Some(mut response) = self.cache.get(&request, false).await? {
            console_log!("Cache HIT: {}", key);
            let bytes = response.bytes().await?;
            return Ok(Some(bytes));
        }

        console_log!("Cache MISS: {}", key);

        // Fetch from R2
        let obj = self.bucket.get(key).execute().await?;
        if let Some(obj) = obj {
            let body = obj.body().ok_or_else(|| Error::RustError("Empty object".into()))?;
            let bytes = body.bytes().await?;

            // Store in cache with TTL (non-blocking via waitUntil would be ideal, but for now inline)
            let headers = Headers::new();
            headers.set("Cache-Control", &format!("s-maxage={}", ttl))?;
            headers.set("Content-Type", "application/octet-stream")?;

            let cache_response = Response::from_bytes(bytes.clone())?.with_headers(headers);
            let cache_request = Request::new(&cache_key, Method::Get)?;

            // Put in cache (best effort, don't fail the request if caching fails)
            if let Err(e) = self.cache.put(&cache_request, cache_response).await {
                console_log!("Cache PUT failed for {}: {:?}", key, e);
            }

            return Ok(Some(bytes));
        }

        Ok(None)
    }

    /// Fetch text from R2 with caching.
    async fn cached_get_text(&self, key: &str, ttl: u64) -> Result<Option<String>> {
        match self.cached_get(key, ttl).await? {
            Some(bytes) => {
                let text = String::from_utf8(bytes)
                    .map_err(|e| Error::RustError(format!("Invalid UTF-8: {}", e)))?;
                Ok(Some(text))
            }
            None => Ok(None),
        }
    }

    /// Search across HEAD and country shards.
    pub async fn search(
        &self,
        query: &GeocoderQuery,
        cf_country: Option<&str>,
    ) -> Result<Vec<GeocoderResult>> {
        // Load STAC catalog to find shards
        let catalog = self.load_catalog().await?;
        let (version, collection) = self.load_latest_collection(&catalog).await?;

        // Query HEAD shard (required - fail if unavailable)
        let head_results = self.query_shard(&version, "HEAD", &collection, query).await?;
        let mut all_results = head_results;

        // Query country shard if available (optional - log errors but continue)
        if let Some(country) = cf_country {
            if self.collection_has_shard(&collection, country) {
                match self.query_shard(&version, country, &collection, query).await {
                    Ok(results) => all_results.extend(results),
                    Err(e) => {
                        console_log!("Warning: country shard {} unavailable: {:?}", country, e);
                    }
                }
            }
        }

        // Sort by importance before deduplication
        all_results.sort_by(|a, b| {
            b.importance
                .partial_cmp(&a.importance)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        // Deduplicate by gers_id (keep highest importance)
        let mut seen = std::collections::HashSet::new();
        all_results.retain(|r| seen.insert(r.gers_id.clone()));

        // Apply location bias (can elevate results from country shard)
        if !matches!(query.bias, LocationBias::None) {
            apply_location_bias(&mut all_results, &query.bias);
        }

        // Truncate to requested limit after bias is applied
        all_results.truncate(query.limit);

        Ok(all_results)
    }

    /// Reverse geocode a lat/lon coordinate.
    pub async fn reverse_geocode(
        &self,
        lat: f64,
        lon: f64,
        cf_country: Option<&str>,
    ) -> Result<Option<ReverseResult>> {
        // Load STAC catalog to find reverse shards
        let catalog = self.load_catalog().await?;
        let (version, _collection) = self.load_latest_collection(&catalog).await?;

        // Try country shard first if available (more specific data)
        if let Some(country) = cf_country {
            match self.query_reverse_shard(&version, country, lat, lon).await {
                Ok(Some(result)) => return Ok(Some(result)),
                Ok(None) => {
                    console_log!("No result in country {} reverse shard", country);
                }
                Err(e) => {
                    console_log!("Warning: country reverse shard {} unavailable: {:?}", country, e);
                }
            }
        }

        // Fall back to HEAD shard
        self.query_reverse_shard(&version, "HEAD", lat, lon).await
    }

    async fn query_reverse_shard(
        &self,
        version: &str,
        shard_id: &str,
        lat: f64,
        lon: f64,
    ) -> Result<Option<ReverseResult>> {
        // Load the reverse shard item metadata (cached)
        let item_key = format!("{}/reverse-items/{}.json", version, shard_id);
        let item_text = self
            .cached_get_text(&item_key, SHARD_CACHE_TTL)
            .await?
            .ok_or_else(|| Error::RustError(format!("Reverse item {} not found", item_key)))?;

        let item: StacItem = serde_json::from_str(&item_text)
            .map_err(|e| Error::RustError(format!("Failed to parse item: {}", e)))?;

        // Load the actual reverse shard database (cached)
        let shard_href = &item.assets.data.href;
        let shard_key = format!("{}/{}", version, shard_href.trim_start_matches("./"));

        let shard_bytes = self
            .cached_get(&shard_key, SHARD_CACHE_TTL)
            .await?
            .ok_or_else(|| Error::RustError(format!("Reverse shard {} not found", shard_key)))?;

        console_log!(
            "Loading reverse shard {} ({} bytes, {} records)",
            shard_id,
            shard_bytes.len(),
            item.properties.record_count
        );

        // Open the SQLite database from bytes and query it
        let db = Database::from_bytes(&shard_bytes)
            .map_err(|e| Error::RustError(format!("Failed to open reverse shard database: {}", e)))?;

        let result = db
            .reverse_geocode(lat, lon)
            .map_err(|e| Error::RustError(format!("Reverse geocode failed: {}", e)))?;

        Ok(result)
    }

    async fn load_catalog(&self) -> Result<StacCatalog> {
        let text = self
            .cached_get_text("catalog.json", CATALOG_CACHE_TTL)
            .await?
            .ok_or_else(|| Error::RustError("catalog.json not found".into()))?;

        serde_json::from_str(&text)
            .map_err(|e| Error::RustError(format!("Failed to parse catalog: {}", e)))
    }

    /// Load the latest collection and return it along with its version string.
    async fn load_latest_collection(&self, catalog: &StacCatalog) -> Result<(String, StacCollection)> {
        // Find the link marked as latest
        let latest_link = catalog
            .links
            .iter()
            .find(|l| l.rel == "child" && l.latest)
            .ok_or_else(|| Error::RustError("No latest collection found".into()))?;

        // Extract version from href (e.g., "./2026-01-02.0/collection.json")
        let version = latest_link
            .href
            .trim_start_matches("./")
            .split('/')
            .next()
            .ok_or_else(|| Error::RustError("Invalid collection href".into()))?
            .to_string();

        let key = format!("{}/collection.json", version);
        let text = self
            .cached_get_text(&key, COLLECTION_CACHE_TTL)
            .await?
            .ok_or_else(|| Error::RustError(format!("{} not found", key)))?;

        let collection: StacCollection = serde_json::from_str(&text)
            .map_err(|e| Error::RustError(format!("Failed to parse collection: {}", e)))?;

        Ok((version, collection))
    }

    fn collection_has_shard(&self, collection: &StacCollection, shard_id: &str) -> bool {
        // Check embedded items first (new format)
        if collection.items.contains_key(shard_id) {
            return true;
        }
        // Fall back to legacy links check
        collection
            .links
            .iter()
            .any(|l| l.rel == "item" && l.href.contains(&format!("/{}.json", shard_id)))
    }

    /// Get embedded item metadata from collection, or return None if not found.
    fn get_embedded_item<'b>(&self, collection: &'b StacCollection, shard_id: &str) -> Option<&'b EmbeddedItem> {
        collection.items.get(shard_id)
    }

    async fn query_shard(
        &self,
        version: &str,
        shard_id: &str,
        collection: &StacCollection,
        query: &GeocoderQuery,
    ) -> Result<Vec<GeocoderResult>> {
        // Get item metadata from embedded items (new format) or fall back to separate file
        let (shard_href, record_count) = if let Some(item) = self.get_embedded_item(collection, shard_id) {
            (item.href.clone(), item.record_count)
        } else {
            // Legacy: load from separate item file
            let item_key = format!("{}/items/{}.json", version, shard_id);
            let item_text = self
                .cached_get_text(&item_key, SHARD_CACHE_TTL)
                .await?
                .ok_or_else(|| Error::RustError(format!("Item {} not found", item_key)))?;

            let item: StacItem = serde_json::from_str(&item_text)
                .map_err(|e| Error::RustError(format!("Failed to parse item: {}", e)))?;

            (item.assets.data.href.clone(), item.properties.record_count)
        };

        // Load the actual shard database (cached)
        let shard_key = format!("{}/{}", version, shard_href.trim_start_matches("./"));

        let shard_bytes = self
            .cached_get(&shard_key, SHARD_CACHE_TTL)
            .await?
            .ok_or_else(|| Error::RustError(format!("Shard {} not found", shard_key)))?;

        console_log!(
            "Loading shard {} ({} bytes, {} records)",
            shard_id,
            shard_bytes.len(),
            record_count
        );

        // Open the SQLite database from bytes and query it
        let db = Database::from_bytes(&shard_bytes)
            .map_err(|e| Error::RustError(format!("Failed to open shard database: {}", e)))?;

        let results = db
            .search(query)
            .map_err(|e| Error::RustError(format!("Search failed: {}", e)))?;

        Ok(results)
    }
}
