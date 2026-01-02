#!/usr/bin/env python3
"""
Update D1 database binding in wrangler.toml using proper TOML parsing.

Usage:
    python scripts/update_wrangler_binding.py DB_DIVISIONS new-db-name new-db-id
    python scripts/update_wrangler_binding.py DB_DIVISIONS_REVERSE geocoder-reverse-v2 abc-123-def
"""

import argparse
import sys

# Handle tomllib availability (Python 3.11+ has it built-in)
try:
    import tomllib
except ImportError:
    try:
        import tomli as tomllib
    except ImportError:
        print("Error: Missing TOML library. Install with: pip install tomli", file=sys.stderr)
        sys.exit(1)

try:
    import tomli_w
except ImportError:
    print("Error: Missing tomli-w library. Install with: pip install tomli-w", file=sys.stderr)
    sys.exit(1)


def update_binding(wrangler_path: str, binding_name: str, new_db_name: str, new_db_id: str) -> bool:
    """Update a D1 database binding in wrangler.toml.

    Args:
        wrangler_path: Path to wrangler.toml
        binding_name: The binding name (e.g., DB_DIVISIONS)
        new_db_name: New database name
        new_db_id: New database UUID

    Returns:
        True if successful, False otherwise
    """
    # Read the TOML file
    try:
        with open(wrangler_path, "rb") as f:
            config = tomllib.load(f)
    except FileNotFoundError:
        print(f"Error: File not found: {wrangler_path}", file=sys.stderr)
        return False
    except PermissionError:
        print(f"Error: Permission denied reading: {wrangler_path}", file=sys.stderr)
        return False
    except tomllib.TOMLDecodeError as e:
        print(f"Error: Invalid TOML in {wrangler_path}: {e}", file=sys.stderr)
        return False

    # Find and update the d1_databases entry
    d1_databases = config.get("d1_databases", [])
    if not d1_databases:
        print(f"Error: No d1_databases section found in {wrangler_path}", file=sys.stderr)
        return False

    found = False
    for db in d1_databases:
        if db.get("binding") == binding_name:
            old_name = db.get("database_name", "unknown")
            old_id = db.get("database_id", "unknown")
            db["database_name"] = new_db_name
            db["database_id"] = new_db_id
            found = True
            print(f"Updated {binding_name}:")
            print(f"  database_name: {old_name} -> {new_db_name}")
            print(f"  database_id: {old_id} -> {new_db_id}")
            break

    if not found:
        print(f"Error: Binding '{binding_name}' not found in {wrangler_path}", file=sys.stderr)
        print(f"Available bindings: {[db.get('binding') for db in d1_databases]}", file=sys.stderr)
        return False

    # Write back the TOML file
    try:
        with open(wrangler_path, "wb") as f:
            tomli_w.dump(config, f)
    except PermissionError:
        print(f"Error: Permission denied writing: {wrangler_path}", file=sys.stderr)
        return False
    except OSError as e:
        print(f"Error: Failed to write {wrangler_path}: {e}", file=sys.stderr)
        return False

    return True


def main():
    parser = argparse.ArgumentParser(
        description="Update D1 database binding in wrangler.toml"
    )
    parser.add_argument(
        "binding",
        help="Binding name (e.g., DB_DIVISIONS)"
    )
    parser.add_argument(
        "database_name",
        help="New database name"
    )
    parser.add_argument(
        "database_id",
        help="New database UUID"
    )
    parser.add_argument(
        "--wrangler",
        default="wrangler.toml",
        help="Path to wrangler.toml (default: wrangler.toml)"
    )

    args = parser.parse_args()

    success = update_binding(
        wrangler_path=args.wrangler,
        binding_name=args.binding,
        new_db_name=args.database_name,
        new_db_id=args.database_id,
    )

    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
