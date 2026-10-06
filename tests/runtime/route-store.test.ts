import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouteStore, type SavedChoice } from '../../src/route-store.js';

it.each(['first', 'last'])('keeps selected representatives when they arrive %s, including tied directions', async order => {
  const directory = await mkdtemp(join(tmpdir(), 'alpine-representatives-'));
  const file = join(directory, 'results.sqlite');
  const store = createRouteStore(file, true);
  const saved = (startId: string, selected: boolean): SavedChoice => ({
    groupId: 'hike', direction: selected ? 1 : 0, preferred: selected && startId === 'east', preferredStart: selected,
    reverseId: `${selected ? 'a' : 'z'}-${startId}`, oppositeId: `${selected ? 'a' : 'z'}-${startId}`,
    route: {
      summary: { id: `${selected ? 'z' : 'a'}-${startId}`, startId, startName: startId, startKind: 'trailhead',
        startPosition: [0, 0], trailNames: ['Circuit'], distance: 5000, gain: 200,
        roadDistance: 0, repetition: 0, kind: 'loop', uncertain: false },
      sections: [{ section: 'fixture', id: 0, reverse: selected }],
    },
  });
  try {
    const choices = [saved('west', true), saved('east', true), saved('west', false), saved('east', false)];
    if (order === 'last') choices.reverse();
    store.begin();
    for (const item of choices) store.add(item);
    store.saveGeometry('fixture', 0, [[0, 0], [1, 0], [0, 1], [0, 0]]);
    store.commit();
    store.close();
    const published = createRouteStore(file);
    try {
      expect(published.counts).toEqual({ routeCount: 4, groupCount: 1 });
      expect(published.page()!.routes.map(route => route.id)).toEqual(['z-east']);
      expect(published.locations().map(route => route.id)).toEqual(['z-east']);
      expect(published.page(0, 'hike')!.routes.map(route => route.id)).toEqual(['z-east', 'z-west']);
      const west = published.route('z-west')!;
      expect([west.reverseId, west.oppositeId, west.groupSize]).toEqual(['a-west', 'a-west', 2]);
      expect(west.geometry).toEqual([[0, 0], [0, 1], [1, 0], [0, 0]]);
      expect(published.route('a-west')!.reverseId).toBe('z-west');
    } finally { published.close(); }
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
