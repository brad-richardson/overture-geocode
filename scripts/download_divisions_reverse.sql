-- Download Overture Maps divisions for reverse geocoding
-- Run with: ./scripts/download_divisions.sh (uses same shell wrapper)
--
-- Output: exports/divisions-reverse.parquet
-- Expected: ~4.3M records (same divisions, different schema)
--
-- Note: __OVERTURE_RELEASE__ is substituted at runtime with the latest release

-- Install and load required extensions
INSTALL httpfs;
LOAD httpfs;
INSTALL spatial;
LOAD spatial;

-- Configure S3 for anonymous access (Overture is public)
SET s3_region = 'us-west-2';
SET memory_limit = '8GB';

.timer on

-- Extract global divisions with hierarchy data for reverse geocoding
-- Key differences from forward geocoding index:
--   1. No FTS search_text (not needed for spatial queries)
--   2. Includes hierarchy_json for full hierarchy resolution
--   3. Includes area calculation for ranking (smaller = more specific)
COPY (
    SELECT
        id as gers_id,
        version,
        names.primary as name,
        subtype,
        country,
        region,
        population,
        parent_division_id,
        -- Centroid coordinates
        ST_X(ST_Centroid(geometry)) as lon,
        ST_Y(ST_Centroid(geometry)) as lat,
        -- Bounding box for spatial queries
        bbox.xmin as bbox_xmin,
        bbox.ymin as bbox_ymin,
        bbox.xmax as bbox_xmax,
        bbox.ymax as bbox_ymax,
        -- Area in square degrees (for ranking: smaller = more specific)
        (bbox.xmax - bbox.xmin) * (bbox.ymax - bbox.ymin) as area,
        -- Build primary name based on available data
        CASE
            -- US format: "Boston, MA"
            WHEN country = 'US' AND region IS NOT NULL THEN
                CONCAT(names.primary, ', ', REPLACE(region, 'US-', ''))
            -- Other countries with region: "London, GB-ENG"
            WHEN region IS NOT NULL THEN
                CONCAT(names.primary, ', ', region)
            -- Fallback: just the name and country
            ELSE
                CONCAT(names.primary, ', ', country)
        END as primary_name,
        -- Store first hierarchy as JSON for quick access
        -- hierarchies[1] is the default/primary hierarchy
        -- Each entry has: division_id, subtype, name
        TO_JSON(hierarchies[1]) as hierarchy_json
    FROM read_parquet(
        's3://overturemaps-us-west-2/release/__OVERTURE_RELEASE__/theme=divisions/type=division/*',
        hive_partitioning = true
    )
    WHERE subtype IN ('locality', 'localadmin', 'neighborhood', 'macrohood', 'county')
      AND names.primary IS NOT NULL
)
TO 'exports/divisions-reverse.parquet' (FORMAT PARQUET, COMPRESSION ZSTD);

-- Show count and breakdown
SELECT COUNT(*) as total_divisions FROM read_parquet('exports/divisions-reverse.parquet');

SELECT subtype, COUNT(*) as count
FROM read_parquet('exports/divisions-reverse.parquet')
GROUP BY subtype
ORDER BY count DESC;

-- Show sample hierarchy_json
SELECT primary_name, subtype, hierarchy_json
FROM read_parquet('exports/divisions-reverse.parquet')
WHERE hierarchy_json IS NOT NULL
LIMIT 3;
