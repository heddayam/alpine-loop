import { afterEach, describe, expect, it } from "vitest";
import { SqliteUsageStore } from "./usage";

const stores: SqliteUsageStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("aggregate SQLite usage guard", () => {
  it("atomically fails closed at the configured monthly cap", async () => {
    const store = new SqliteUsageStore(":memory:");
    stores.push(store);
    const now = new Date("2026-08-04T00:00:00Z");
    await expect(store.reserve("arcgis-service-areas", 2, now)).resolves.toMatchObject({ used: 1, remaining: 1 });
    await expect(store.reserve("arcgis-service-areas", 2, now)).resolves.toMatchObject({ used: 2, remaining: 0 });
    await expect(store.reserve("arcgis-service-areas", 2, now)).resolves.toBeNull();
  });

  it("separates providers and UTC months", async () => {
    const store = new SqliteUsageStore(":memory:");
    stores.push(store);
    await store.reserve("geocoding", 10, new Date("2026-08-31T23:59:59Z"));
    await expect(store.get("service-areas", 10, new Date("2026-08-31T23:59:59Z"))).resolves.toMatchObject({ used: 0 });
    await expect(store.get("geocoding", 10, new Date("2026-09-01T00:00:00Z"))).resolves.toMatchObject({ used: 0 });
  });
});
