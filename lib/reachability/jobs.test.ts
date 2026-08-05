import { describe, expect, it } from "vitest";
import type { ReachabilityRequest } from "@/lib/contracts";
import { MemoryReachabilityJobStore, REACHABILITY_JOB_TTL_MS } from "./jobs";
import { TestClock } from "./test-helpers";

const REQUEST: ReachabilityRequest = {
  version: 1,
  packId: "fixture",
  origin: { lon: -122.1, lat: 37.2, label: "Sensitive label" },
  durationMinutes: 30,
};

describe("memory-only reachability jobs", () => {
  it("reuses a live request and expires all location-bearing state after 30 minutes", () => {
    const clock = new TestClock();
    const store = new MemoryReachabilityJobStore(clock);
    store.create("db52ceda-c6ef-47f1-9153-dba294a9eccc", REQUEST);
    expect(store.findReusable(REQUEST)?.origin.label).toBe("Sensitive label");

    clock.advance(REACHABILITY_JOB_TTL_MS);
    expect(store.lookup("db52ceda-c6ef-47f1-9153-dba294a9eccc")).toEqual({ state: "expired" });
    expect(store.findReusable(REQUEST)).toBeUndefined();
  });

  it("does not reuse failed or deleted work", () => {
    const store = new MemoryReachabilityJobStore(new TestClock());
    store.create("db52ceda-c6ef-47f1-9153-dba294a9eccc", REQUEST);
    store.update("db52ceda-c6ef-47f1-9153-dba294a9eccc", { state: "failed" });
    expect(store.findReusable(REQUEST)).toBeUndefined();
    expect(store.delete("db52ceda-c6ef-47f1-9153-dba294a9eccc")).toBeDefined();
    expect(store.lookup("db52ceda-c6ef-47f1-9153-dba294a9eccc")).toEqual({ state: "missing" });
  });
});
