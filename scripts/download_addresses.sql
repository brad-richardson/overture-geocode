-- Download and filter Overture Maps addresses for Massachusetts
-- Run with: duckdb < scripts/download_addresses.sql
--
-- Prerequisites:
--   brew install duckdb  (or download from duckdb.org)
--
-- Output: exports/US-MA.parquet (~50-100MB)

-- Install and load required extensions
INSTALL httpfs;
LOAD httpfs;
INSTALL spatial;
LOAD spatial;

-- Configure S3 for anonymous access (Overture is public)
SET s3_region = 'us-west-2';

-- Set memory limit for large operations
SET memory_limit = '4GB';
SET threads = 4;

-- Show progress
.timer on

-- Extract Massachusetts addresses with display name and search text
-- address_levels schema: [{value: state}, {value: city}]
-- Index 0 = state abbreviation (e.g., "MA")
-- Index 1 = city (e.g., "Boston")
COPY (
    SELECT
        id as gers_id,
        ST_X(geometry) as lon,
        ST_Y(geometry) as lat,
        bbox.xmin as bbox_xmin,
        bbox.ymin as bbox_ymin,
        bbox.xmax as bbox_xmax,
        bbox.ymax as bbox_ymax,
        postcode,
        street,
        number,
        unit,
        -- Extract city and state from address_levels array
        address_levels[1].value as state,
        address_levels[2].value as city,
        postal_city,
        -- Build display name: "123 Main St, Boston, MA 02101"
        CONCAT_WS(', ',
            NULLIF(CONCAT_WS(' ', number, street, unit), ''),
            COALESCE(address_levels[2].value, postal_city),
            CONCAT(address_levels[1].value, ' ', postcode)
        ) as display_name,
        -- Build search text (lowercase, for FTS indexing)
        LOWER(CONCAT_WS(' ',
            COALESCE(number, ''),
            COALESCE(street, ''),
            COALESCE(address_levels[2].value, postal_city, ''),
            COALESCE(postcode, '')
        )) as search_text
    FROM read_parquet(
        's3://overturemaps-us-west-2/release/2025-12-17.0/theme=addresses/type=address/*',
        hive_partitioning = true
    )
    WHERE country = 'US'
      AND address_levels[1].value = 'MA'
)
TO 'exports/US-MA.parquet' (FORMAT PARQUET, COMPRESSION ZSTD);

-- Show count
SELECT COUNT(*) as address_count FROM read_parquet('exports/US-MA.parquet');
