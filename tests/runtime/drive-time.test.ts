import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDriveTime } from '../../src/drive-time.js';

const origin: [number, number] = [-122.33, 47.6];
const request = { origin, minutes: 120 };
const clockwise = [[0, 0], [0, 4], [4, 4], [4, 0], [0, 0]];
const hole = [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]];
const island = [[1.5, 1.5], [1.5, 2], [2, 2], [2, 1.5], [1.5, 1.5]];
const distant = [[10, 0], [10, 1], [11, 1], [11, 0], [10, 0]];
const area = (rings: number[][][] = [clockwise]) => ({ value: {
  geometryType: 'esriGeometryPolygon', spatialReference: { wkid: 4326 }, features: [{ geometry: { rings } }],
} });
const json = (value: unknown) => new Response(JSON.stringify(value));
const success = { jobId: 'job_1', jobStatus: 'esriJobSucceeded' };
function provider(payload: unknown = area()) {
  const fetch = vi.fn<typeof globalThis.fetch>(async url => json(String(url).endsWith('/submitJob') ? success
    : String(url).endsWith('/solveServiceArea') ? { saPolygons: (payload as ReturnType<typeof area>).value } : payload));
  const reserve = vi.fn();
  return { fetch, reserve, drive: createDriveTime({ apiKey: 'private-key', fetch, reserve }) };
}
const signal = () => new AbortController().signal;
afterEach(() => vi.useRealTimers());

