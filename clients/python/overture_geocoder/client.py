"""Overture Geocoder Python Client."""

from dataclasses import dataclass
from typing import Any, Optional

import httpx

__all__ = ["OvertureGeocoder", "GeocoderResult", "geocode"]

# Default API URL - update when deployed
DEFAULT_API_URL = "http://localhost:8787"
OVERTURE_RELEASE = "2025-12-17.0"


@dataclass
class GeocoderResult:
    """A geocoding result."""

    gers_id: str
    display_name: str
    lat: float
    lon: float
    boundingbox: list[float]
    importance: float
    address: Optional[dict[str, str]] = None
    _geocoder: Optional["OvertureGeocoder"] = None

    def get_geometry(self) -> Optional[dict[str, Any]]:
        """Fetch full geometry from Overture S3 via DuckDB."""
        if self._geocoder is None:
            raise ValueError("No geocoder instance - use OvertureGeocoder.search()")
        return self._geocoder.get_geometry(self.gers_id)


class OvertureGeocoder:
    """Forward geocoder using Overture Maps address data."""

    def __init__(
        self,
        api_url: str = DEFAULT_API_URL,
        overture_release: str = OVERTURE_RELEASE,
    ):
        self.api_url = api_url.rstrip("/")
        self.overture_release = overture_release
        self._http = httpx.Client(timeout=30.0)
        self._duckdb = None

    def search(
        self,
        query: str,
        limit: int = 10,
        countrycodes: Optional[str] = None,
        viewbox: Optional[tuple[float, float, float, float]] = None,
        bounded: bool = False,
        addressdetails: bool = False,
    ) -> list[GeocoderResult]:
        """
        Search for addresses matching the query.

        Args:
            query: Free-form search string
            limit: Maximum results (1-40)
            countrycodes: Comma-separated ISO country codes
            viewbox: Bounding box (lon1, lat1, lon2, lat2)
            bounded: Restrict results to viewbox
            addressdetails: Include address breakdown

        Returns:
            List of GeocoderResult objects
        """
        params: dict[str, Any] = {
            "q": query,
            "format": "jsonv2",
            "limit": min(limit, 40),
        }

        if countrycodes:
            params["countrycodes"] = countrycodes
        if viewbox:
            params["viewbox"] = ",".join(map(str, viewbox))
        if bounded:
            params["bounded"] = "1"
        if addressdetails:
            params["addressdetails"] = "1"

        response = self._http.get(f"{self.api_url}/search", params=params)
        response.raise_for_status()

        return [
            GeocoderResult(
                gers_id=r["gers_id"],
                display_name=r["display_name"],
                lat=float(r["lat"]),
                lon=float(r["lon"]),
                boundingbox=[float(b) for b in r["boundingbox"]],
                importance=r.get("importance", 0),
                address=r.get("address"),
                _geocoder=self,
            )
            for r in response.json()
        ]

    def get_geometry(self, gers_id: str) -> Optional[dict[str, Any]]:
        """
        Fetch full geometry from Overture S3 via DuckDB.

        Requires `duckdb` package: pip install overture-geocoder[geometry]
        """
        if self._duckdb is None:
            try:
                import duckdb
            except ImportError:
                raise ImportError(
                    "DuckDB required for geometry fetching. "
                    "Install with: pip install overture-geocoder[geometry]"
                )
            self._duckdb = duckdb.connect()
            self._duckdb.execute("INSTALL httpfs; LOAD httpfs;")
            self._duckdb.execute("INSTALL spatial; LOAD spatial;")
            self._duckdb.execute("SET s3_region = 'us-west-2';")

        # Query Overture S3 directly
        result = self._duckdb.execute(
            f"""
            SELECT
                id,
                ST_AsGeoJSON(geometry) as geometry,
                country,
                postcode,
                street,
                number,
                unit,
                address_levels
            FROM read_parquet(
                's3://overturemaps-us-west-2/release/{self.overture_release}/theme=addresses/type=address/*'
            )
            WHERE id = ?
            LIMIT 1
            """,
            [gers_id],
        ).fetchone()

        if result:
            import json

            return {
                "type": "Feature",
                "id": result[0],
                "geometry": json.loads(result[1]),
                "properties": {
                    "country": result[2],
                    "postcode": result[3],
                    "street": result[4],
                    "number": result[5],
                    "unit": result[6],
                    "address_levels": result[7],
                },
            }
        return None

    def close(self):
        """Close HTTP client."""
        self._http.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def geocode(query: str, **kwargs) -> list[GeocoderResult]:
    """Quick geocode function using default settings."""
    with OvertureGeocoder() as client:
        return client.search(query, **kwargs)
