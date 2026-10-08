import type { RouteView } from "../model.js";

/** Hover drawings are expendable. Retain at most 16 walks and ~8 MiB of JS geometry. */
export class RouteCache {
  private entries = new Map<string, { route: RouteView; bytes: number }>();
  private bytes = 0;
  constructor(private maxBytes = 8 * 1024 * 1024, private maxEntries = 16) {}
  get(key: string) {
    const value = this.entries.get(key);
    if (!value) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value.route;
  }
  add(key: string, route: RouteView) {
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.bytes -= previous.bytes;
    }
    // Conservative estimate includes arrays, boxed numbers, object and summary strings.
    const bytes = 2048 + route.geometry.length * 128 + route.trailNames.join("").length * 2
      + (route.segments ?? []).reduce((sum, segment) => sum + 128 + (segment.id.length + (segment.name?.length ?? 0)) * 2, 0);
    if (bytes > this.maxBytes) return;
    this.entries.set(key, { route, bytes });
    this.bytes += bytes;
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
  }
  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
}
