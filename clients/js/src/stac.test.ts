import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getStacCatalog,
  findRegistryFile,
  getRegistryS3Path,
  getDataS3Path,
  getLatestRelease,
  clearCatalogCache,
  STAC_CATALOG_URL,
  S3_BASE_URL,
} from "./stac";

// Mock STAC catalog response
const mockStacCatalog = {
  id: "overturemaps",
  type: "Catalog",
  title: "Overture Maps Data",
  description: "Overture Maps Foundation data releases",
  links: [
    { rel: "root", href: "./catalog.json", type: "application/json" },
    { rel: "child", href: "./2025-12-17.0/catalog.json", title: "2025-12-17.0", latest: true },
    { rel: "child", href: "./2025-10-23.0/catalog.json", title: "2025-10-23.0" },
  ],
  registry: {
    path: "release/2025-12-17.0/gers",
    manifest: [
      ["000.parquet", "0fffffff-ffff-ffff-ffff-ffffffffffff"],
      ["001.parquet", "1fffffff-ffff-ffff-ffff-ffffffffffff"],
      ["002.parquet", "2fffffff-ffff-ffff-ffff-ffffffffffff"],
      ["00a.parquet", "ffffffff-ffff-ffff-ffff-ffffffffffff"],
    ] as [string, string][],
  },
};

describe("STAC utilities", () => {
  beforeEach(() => {
    clearCatalogCache();
  });

  describe("getStacCatalog", () => {
    it("should fetch and cache catalog", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockStacCatalog),
      });

      // First call should fetch
      const catalog1 = await getStacCatalog(mockFetch);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(STAC_CATALOG_URL);
      expect(catalog1.id).toBe("overturemaps");

      // Second call should use cache
      const catalog2 = await getStacCatalog(mockFetch);
      expect(mockFetch).toHaveBeenCalledTimes(1); // Still 1
      expect(catalog2).toBe(catalog1); // Same reference
    });

    it("should throw on failed fetch", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      await expect(getStacCatalog(mockFetch)).rejects.toThrow(
        "Failed to fetch STAC catalog: 500"
      );
    });
  });

  describe("getLatestRelease", () => {
    it("should extract latest release version", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockStacCatalog),
      });

      const release = await getLatestRelease(mockFetch);
      expect(release).toBe("2025-12-17.0");
    });

    it("should throw when latest not found", async () => {
      const catalogWithoutLatest = {
        ...mockStacCatalog,
        links: [
          { rel: "child", href: "./2025-10-23.0/catalog.json" },
        ],
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(catalogWithoutLatest),
      });

      await expect(getLatestRelease(mockFetch)).rejects.toThrow(
        "Could not find latest release in STAC catalog"
      );
    });
  });

  describe("findRegistryFile", () => {
    const manifest: [string, string][] = [
      ["000.parquet", "0fffffff-ffff-ffff-ffff-ffffffffffff"],
      ["001.parquet", "1fffffff-ffff-ffff-ffff-ffffffffffff"],
      ["002.parquet", "2fffffff-ffff-ffff-ffff-ffffffffffff"],
      ["00a.parquet", "afffffff-ffff-ffff-ffff-ffffffffffff"],
      ["00f.parquet", "ffffffff-ffff-ffff-ffff-ffffffffffff"],
    ];

    it("should find correct file for ID at start of range", () => {
      const result = findRegistryFile(manifest, "00000000-0000-0000-0000-000000000000");
      expect(result).toBe("000.parquet");
    });

    it("should find correct file for ID in middle of range", () => {
      const result = findRegistryFile(manifest, "15000000-0000-0000-0000-000000000000");
      expect(result).toBe("001.parquet");
    });

    it("should find correct file for ID at end of range", () => {
      const result = findRegistryFile(manifest, "1fffffff-ffff-ffff-ffff-ffffffffffff");
      expect(result).toBe("001.parquet");
    });

    it("should find last file for high IDs", () => {
      const result = findRegistryFile(manifest, "f0000000-0000-0000-0000-000000000000");
      expect(result).toBe("00f.parquet");
    });

    it("should return null for empty manifest", () => {
      const result = findRegistryFile([], "abc123");
      expect(result).toBeNull();
    });

    it("should handle case-insensitive IDs", () => {
      const result1 = findRegistryFile(manifest, "1AAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA");
      const result2 = findRegistryFile(manifest, "1aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
      expect(result1).toBe(result2);
    });

    it("should return null when ID is beyond all files", () => {
      const smallManifest: [string, string][] = [
        ["000.parquet", "0fffffff-ffff-ffff-ffff-ffffffffffff"],
      ];
      // This ID starts with 'f' which is > '0', so it's beyond the only file
      const result = findRegistryFile(smallManifest, "f0000000-0000-0000-0000-000000000000");
      expect(result).toBeNull();
    });
  });

  describe("getRegistryS3Path", () => {
    it("should construct correct S3 path", () => {
      const registry = {
        path: "release/2025-12-17.0/gers",
        manifest: [] as [string, string][],
      };

      const path = getRegistryS3Path(registry, "001.parquet");
      expect(path).toBe(`${S3_BASE_URL}/release/2025-12-17.0/gers/001.parquet`);
    });
  });

  describe("getDataS3Path", () => {
    it("should construct correct S3 path", () => {
      const path = getDataS3Path("release/2025-12-17.0/theme=addresses/type=address/part-001.parquet");
      expect(path).toBe(`${S3_BASE_URL}/release/2025-12-17.0/theme=addresses/type=address/part-001.parquet`);
    });
  });
});
