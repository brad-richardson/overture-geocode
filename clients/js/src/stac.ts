/**
 * STAC client utilities for Overture Maps GERS registry lookup.
 *
 * Mirrors the approach used by overturemaps-py for efficient geometry fetching.
 */

export const STAC_CATALOG_URL = "https://stac.overturemaps.org/catalog.json";
export const S3_BASE_URL = "s3://overturemaps-us-west-2";

export interface StacCatalog {
  id: string;
  type: string;
  title?: string;
  description?: string;
  links: StacLink[];
  registry?: GersRegistry;
}

export interface StacLink {
  rel: string;
  href: string;
  type?: string;
  title?: string;
  latest?: boolean;
}

export interface GersRegistry {
  path: string;
  manifest: [string, string][]; // [filename, max_id]
}

export interface RegistryEntry {
  id: string;
  filepath: string | null;
  bbox: {
    xmin: number;
    ymin: number;
    xmax: number;
    ymax: number;
  } | null;
  version: string;
  first_seen: string;
  last_seen: string;
  last_changed: string;
}

// Cache catalog for session
let catalogCache: StacCatalog | null = null;

/**
 * Fetch the STAC catalog from Overture Maps.
 * Results are cached for the session.
 */
export async function getStacCatalog(
  fetchFn: typeof fetch = fetch
): Promise<StacCatalog> {
  if (catalogCache) return catalogCache;

  const response = await fetchFn(STAC_CATALOG_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch STAC catalog: ${response.status}`);
  }

  catalogCache = await response.json();
  return catalogCache!;
}

/**
 * Clear the cached STAC catalog.
 */
export function clearCatalogCache(): void {
  catalogCache = null;
}

/**
 * Get the latest Overture release version from the STAC catalog.
 */
export async function getLatestRelease(
  fetchFn: typeof fetch = fetch
): Promise<string> {
  const catalog = await getStacCatalog(fetchFn);

  for (const link of catalog.links) {
    if (link.latest === true) {
      // Extract version from href like "./2025-12-17.0/catalog.json"
      const match = link.href.match(/\.\/([0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+)\//);
      if (match) {
        return match[1];
      }
    }
  }

  throw new Error("Could not find latest release in STAC catalog");
}

/**
 * Binary search to find the registry file containing a GERS ID.
 *
 * The manifest is sorted by max_id, so we find the first file
 * where max_id >= the target ID.
 *
 * @param manifest Array of [filename, max_id] tuples sorted by max_id
 * @param gersId The GERS ID to look up
 * @returns The registry filename or null if not found
 */
export function findRegistryFile(
  manifest: [string, string][],
  gersId: string
): string | null {
  if (manifest.length === 0) return null;

  const id = gersId.toLowerCase();
  let left = 0;
  let right = manifest.length - 1;

  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (manifest[mid][1] < id) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }

  // Check if the found file's max_id covers our target
  return manifest[left]?.[1] >= id ? manifest[left][0] : null;
}

/**
 * Get the S3 path for a registry file.
 */
export function getRegistryS3Path(registry: GersRegistry, filename: string): string {
  return `${S3_BASE_URL}/${registry.path}/${filename}`;
}

/**
 * Get the S3 path for a data file.
 */
export function getDataS3Path(filepath: string): string {
  return `${S3_BASE_URL}/${filepath}`;
}
