//! Query preparation and execution.

mod bias;
mod fts;
mod merge;

pub use bias::apply_location_bias;
pub use fts::prepare_fts_query;
pub use merge::merge_results;

/// SQL query for searching divisions.
/// Note: BM25 scoring and population boost are computed in Rust for portability.
pub const SEARCH_DIVISIONS_SQL: &str = r#"
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
        bm25(divisions_fts) as bm25_score
    FROM divisions_fts
    JOIN divisions d ON divisions_fts.rowid = d.rowid
    WHERE divisions_fts MATCH ?1
    ORDER BY bm25_score
    LIMIT ?2
"#;

/// Calculate boosted score from BM25 and population.
/// Lower score = better match.
pub fn calculate_boosted_score(bm25_score: f64, population: Option<i64>) -> f64 {
    match population {
        Some(pop) if pop > 0 => bm25_score - ((pop as f64 + 1.0).ln() * 2.0),
        _ => bm25_score - 2.0,
    }
}

/// SQL query for reverse geocoding (bbox containment).
pub const REVERSE_GEOCODE_SQL: &str = r#"
    SELECT
        gers_id,
        subtype,
        primary_name,
        lat,
        lon,
        bbox_xmin,
        bbox_ymin,
        bbox_xmax,
        bbox_ymax,
        area,
        population,
        country,
        region
    FROM divisions_reverse
    WHERE bbox_xmin <= ?1
      AND bbox_xmax >= ?1
      AND bbox_ymin <= ?2
      AND bbox_ymax >= ?2
    ORDER BY area ASC
    LIMIT 50
"#;
