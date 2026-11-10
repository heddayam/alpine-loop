import { afterEach, expect, it } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readDataset } from '../../src/dataset.js';
import type { JobInputs } from '../../src/model.js';
import { createNetworkFixture, query } from './network-fixture.js';

const cleanup: string[] = [];
afterEach(async () => { for (const directory of cleanup.splice(0)) await rm(directory, { recursive: true, force: true }); });

it('re-verifies pinned job inputs whenever the prepared catalog file changes', async () => {
  const { directory } = await createNetworkFixture();
  cleanup.push(directory);
  const dataset = await readDataset(directory);
  const inputs: JobInputs = { version: dataset.catalog.info.id, sections: dataset.selectedSections(query)
    .map(({ id, name, state, regionId, regionName, bounds, boundary, files }) => ({ id, name, state, regionId, regionName, bounds, boundary, files })) };
  await dataset.verifyInputs(inputs);
  await dataset.verifyInputs(inputs);
  const file = join(directory, 'catalog.json');
  const catalog = JSON.parse(await readFile(file, 'utf8'));
  catalog.sections[0].name = 'Renamed section';
  await writeFile(file, JSON.stringify(catalog));
  await expect(dataset.verifyInputs(inputs)).rejects.toThrow('Prepared region changed during this job');
});
