"""Pytest fixtures for Overture Geocoder tests."""

import pytest
import httpx


# Mock response data - using numbers to match actual server responses
MOCK_SEARCH_RESULTS = [
    {
        "gers_id": "abc-123",
        "primary_name": "Boston",
        "lat": 42.3601,
        "lon": -71.0589,
        "boundingbox": [42.227, 42.397, -71.191, -70.923],
        "importance": 0.85,
        "type": "locality",
    },
    {
        "gers_id": "def-456",
        "primary_name": "Cambridge",
        "lat": 42.3736,
        "lon": -71.1097,
        "boundingbox": [42.352, 42.404, -71.161, -71.064],
        "importance": 0.75,
        "type": "locality",
    },
]

MOCK_GEOJSON_RESPONSE = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "id": "abc-123",
            "properties": {
                "gers_id": "abc-123",
                "primary_name": "Boston",
                "importance": 0.85,
                "type": "locality",
            },
            "bbox": [42.227, 42.397, -71.191, -70.923],
            "geometry": {
                "type": "Point",
                "coordinates": [-71.0589, 42.3601],
            },
        },
    ],
}


@pytest.fixture
def mock_search_results():
    """Return mock search results."""
    return MOCK_SEARCH_RESULTS


@pytest.fixture
def mock_geojson_response():
    """Return mock GeoJSON response."""
    return MOCK_GEOJSON_RESPONSE
