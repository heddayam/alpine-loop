import { setTimeout as delay } from 'node:timers/promises';
import type { Boundary } from './data-format.js';

const ENDPOINT = 'https://logistics.arcgis.com/arcgis/rest/services/World/ServiceAreas/GPServer/GenerateServiceAreas';
const DIRECT = 'https://route-api.arcgis.com/arcgis/rest/services/World/ServiceAreas/NAServer/ServiceArea_World/solveServiceArea';
const TTL = 30 * 60_000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_POINTS = 100_000;
const invalid = () => new Error('ArcGIS returned an invalid driving-time area.');
const failure = () => new Error('ArcGIS could not calculate this driving-time area.');
const cancelled = () => new DOMException('Driving-time calculation cancelled.', 'AbortError');
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const position = (value: unknown): value is [number, number] => Array.isArray(value) && value.length === 2 &&
  value.every(n => typeof n === 'number' && Number.isFinite(n)) &&
  Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;

// Passenger cars, including legal unpaved forest roads. Hierarchy omits local roads
// away from the origin; direct requests force it beyond 60 minutes, jobs beyond 240.
// https://developers.arcgis.com/rest/services-reference/enterprise/retrieve-travel-modes/
const restrictions = {
  'Avoid Private Roads': 'AVOID_MEDIUM', 'Driving an Automobile': 'PROHIBITED',
  'Through Traffic Prohibited': 'AVOID_HIGH', 'Roads Under Construction Prohibited': 'PROHIBITED',
  'Avoid Gates': 'AVOID_MEDIUM', 'Avoid Express Lanes': 'PROHIBITED', 'Avoid Carpool Roads': 'PROHIBITED',
};
const travelMode = {
  name: 'Rural Driving Time', type: 'AUTOMOBILE', impedanceAttributeName: 'TravelTime',
  timeAttributeName: 'TravelTime', distanceAttributeName: 'Kilometers', useHierarchy: false,
  uturnAtJunctions: 'esriNFSBAtDeadEndsAndIntersections', simplificationTolerance: 10,
  simplificationToleranceUnits: 'esriMeters', restrictionAttributeNames: Object.keys(restrictions),
  attributeParameterValues: Object.entries(restrictions).map(([attributeName, value]) =>
    ({ attributeName, parameterName: 'Restriction Usage', value })),
};

function contains(point: number[], ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a[1]! > point[1]!) !== (b[1]! > point[1]!) &&
      point[0]! < (b[0]! - a[0]!) * (point[1]! - a[1]!) / (b[1]! - a[1]!) + a[0]!) inside = !inside;
  }
  return inside;
}

/** Esri exterior rings are clockwise; holes may precede their owning exterior. */
function geometry(payload: Record<string, unknown>): Boundary {
  const value = payload.value;
  if (!record(value) || value.geometryType !== 'esriGeometryPolygon' || !Array.isArray(value.features) ||
    !value.features.length || value.features.length > 2048) throw invalid();
  let count = 0;
  const polygons: number[][][][] = [];
  for (const feature of value.features) {
    if (!record(feature) || !record(feature.geometry)) throw invalid();
    const shape = feature.geometry;
    const sr = shape.spatialReference ?? value.spatialReference;
    if (!record(sr) || sr.wkid !== 4326 || sr.latestWkid !== undefined && sr.latestWkid !== 4326 ||
      shape.curveRings !== undefined || !Array.isArray(shape.rings) || !shape.rings.length || shape.rings.length > 2048)
      throw invalid();
    const rings = shape.rings.map((ring: unknown) => {
      if (!Array.isArray(ring) || ring.length < 4 || (count += ring.length) > MAX_POINTS || !ring.every(position))
        throw invalid();
      const first = ring[0]!, last = ring[ring.length - 1]!;
      if (first[0] !== last[0] || first[1] !== last[1]) throw invalid();
      // Shift before calculating area to preserve accuracy for small polygons.
      const area = ring.reduce((sum, a, i) => {
        const b = ring[(i + 1) % ring.length]!;
        return sum + (a[0] - first[0]) * (b[1] - first[1]) - (b[0] - first[0]) * (a[1] - first[1]);
      }, 0);
      if (!Number.isFinite(area) || Math.abs(area) < 1e-12) throw invalid();
      return { ring, area };
    });
    const outer = rings.filter(r => r.area < 0).map(r => ({ ...r, polygon: [r.ring] }));
    if (!outer.length) throw invalid();
    for (const hole of rings.filter(r => r.area > 0)) {
      const parent = outer.filter(r => Math.abs(r.area) > hole.area && contains(hole.ring[0]!, r.ring))
        .sort((a, b) => Math.abs(a.area) - Math.abs(b.area))[0];
      if (!parent) throw invalid();
      parent.polygon.push(hole.ring);
    }
    // GeoJSON uses opposite winding to Esri.
    polygons.push(...outer.map(r => r.polygon.map(ring => [...ring].reverse())));
  }
  return { type: 'MultiPolygon', coordinates: polygons };
}

type Result = { geometry: Boundary; resolvedAt: string };
type Options = { apiKey?: string; reserve: () => void; fetch?: typeof globalThis.fetch };

