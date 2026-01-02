/**
 * Basic usage examples for the Overture Geocoder client.
 *
 * Run with: npx tsx examples/basic-usage.ts
 */

import { OvertureGeocoder, geocode } from "../src/index";

async function main() {
  // ==========================================================================
  // Quick functions (use default configuration)
  // ==========================================================================

  console.log("=== Quick geocode function ===");
  const quickResults = await geocode("123 Main St, Boston, MA");
  console.log("Found:", quickResults.length, "results");
  if (quickResults.length > 0) {
    console.log("First result:", quickResults[0].primary_name);
  }

  // ==========================================================================
  // Using the client class
  // ==========================================================================

  console.log("\n=== OvertureGeocoder client ===");

  // Create a client with custom configuration
  const client = new OvertureGeocoder({
    baseUrl: "http://localhost:8787", // Default
    timeout: 10000, // 10 seconds
  });

  // Basic search
  console.log("\n--- Basic search ---");
  const results = await client.search("Boston City Hall");
  console.log("Search results:", results.length);
  for (const result of results.slice(0, 3)) {
    console.log(`  - ${result.primary_name}`);
    console.log(`    Lat: ${result.lat}, Lon: ${result.lon}`);
    console.log(`    GERS ID: ${result.gers_id}`);
  }

  // ==========================================================================
  // Search options
  // ==========================================================================

  console.log("\n--- Search with options ---");

  // Limit results
  const limited = await client.search("Main St", { limit: 5 });
  console.log("Limited to 5 results:", limited.length);

  // Include address details
  const withAddress = await client.search("123 Main St", {
    addressdetails: true,
    limit: 1,
  });
  if (withAddress.length > 0 && withAddress[0].address) {
    console.log("Address breakdown:");
    console.log("  City:", withAddress[0].address.city);
    console.log("  State:", withAddress[0].address.state);
    console.log("  Postcode:", withAddress[0].address.postcode);
  }

  // ==========================================================================
  // GeoJSON format
  // ==========================================================================

  console.log("\n--- GeoJSON format ---");

  const geojson = await client.searchGeoJSON("Boston Public Library");
  console.log("GeoJSON type:", geojson.type);
  console.log("Features:", geojson.features.length);
  if (geojson.features.length > 0) {
    const feature = geojson.features[0];
    console.log("First feature:");
    console.log("  ID:", feature.id);
    console.log("  Coordinates:", feature.geometry.coordinates);
  }

  // ==========================================================================
  // Get full geometry from Overture S3
  // ==========================================================================

  console.log("\n--- Get full geometry ---");

  if (results.length > 0) {
    const gersId = results[0].gers_id;
    console.log("Fetching geometry for GERS ID:", gersId);

    // Get full geometry from Overture S3
    const geometry = await client.getFullGeometry(gersId);
    if (geometry) {
      console.log("Geometry type:", geometry.geometry.type);
    }
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
