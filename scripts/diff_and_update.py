#!/usr/bin/env python3
"""
Differential update script for Overture geocoder D1 database.

Compares new Overture data against production and generates minimal SQL updates.
Uses the version field (which increments when features change) to identify updates.

Usage:
    # Generate diff SQL files (requires production versions CSV)
    python scripts/diff_and_update.py indexes/divisions-global.db exports/diff \
        --prod-versions prod_versions.csv --release 2025-12-17.0

    # Export production versions (run via wrangler)
    # wrangler d1 execute geocoder-divisions-global --remote \
    #   --command "SELECT gers_id, version FROM divisions" > prod_versions.csv

Output:
    exports/diff/upserts.sql    - INSERT OR REPLACE for new/changed records
    exports/diff/deletes.sql    - DELETE for removed records
    exports/diff/metadata.sql   - UPDATE release version
    exports/diff/stats.json     - Statistics about the diff
"""

import argparse
import csv
import json
import math
import sqlite3
from pathlib import Path


def load_prod_versions(csv_path: Path) -> dict[str, int]:
    """Load production gers_id -> version mapping from CSV.

    Handles case-insensitive column names and various edge cases.
    """
    versions = {}
    with open(csv_path, "r") as f:
        reader = csv.DictReader(f)

        # Normalize fieldnames to lowercase for case-insensitive matching
        if reader.fieldnames:
            fieldname_map = {name.lower(): name for name in reader.fieldnames}
        else:
            return versions

        gers_id_col = fieldname_map.get("gers_id")
        version_col = fieldname_map.get("version")

        if not gers_id_col or not version_col:
            print(f"Warning: CSV missing required columns. Found: {reader.fieldnames}")
            return versions

        for row in reader:
            gers_id = row.get(gers_id_col, "").strip()
            version_str = row.get(version_col, "").strip()

            if gers_id and version_str:
                try:
                    versions[gers_id] = int(version_str)
                except ValueError:
                    print(f"Warning: Invalid version '{version_str}' for gers_id '{gers_id}'")
                    continue

    return versions


def escape_sql_string(s: str) -> str:
    """Escape a string for SQL by doubling single quotes."""
    if s is None:
        return "NULL"
    return "'" + s.replace("'", "''") + "'"


def format_value(val) -> str:
    """Format a Python value for SQL.

    Handles None, strings, integers, floats (including edge cases like NaN/Infinity).
    """
    if val is None:
        return "NULL"
    if isinstance(val, str):
        return escape_sql_string(val)
    if isinstance(val, float):
        # Handle special float values
        if math.isnan(val) or math.isinf(val):
            return "NULL"
        return str(val)
    if isinstance(val, int):
        return str(val)
    return escape_sql_string(str(val))