/** One billable submission per cache miss. Never retry a submission or trust provider URLs. */
export function createDriveTime(options: Options) {
  const apiKey = options.apiKey ?? process.env.ARCGIS_API_KEY;
  const fetcher = options.fetch ?? globalThis.fetch;
  const cache = new Map<string, { expires: number; result: Result }>();
  async function json(url: string, fields: Record<string, string>, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetcher(url, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'X-Esri-Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ f: 'json', ...fields }),
      });
    } catch { throw failure(); }
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > MAX_BYTES) {
      void response.body?.cancel().catch(() => {});
      throw failure();
    }
    const reader = response.body.getReader();
    const stopReading = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', stopReading, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        if ((size += value.byteLength) > MAX_BYTES) throw invalid();
        chunks.push(value);
      }
      const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!record(payload)) throw invalid();
      if (payload.error) throw failure();
      return payload;
    } catch { throw invalid(); }
    finally { signal.removeEventListener('abort', stopReading); stopReading(); reader.releaseLock(); }
  }
  return {
    available: !!apiKey,
    async resolve(request: { origin: [number, number]; minutes: number }, signal: AbortSignal): Promise<Result> {
      if (signal.aborted) throw cancelled();
      if (!position(request.origin) || !Number.isInteger(request.minutes) || request.minutes < 5 || request.minutes > 240)
        throw new Error('Choose an origin and a driving time between 5 and 240 minutes.');
      if (!apiKey) throw new Error('Driving-time filtering is not configured.');
      const key = JSON.stringify([request.origin, request.minutes]);
      const cached = cache.get(key);
      if (cached && cached.expires > Date.now()) return structuredClone(cached.result);
      options.reserve();
      if (signal.aborted) throw cancelled();
      const controller = new AbortController();
      let timedOut = false, job: string | undefined;
      const abort = () => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => { timedOut = true; abort(); }, 120_000);
      timer.unref();
      const stopped = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () =>
        reject(timedOut ? new Error('Driving-time calculation timed out. Try again.') : cancelled()), { once: true }));
      const cancelJob = () => {
        if (job) void json(`${ENDPOINT}/jobs/${encodeURIComponent(job)}/cancel`, {}, AbortSignal.timeout(5000)).catch(() => {});
      };
      const calculate = async (): Promise<Result> => {
        const facilities = JSON.stringify({ geometryType: 'esriGeometryPoint', spatialReference: { wkid: 4326 },
          features: [{ geometry: { x: request.origin[0], y: request.origin[1] }, attributes: { Name: 'Origin' } }] });
        const mode = JSON.stringify(travelMode);
        const locate = JSON.stringify({ default: { tolerance: 500, toleranceUnits: 'esriMeters',
          allowAutoRelocate: true, sources: [{ name: 'Routing_Streets' }] } });
        // Avoid job startup for short drives without sacrificing distant local roads.
        // https://developers.arcgis.com/rest/routing/serviceArea-service-direct/
        if (request.minutes <= 60) {
          const payload = await json(DIRECT, {
            facilities, travelMode: mode, defaultBreaks: String(request.minutes),
            travelDirection: 'esriNATravelDirectionFromFacility', outputPolygons: 'esriNAOutputPolygonSimplified',
            splitPolygonsAtBreaks: 'false', outputLines: 'esriNAOutputLineNone',
            ignoreInvalidLocations: 'false', outSR: '4326', locateSettings: locate,
          }, controller.signal);
          controller.signal.throwIfAborted();
          return { geometry: geometry({ value: payload.saPolygons }), resolvedAt: new Date().toISOString() };
        }
        const submitted = await json(`${ENDPOINT}/submitJob`, {
          facilities,
          break_values: String(request.minutes), break_units: 'Minutes', travel_direction: 'Away From Facility',
          travel_mode: mode, polygon_overlap_type: 'Disks', polygon_detail: 'Standard',
          output_type: 'Polygons', output_format: 'Feature Set', ignore_invalid_locations: 'false',
          locate_settings: locate,
          context: JSON.stringify({ outSR: { wkid: 4326 } }),
        }, controller.signal);
        if (typeof submitted.jobId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(submitted.jobId)) throw invalid();
        job = submitted.jobId;
        if (controller.signal.aborted) { cancelJob(); throw cancelled(); }
        let status = submitted;
        while (status.jobStatus !== 'esriJobSucceeded') {
          if (!['esriJobSubmitted', 'esriJobWaiting', 'esriJobExecuting', 'esriJobNew'].includes(String(status.jobStatus)))
            throw failure();
          await delay(1000, undefined, { signal: controller.signal });
          status = await json(`${ENDPOINT}/jobs/${encodeURIComponent(job)}`, {}, controller.signal);
        }
        const payload = await json(`${ENDPOINT}/jobs/${encodeURIComponent(job)}/results/service_areas`, {}, controller.signal);
        controller.signal.throwIfAborted();
        return { geometry: geometry(payload), resolvedAt: new Date().toISOString() };
      };
      try {
        const result = await Promise.race([calculate(), stopped]);
        cache.delete(key);
        for (const [key, value] of cache) if (value.expires <= Date.now()) cache.delete(key);
        cache.set(key, { expires: Date.now() + TTL, result });
        if (cache.size > 32) cache.delete(cache.keys().next().value!);
        return structuredClone(result);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (controller.signal.aborted) cancelJob();
      }
    },
  };
}