describe('ArcGIS driving-time filter', () => {
  it('submits one passenger-car range on legal unpaved roads, without live traffic or road hierarchy', async () => {
    const { drive, fetch, reserve } = provider();
    await drive.resolve(request, signal());
    expect(reserve).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://logistics.arcgis.com/arcgis/rest/services/World/ServiceAreas/GPServer/GenerateServiceAreas/submitJob');
    expect(String(url)).not.toContain('private-key');
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toMatchObject({ 'X-Esri-Authorization': 'Bearer private-key' });
    const body = init!.body as URLSearchParams;
    expect(body.get('break_values')).toBe('120');
    expect(body.get('break_units')).toBe('Minutes');
    expect(body.get('travel_direction')).toBe('Away From Facility');
    expect(body.has('time_of_day')).toBe(false);
    expect(JSON.parse(body.get('context')!)).toEqual({ outSR: { wkid: 4326 } });
    expect(JSON.parse(body.get('facilities')!).features[0].geometry).toEqual({ x: origin[0], y: origin[1] });
    expect(body.get('ignore_invalid_locations')).toBe('false');
    expect(JSON.parse(body.get('locate_settings')!)).toEqual({ default: {
      tolerance: 500, toleranceUnits: 'esriMeters', allowAutoRelocate: true,
      sources: [{ name: 'Routing_Streets' }],
    } });
    const mode = JSON.parse(body.get('travel_mode')!);
    expect(mode).toMatchObject({ type: 'AUTOMOBILE', impedanceAttributeName: 'TravelTime', useHierarchy: false });
    expect(mode.restrictionAttributeNames).toContain('Driving an Automobile');
    expect(mode.restrictionAttributeNames).not.toContain('Avoid Unpaved Roads');
    expect(mode.attributeParameterValues).toContainEqual({
      attributeName: 'Driving an Automobile', parameterName: 'Restriction Usage', value: 'PROHIBITED',
    });
  });

  it('preserves unordered holes, nested islands, and disconnected polygons with GeoJSON winding', async () => {
    const { drive } = provider(area([hole, distant, island, clockwise]));
    const { geometry } = await drive.resolve(request, signal());
    expect(geometry).toEqual({ type: 'MultiPolygon', coordinates: [
      [[...distant].reverse()], [[...island].reverse()], [[...clockwise].reverse(), [...hole].reverse()],
    ] });
  });

  it('uses direct requests through 60 minutes, retains local roads at 61, and never retries a failed direct call', async () => {
    const { drive, fetch, reserve } = provider(area([hole, distant, island, clockwise]));
    const direct = await drive.resolve({ origin, minutes: 60 }, signal());
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://route-api.arcgis.com/arcgis/rest/services/World/ServiceAreas/NAServer/ServiceArea_World/solveServiceArea');
    const body = init!.body as URLSearchParams;
    expect(body.get('defaultBreaks')).toBe('60');
    expect(body.get('travelDirection')).toBe('esriNATravelDirectionFromFacility');
    expect(body.get('ignoreInvalidLocations')).toBe('false');
    expect(body.has('timeOfDay')).toBe(false);
    expect(JSON.parse(body.get('travelMode')!)).toMatchObject({ impedanceAttributeName: 'TravelTime', useHierarchy: false });
    const queued = await drive.resolve({ origin, minutes: 61 }, signal());
    expect(direct.geometry).toEqual(queued.geometry);
    expect(fetch.mock.calls[1]![0]).toMatch(/\/submitJob$/);
    expect(reserve).toHaveBeenCalledTimes(2);
    const broken = vi.fn<typeof globalThis.fetch>(async () => json({ error: { message: 'private-key' } }));
    const denied = createDriveTime({ apiKey: 'private-key', reserve: () => {}, fetch: broken });
    await expect(denied.resolve({ origin, minutes: 30 }, signal())).rejects.not.toThrow('private-key');
    expect(broken).toHaveBeenCalledOnce();
  });

  it('cancels a stalled direct request without submitting another provider job', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Promise(() => {}));
    const pending = createDriveTime({ apiKey: 'key', reserve: () => {}, fetch })
      .resolve({ origin, minutes: 30 }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });

  it('clones cached results, expires them after 30 minutes, and keeps at most 32 areas', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { drive, reserve } = provider();
    const first = await drive.resolve(request, signal());
    first.geometry.coordinates[0]![0]![0]![0] = 99;
    expect((await drive.resolve(request, signal())).geometry.coordinates[0]![0]![0]![0]).toBe(0);
    expect(reserve).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 30 * 60_000);
    await drive.resolve(request, signal());
    expect(reserve).toHaveBeenCalledTimes(2);
    for (let minutes = 5; minutes < 37; minutes++) await drive.resolve({ origin, minutes }, signal());
    await drive.resolve(request, signal());
    expect(reserve).toHaveBeenCalledTimes(35);
  });

  it('does not call the provider for invalid, unconfigured, cancelled, or quota-denied requests', async () => {
    const { drive, fetch } = provider();
    for (const minutes of [4, 241, NaN, 120.5]) await expect(drive.resolve({ origin, minutes }, signal())).rejects.toThrow('5 and 240');
    await expect(drive.resolve({ origin: [181, 0], minutes: 20 }, signal())).rejects.toThrow('origin');
    await expect(drive.resolve(request, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
    await expect(createDriveTime({ apiKey: '', fetch, reserve: () => {} }).resolve(request, signal())).rejects.toThrow('not configured');
    const denied = new Error('Free driving-time allowance reached.');
    await expect(createDriveTime({ apiKey: 'key', fetch, reserve: () => { throw denied; } })
      .resolve(request, signal())).rejects.toBe(denied);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects absent polygons, invalid coordinates, wrong CRS, orphan holes, and empty or open rings', async () => {
    for (const payload of [{}, { value: { features: [] } },
      { value: { ...area().value, geometryType: 'esriGeometryPolyline' } },
      { value: { ...area().value, spatialReference: { wkid: 3857 } } },
      area([hole]), area([clockwise.slice(0, -1)]), area([[[0, 0], [0, 0], [0, 0], [0, 0]]]),
      area([[[0, 0], [0, 91], [2, 1], [0, 0]]]),
    ]) await expect(provider(payload).drive.resolve(request, signal())).rejects.toThrow('invalid');
  });

  it('rejects excessive response bytes and coordinates before retaining an area', async () => {
    const oversized = vi.fn<typeof globalThis.fetch>(async () => new Response('small', { headers: { 'content-length': '8388609' } }));
    await expect(createDriveTime({ apiKey: 'key', reserve: () => {}, fetch: oversized })
      .resolve(request, signal())).rejects.toThrow('could not calculate');
    const points = Array.from({ length: 100_001 }, () => [0, 0]);
    await expect(provider(area([points])).drive.resolve(request, signal())).rejects.toThrow('invalid');
    const stream = new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); controller.close();
    } });
    await expect(createDriveTime({ apiKey: 'key', reserve: () => {}, fetch: async () => new Response(stream) })
      .resolve(request, signal())).rejects.toThrow('invalid');
  });

  it('never trusts provider URLs or retries a failed billable submission, and hides provider secrets', async () => {
    for (const payload of [{ error: { message: 'private-key internal details', code: 498 } },
      { jobId: 'https://evil.invalid/key', jobStatus: 'esriJobSucceeded' },
      { ...success, jobStatus: 'unknown' }, { ...success, jobStatus: 'esriJobFailed', messages: ['private-key'] },
    ]) {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => json(payload));
      const drive = createDriveTime({ apiKey: 'private-key', reserve: () => {}, fetch });
      await expect(drive.resolve(request, signal())).rejects.not.toThrow('private-key');
      expect(fetch).toHaveBeenCalledOnce();
    }
    const fetch = vi.fn<typeof globalThis.fetch>(async url => {
      throw new Error(`private-key ${url}`);
    });
    await expect(createDriveTime({ apiKey: 'private-key', reserve: () => {}, fetch }).resolve(request, signal()))
      .rejects.toThrow('could not calculate');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('polls a submitted job using fixed URLs and fetches the result after success', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json({ ...success, jobStatus: 'esriJobSubmitted' }))
      .mockResolvedValueOnce(json({ ...success, results: { Service_Areas: { paramUrl: 'https://evil.invalid' } } }))
      .mockResolvedValueOnce(json(area()));
    await createDriveTime({ apiKey: 'key', reserve: () => {}, fetch }).resolve(request, signal());
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      expect.stringMatching(/\/submitJob$/), expect.stringMatching(/\/jobs\/job_1$/),
      expect.stringMatching(/\/jobs\/job_1\/results\/service_areas$/),
    ]);
  });

  it('cancels polling immediately, without waiting for the best-effort provider cancellation', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(async url => {
      if (String(url).endsWith('/submitJob')) return json({ ...success, jobStatus: 'esriJobExecuting' });
      return new Promise(() => {});
    });
    const pending = createDriveTime({ apiKey: 'key', reserve: () => {}, fetch }).resolve(request, controller.signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    // Let the small submit response finish parsing before cancelling its known job.
    await new Promise(resolve => setTimeout(resolve, 10));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch.mock.calls.at(-1)?.[0]).toMatch(/\/jobs\/job_1\/cancel$/);
    expect(fetch.mock.calls.at(-1)?.[1]?.signal).not.toBe(controller.signal);
  });

  it('times out even when a fetch implementation fails to respond to its abort signal', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Promise(() => {}));
    const pending = createDriveTime({ apiKey: 'key', reserve: () => {}, fetch }).resolve(request, signal());
    const assertion = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('applies the same deadline to stalled result-body reading and never caches a partial area', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const stream = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"value":'));
    }, cancel });
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(success)).mockResolvedValueOnce(new Response(stream))
      .mockResolvedValueOnce(json({ jobStatus: 'esriJobCancelled' }));
    const drive = createDriveTime({ apiKey: 'key', reserve: () => {}, fetch });
    const pending = drive.resolve(request, signal());
    const assertion = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch.mock.calls.at(-1)?.[0]).toMatch(/\/jobs\/job_1\/cancel$/);
    fetch.mockResolvedValueOnce(json(success)).mockResolvedValueOnce(json(area()));
    await expect(drive.resolve(request, signal())).resolves.toMatchObject({ geometry: { type: 'MultiPolygon' } });
    expect(fetch).toHaveBeenCalledTimes(5);
  });
});