def generate_diff(
    db_path: Path,
    output_dir: Path,
    prod_versions: dict[str, int],
    release: str,
    chunk_size: int = 10000,
) -> dict:
    """Generate differential SQL updates."""

    if not db_path.exists():
        raise FileNotFoundError(f"Database not found: {db_path}")

    output_dir.mkdir(parents=True, exist_ok=True)

    db = sqlite3.connect(db_path)

    columns = [
        "gers_id", "version", "type", "primary_name", "lat", "lon",
        "bbox_xmin", "bbox_ymin", "bbox_xmax", "bbox_ymax",
        "population", "country", "region", "search_text"
    ]
    cols_str = ", ".join(columns)

    # Track stats
    stats = {
        "release": release,
        "total_new": 0,
        "inserts": 0,
        "updates": 0,
        "unchanged": 0,
        "deletes": 0,
    }

    # Track which gers_ids we've seen
    seen_gers_ids = set()

    # Open upserts file
    upserts_file = output_dir / "upserts.sql"
    with open(upserts_file, "w") as f:
        f.write("-- Upserts: new and changed records\n\n")

        cursor = db.execute(f"SELECT {cols_str} FROM divisions")

        batch_count = 0
        for row in cursor:
            gers_id = row[0]
            new_version = row[1]
            seen_gers_ids.add(gers_id)
            stats["total_new"] += 1

            prod_version = prod_versions.get(gers_id)

            if prod_version is None:
                # New record
                stats["inserts"] += 1
                values = ", ".join(format_value(v) for v in row)
                f.write(f"INSERT OR REPLACE INTO divisions ({cols_str}) VALUES ({values});\n")
                batch_count += 1
            elif new_version > prod_version:
                # Updated record
                stats["updates"] += 1
                values = ", ".join(format_value(v) for v in row)
                f.write(f"INSERT OR REPLACE INTO divisions ({cols_str}) VALUES ({values});\n")
                batch_count += 1
            else:
                # Unchanged
                stats["unchanged"] += 1

            # Progress marker for large updates
            if batch_count > 0 and batch_count % chunk_size == 0:
                f.write(f"-- Progress: {batch_count} records\n")

    db.close()

    # Generate deletes for records no longer in source
    deletes_file = output_dir / "deletes.sql"
    with open(deletes_file, "w") as f:
        f.write("-- Deletes: records removed from Overture\n\n")

        for gers_id in prod_versions.keys():
            if gers_id not in seen_gers_ids:
                stats["deletes"] += 1
                f.write(f"DELETE FROM divisions WHERE gers_id = {escape_sql_string(gers_id)};\n")

    # Generate metadata update
    metadata_file = output_dir / "metadata.sql"
    with open(metadata_file, "w") as f:
        f.write("-- Update release metadata\n")
        f.write(f"INSERT OR REPLACE INTO metadata (key, value) VALUES ('overture_release', {escape_sql_string(release)});\n")
        f.write(f"INSERT OR REPLACE INTO metadata (key, value) VALUES ('updated_at', datetime('now'));\n")

    # Write stats
    stats_file = output_dir / "stats.json"
    with open(stats_file, "w") as f:
        json.dump(stats, f, indent=2)

    return stats


def main():
    parser = argparse.ArgumentParser(
        description="Generate differential SQL updates for D1"
    )
    parser.add_argument(
        "db_path",
        type=Path,
        help="Path to new SQLite database"
    )
    parser.add_argument(
        "output_dir",
        type=Path,
        help="Output directory for SQL files"
    )
    parser.add_argument(
        "--prod-versions",
        type=Path,
        required=True,
        help="CSV file with production gers_id,version data"
    )
    parser.add_argument(
        "--release",
        required=True,
        help="Overture release version (e.g., 2025-12-17.0)"
    )
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=10000,
        help="Commit every N records (default: 10000)"
    )

    args = parser.parse_args()

    print(f"Loading production versions from {args.prod_versions}...")
    prod_versions = load_prod_versions(args.prod_versions)
    print(f"  Found {len(prod_versions):,} records in production")

    print(f"\nGenerating diff from {args.db_path}...")
    stats = generate_diff(
        db_path=args.db_path,
        output_dir=args.output_dir,
        prod_versions=prod_versions,
        release=args.release,
        chunk_size=args.chunk_size,
    )

    print(f"\nDiff statistics:")
    print(f"  Total in new release: {stats['total_new']:,}")
    print(f"  New records (inserts): {stats['inserts']:,}")
    print(f"  Changed records (updates): {stats['updates']:,}")
    print(f"  Unchanged records: {stats['unchanged']:,}")
    print(f"  Removed records (deletes): {stats['deletes']:,}")

    changes = stats['inserts'] + stats['updates'] + stats['deletes']
    if changes == 0:
        print(f"\n  No changes detected!")
    else:
        pct = 100 * changes / max(stats['total_new'], 1)
        print(f"\n  Total changes: {changes:,} ({pct:.2f}% of data)")

    print(f"\nOutput files:")
    print(f"  {args.output_dir}/upserts.sql")
    print(f"  {args.output_dir}/deletes.sql")
    print(f"  {args.output_dir}/metadata.sql")
    print(f"  {args.output_dir}/stats.json")

    return 0


if __name__ == "__main__":
    exit(main())
