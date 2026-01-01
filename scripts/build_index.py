#!/usr/bin/env python3
"""
Build SQLite FTS5 index from Overture address and division Parquet files.

Usage:
    python scripts/build_index.py exports/US-MA.parquet exports/US-MA-divisions.parquet indexes/US-MA.db

Prerequisites:
    pip install duckdb

Output:
    SQLite database with FTS5 full-text search index for addresses and divisions
"""

import sqlite3
import sys
from pathlib import Path

import duckdb


def build_fts_index(
    addresses_path: Path,
    divisions_path: Path,
    output_db: Path,
    batch_size: int = 10000
):
    """Build SQLite FTS5 index from Parquet files."""

    con = duckdb.connect()

    # Create SQLite database
    output_db.parent.mkdir(parents=True, exist_ok=True)
    if output_db.exists():
        output_db.unlink()

    db = sqlite3.connect(output_db)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=NORMAL")
    db.execute("PRAGMA cache_size=-64000")  # 64MB cache

    # Create unified table for all features
    db.execute("""
        CREATE TABLE features (
            rowid INTEGER PRIMARY KEY,
            gers_id TEXT NOT NULL,
            type TEXT NOT NULL,          -- 'address', 'locality', 'neighborhood', etc.
            display_name TEXT NOT NULL,
            lat REAL NOT NULL,
            lon REAL NOT NULL,
            bbox_xmin REAL NOT NULL,
            bbox_ymin REAL NOT NULL,
            bbox_xmax REAL NOT NULL,
            bbox_ymax REAL NOT NULL,
            population INTEGER,          -- For ranking divisions
            city TEXT,
            state TEXT,
            postcode TEXT
        )
    """)

    # Create FTS5 virtual table
    db.execute("""
        CREATE VIRTUAL TABLE features_fts USING fts5(
            search_text,
            content=features,
            content_rowid=rowid,
            tokenize='porter unicode61 remove_diacritics 1'
        )
    """)

    # Insert divisions first (they should rank higher)
    if divisions_path.exists():
        print(f"Reading divisions from {divisions_path}...")
        div_count = con.execute(
            f"SELECT COUNT(*) FROM read_parquet('{divisions_path}')"
        ).fetchone()[0]
        print(f"Found {div_count:,} divisions")

        cursor = con.execute(f"""
            SELECT
                gers_id,
                subtype as type,
                display_name,
                lat,
                lon,
                bbox_xmin,
                bbox_ymin,
                bbox_xmax,
                bbox_ymax,
                population,
                NULL as city,
                'MA' as state,
                NULL as postcode,
                search_text
            FROM read_parquet('{divisions_path}')
        """)

        batch = []
        inserted = 0

        for row in cursor.fetchall():
            batch.append(row)

            if len(batch) >= batch_size:
                _insert_batch(db, batch)
                inserted += len(batch)
                print(f"  Divisions: {inserted:,} / {div_count:,}")
                batch = []

        if batch:
            _insert_batch(db, batch)
            inserted += len(batch)
            print(f"  Divisions: {inserted:,} / {div_count:,} (done)")

    # Insert addresses
    if addresses_path.exists():
        print(f"Reading addresses from {addresses_path}...")
        addr_count = con.execute(
            f"SELECT COUNT(*) FROM read_parquet('{addresses_path}')"
        ).fetchone()[0]
        print(f"Found {addr_count:,} addresses")

        cursor = con.execute(f"""
            SELECT
                gers_id,
                'address' as type,
                display_name,
                lat,
                lon,
                bbox_xmin,
                bbox_ymin,
                bbox_xmax,
                bbox_ymax,
                NULL as population,
                city,
                state,
                postcode,
                search_text
            FROM read_parquet('{addresses_path}')
        """)

        batch = []
        inserted = 0

        for row in cursor.fetchall():
            batch.append(row)

            if len(batch) >= batch_size:
                _insert_batch(db, batch)
                inserted += len(batch)
                print(f"  Addresses: {inserted:,} / {addr_count:,} ({100*inserted/addr_count:.1f}%)")
                batch = []

        if batch:
            _insert_batch(db, batch)
            inserted += len(batch)
            print(f"  Addresses: {inserted:,} / {addr_count:,} (100%)")

    # Create indexes
    print("Creating indexes...")
    db.execute("CREATE INDEX idx_gers ON features(gers_id)")
    db.execute("CREATE INDEX idx_type ON features(type)")

    # Optimize FTS index
    print("Optimizing FTS index...")
    db.execute("INSERT INTO features_fts(features_fts) VALUES('optimize')")

    db.commit()
    db.close()
    con.close()

    # Report file size
    size_mb = output_db.stat().st_size / (1024 * 1024)
    print(f"Done! Index size: {size_mb:.1f} MB")


def _insert_batch(db: sqlite3.Connection, batch: list):
    """Insert a batch of features and their FTS entries."""
    # Insert into main table
    db.executemany(
        """
        INSERT INTO features (
            gers_id, type, display_name, lat, lon,
            bbox_xmin, bbox_ymin, bbox_xmax, bbox_ymax,
            population, city, state, postcode
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11], r[12]) for r in batch],
    )

    # Get last rowid range
    last_rowid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
    first_rowid = last_rowid - len(batch) + 1

    # Insert into FTS table
    db.executemany(
        "INSERT INTO features_fts(rowid, search_text) VALUES (?, ?)",
        [(first_rowid + i, batch[i][13]) for i in range(len(batch))],
    )


def test_search(db_path: Path, query: str, limit: int = 5):
    """Test search on the built index."""
    print(f"\nTest search: '{query}'")
    print("-" * 60)

    db = sqlite3.connect(db_path)

    # Search with boost for divisions (based on population)
    # BM25 returns negative scores where MORE negative = better match
    # Population boost: larger cities should rank higher
    # LOG10(675647) * 2 = 11.7 for Boston, which makes score more negative (better)
    results = db.execute(
        """
        SELECT
            f.type,
            f.display_name,
            f.population,
            f.lat,
            f.lon,
            bm25(features_fts) as bm25_score,
            CASE
                WHEN f.type != 'address' AND f.population IS NOT NULL
                THEN bm25(features_fts) - (LOG(f.population + 1) * 2.0)
                WHEN f.type != 'address'
                THEN bm25(features_fts) - 2.0
                ELSE bm25(features_fts)
            END as boosted_score
        FROM features_fts
        JOIN features f ON features_fts.rowid = f.rowid
        WHERE features_fts MATCH ?
        ORDER BY boosted_score
        LIMIT ?
        """,
        (query, limit),
    ).fetchall()

    for r in results:
        pop = f", pop={r[2]:,}" if r[2] else ""
        print(f"  [{r[0]:12}] {r[1]} ({r[3]:.4f}, {r[4]:.4f}){pop}")

    db.close()


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: python build_index.py <addresses.parquet> <divisions.parquet> <output.db>")
        print("Example: python build_index.py exports/US-MA.parquet exports/US-MA-divisions.parquet indexes/US-MA.db")
        sys.exit(1)

    addresses_path = Path(sys.argv[1])
    divisions_path = Path(sys.argv[2])
    output_db = Path(sys.argv[3])

    if not addresses_path.exists():
        print(f"Error: {addresses_path} not found")
        sys.exit(1)

    if not divisions_path.exists():
        print(f"Warning: {divisions_path} not found, building without divisions")

    build_fts_index(addresses_path, divisions_path, output_db)

    # Run test searches
    test_search(output_db, "boston")
    test_search(output_db, "cambridge")
    test_search(output_db, "main street boston")
