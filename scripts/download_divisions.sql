-- Download and filter Overture Maps divisions for Massachusetts
-- Run with: duckdb < scripts/download_divisions.sql
--
-- Output: exports/US-MA-divisions.parquet

-- Install and load required extensions
INSTALL httpfs;
LOAD httpfs;
INSTALL spatial;
LOAD spatial;

-- Configure S3 for anonymous access (Overture is public)
SET s3_region = 'us-west-2';
SET memory_limit = '4GB';

.timer on

-- Extract Massachusetts divisions (cities, towns, neighborhoods)
-- Subtypes: country, dependency, region, county, localadmin, locality,
--           macrohood, neighborhood, microhood
COPY (
    SELECT
        id as gers_id,
        names.primary as name,
        subtype,
        class,
        country,
        region,
        population,
        ST_X(geometry) as lon,
        ST_Y(geometry) as lat,
        bbox.xmin as bbox_xmin,
        bbox.ymin as bbox_ymin,
        bbox.xmax as bbox_xmax,
        bbox.ymax as bbox_ymax,
        -- Build display name: "Boston, MA" or "Back Bay, Boston, MA"
        CASE
            WHEN subtype = 'locality' THEN
                CONCAT(names.primary, ', ', REPLACE(region, 'US-', ''))
            WHEN subtype IN ('neighborhood', 'macrohood', 'microhood') THEN
                CONCAT(names.primary, ', ', REPLACE(region, 'US-', ''))
            ELSE
                CONCAT(names.primary, ', ', REPLACE(region, 'US-', ''))
        END as display_name,
        -- Search text (lowercase)
        LOWER(names.primary) as search_text
    FROM read_parquet(
        's3://overturemaps-us-west-2/release/2025-12-17.0/theme=divisions/type=division/*',
        hive_partitioning = true
    )
    WHERE region = 'US-MA'
      AND subtype IN ('locality', 'localadmin', 'neighborhood', 'macrohood', 'county')
)
TO 'exports/US-MA-divisions.parquet' (FORMAT PARQUET, COMPRESSION ZSTD);

-- Show count and sample
SELECT COUNT(*) as division_count FROM read_parquet('exports/US-MA-divisions.parquet');
SELECT subtype, COUNT(*) as count
FROM read_parquet('exports/US-MA-divisions.parquet')
GROUP BY subtype
ORDER BY count DESC;
