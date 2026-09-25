import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import polygonClipping from 'polygon-clipping';
import { coverageInstallationSchema, dataReleaseSchema, type DataRelease, type CoverageInstallation } from '@/lib/contracts/releases';
import { Store, alive, DownloadError } from './store';
export const coverageRoot = () => resolve(/* turbopackIgnore: true */ process.env.ALPINE_COVERAGE_ROOT ?? '.local-data/coverage');
export async function atomicJson(file: string, value: unknown) {
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value));
    await rename(temp, file);
}
export async function readJson(file: string): Promise<unknown> {
    return JSON.parse(await readFile(file, 'utf8'));
}
export async function loadInstallation(root = coverageRoot(), id?: string) {
    if (!id) {
        try {
            const pointer = await readJson(join(root, 'current.json')) as {
                installationId: string | null;
            };
            id = pointer.installationId ?? undefined;
            if (!id)
                return null;
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT')
                return null;
            throw e;
        }
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id))
        throw new Error('Invalid installation identity');
    const installation = coverageInstallationSchema.parse(await readJson(join(root, 'installations', `${id}.json`)));
    const release = dataReleaseSchema.parse(await readJson(join(root, 'releases', `${installation.releaseId}.json`)));
    if (installation.id !== id || release.id !== installation.releaseId)
        throw new Error('Installation identity mismatch');
    const artifacts = installation.artifactIds.map(id => {
        const artifact = release.artifacts.find(a => a.id === id);
        if (!artifact)
            throw new Error('Missing artifact reference');
        return { path: join(root, 'artifacts', `${id}.sqlite`), geometry: artifact.geometry };
    });
    for (const artifact of artifacts)
        await stat(artifact.path);
    return { installation, release, artifacts };
}
export function selection(release: DataRelease, ids: string[]) {
    const sectionIds = [...new Set(ids)].sort();
    const sections = sectionIds.map(id => {
        const s = release.sections.find(s => s.id === id);
        if (!s)
            throw new DownloadError(400, `Unknown section ${id}`);
        return s;
    });
    if (!sections.length)
        throw new DownloadError(400, 'Choose at least one section');
    const coordinates = sections.map(s => (s.geometry.type === 'Polygon' ? [s.geometry.coordinates] : s.geometry.coordinates) as Parameters<typeof polygonClipping.union>[0]);
    const geometry = { type: 'MultiPolygon' as const, coordinates: polygonClipping.union(coordinates[0]!, ...coordinates.slice(1)) };
    return { sectionIds, artifactIds: [...new Set(sections.flatMap(s => s.artifactIds))].sort(), geometry };
}
const turns = new Map<string, Promise<void>>();
export async function withPublicationLock<T>(root: string, fn: (store: Store) => Promise<T> | T): Promise<T> {
    const previous = turns.get(root) ?? Promise.resolve();
    let done!: () => void;
    const current = new Promise<void>(r => {
        done = r;
    });
    const tail = previous.then(() => current);
    turns.set(root, tail);
    await previous;
    const store = new Store(root);
    try {
        store.db.exec('BEGIN IMMEDIATE');
        try {
            const result = await fn(store);
            store.db.exec('COMMIT');
            return result;
        }
        catch (e) {
            store.db.exec('ROLLBACK');
            throw e;
        }
    }
    finally {
        store.close();
        done();
        if (turns.get(root) === tail)
            turns.delete(root);
    }
}
export async function withInstallationPins<T>(ids: readonly string[], fn: () => Promise<T>, root = coverageRoot()): Promise<T> {
    const token = randomUUID();
    await withPublicationLock(root, async (store) => {
        for (const id of new Set(ids)) {
            if (!await loadInstallation(root, id))
                throw new Error('Missing installation');
            store.db.prepare('INSERT INTO pins VALUES(?,?,?)').run(token, process.pid, id);
        }
    });
    try {
        return await fn();
    }
    finally {
        await withPublicationLock(root, store => {
            store.db.prepare('DELETE FROM pins WHERE token=?').run(token);
        });
    }
}
export function assertMigrationReady(database = resolve(process.env.ALPINE_ROUTE_JOBS_DB ?? '.local-data/runtime/route-jobs.sqlite')) {
    if (!existsSync(database))
        return;
    const db = new DatabaseSync(database, { readOnly: true });
    try {
        for (const row of db.prepare("SELECT plan_json FROM route_jobs WHERE status IN ('queued','running','resolving-drive-time')").iterate()) {
            const plan = JSON.parse(String(row.plan_json)) as {
                installationId?: string;
            };
            if (!plan.installationId)
                throw new DownloadError(409, 'Finish or cancel legacy searches before installing prepared coverage');
        }
    }
    finally {
        db.close();
    }
}
export async function activate(root: string, release: DataRelease, ids: string[]): Promise<CoverageInstallation> {
    assertMigrationReady();
    const selected = selection(release, ids);
    const id = createHash('sha256').update(JSON.stringify({ releaseId: release.id, sectionIds: selected.sectionIds, artifactIds: selected.artifactIds })).digest('hex');
    const installation: CoverageInstallation = { id, releaseId: release.id, createdAt: new Date().toISOString(), ...selected };
    await mkdir(join(root, 'releases'), { recursive: true });
    await mkdir(join(root, 'installations'), { recursive: true });
    const releasePath = join(root, 'releases', `${release.id}.json`);
    if (existsSync(releasePath)) {
        if (JSON.stringify(await readJson(releasePath)) !== JSON.stringify(release))
            throw new Error('Release identity has conflicting content');
    }
    else
        await atomicJson(releasePath, release);
    const target = join(root, 'installations', `${id}.json`);
    if (existsSync(target)) {
        const existing = coverageInstallationSchema.parse(await readJson(target));
        await atomicJson(join(root, 'current.json'), { installationId: id });
        return existing;
    }
    await atomicJson(target, installation);
    await atomicJson(join(root, 'current.json'), { installationId: id });
    return installation;
}
/** Unknown saved reference history prevents cleanup. Never touches legacy data. */
export async function cleanupInstallations(root = coverageRoot(), retainedIds?: readonly string[]) {
    if (!retainedIds)
        return [];
    return withPublicationLock(root, async (store) => {
        const keep = new Set(retainedIds);
        const current = await loadInstallation(root);
        if (current)
            keep.add(current.installation.id);
        for (const row of store.db.prepare('SELECT * FROM pins').all())
            if (alive(Number(row.pid)))
                keep.add(String(row.installation));
        // Queued and interrupted downloads can reuse these verified artifacts.
        const artifacts = new Set<string>();
        for (const job of store.list().filter(job => job.status !== 'completed'))
            for (const id of selection(store.inputs(job.id).release, job.sectionIds).artifactIds)
                artifacts.add(id);
        const deleted: string[] = [];
        for (const file of await readdir(join(root, 'installations')).catch(() => [])) {
            if (!file.endsWith('.json'))
                continue;
            const installed = await loadInstallation(root, file.slice(0, -5));
            if (!installed)
                continue;
            if (keep.has(installed.installation.id))
                for (const id of installed.installation.artifactIds)
                    artifacts.add(id);
            else {
                await rm(join(root, 'installations', file));
                deleted.push(installed.installation.id);
            }
        }
        for (const file of await readdir(join(root, 'artifacts')).catch(() => []))
            if (file.endsWith('.sqlite') && !artifacts.has(file.slice(0, -7)))
                await rm(join(root, 'artifacts', file));
        return deleted;
    });
}
