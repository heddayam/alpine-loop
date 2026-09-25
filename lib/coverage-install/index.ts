import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, rm, stat, realpath } from 'node:fs/promises';
import { existsSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import polygonClipping from 'polygon-clipping';
import { coverageInstallationSchema, dataReleaseSchema, type DataRelease, type CoverageInstallation } from '@/lib/contracts/releases';
import { searchAreaSnapshotSchema } from '@/lib/contracts/search';
import { Store, ownerAlive, currentProcessBirth, DownloadError } from './store';
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
/** The persistent lease protects publication, pin registration, and cleanup without
 * holding a SQLite write transaction over asynchronous filesystem operations. */
export async function withPublicationLock<T>(root: string, fn: (store: Store) => Promise<T> | T): Promise<T> {
    await mkdir(root, { recursive: true });
    const canonical = await realpath(root);
    const previous = turns.get(canonical) ?? Promise.resolve();
    let done!: () => void;
    const current = new Promise<void>(resolve => { done = resolve; });
    const tail = previous.then(() => current);
    turns.set(canonical, tail);
    await previous;
    const store = new Store(canonical);
    const token = randomUUID();
    let acquired = false;
    try {
        while (!acquired) {
            acquired = store.tx(() => {
                const lease = store.db.prepare('SELECT token,pid,birth FROM publication_lease WHERE id=1').get();
                if (lease && ownerAlive(lease)) return false;
                store.db.prepare('DELETE FROM publication_lease WHERE id=1').run();
                store.db.prepare('INSERT INTO publication_lease(id,token,pid,birth) VALUES(1,?,?,?)').run(token, process.pid, currentProcessBirth());
                return true;
            });
            if (!acquired) await new Promise(resolve => setTimeout(resolve, 10));
        }
        return await fn(store);
    } finally {
        if (acquired) store.db.prepare('DELETE FROM publication_lease WHERE token=?').run(token);
        store.close(); done();
        if (turns.get(canonical) === tail) turns.delete(canonical);
    }
}
export async function withInstallationPins<T>(ids: readonly string[], fn: () => Promise<T>, root = coverageRoot()): Promise<T> {
    const token = randomUUID();
    await withPublicationLock(root, async (store) => {
        for (const id of new Set(ids)) {
            if (!await loadInstallation(root, id))
                throw new Error('Missing installation');
            store.db.prepare('INSERT INTO pins(token,pid,installation,birth) VALUES(?,?,?,?)').run(token, process.pid, id, currentProcessBirth());
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
export function assertMigrationReady(database = resolve(/* turbopackIgnore: true */ process.env.ALPINE_ROUTE_JOBS_DB ?? '.local-data/runtime/route-jobs.sqlite')) {
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
export function publishInstallation(root: string, installation: CoverageInstallation | null) {
    const file = join(root, 'current.json');
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ installationId: installation?.id ?? null }));
    renameSync(temp, file);
}
export async function activate(root: string, release: DataRelease, ids: string[], publish = (installation: CoverageInstallation) => publishInstallation(root, installation)): Promise<CoverageInstallation> {
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
        publish(existing);
        return existing;
    }
    await atomicJson(target, installation);
    publish(installation);
    return installation;
}
/** A missing database or unknown plan is unknown history, never deletion authority. */
function savedInstallationReferences(database: string): Set<string> | null {
    if (!existsSync(database)) return null;
    let db: DatabaseSync | undefined;
    try {
        db = new DatabaseSync(database, { readOnly: true });
        const ids = new Set<string>();
        for (const row of db.prepare('SELECT plan_json FROM route_jobs').iterate()) {
            const value: unknown = JSON.parse(String(row.plan_json));
            if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
            const plan = value as Record<string, unknown>;
            if (!searchAreaSnapshotSchema.safeParse(plan.area).success || Object.keys(plan).some(key => !['installationId', 'area'].includes(key))) return null;
            if (typeof plan.installationId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(plan.installationId)) ids.add(plan.installationId);
            else return null; // Includes legacy plans: they cannot authorize cleanup.
        }
        return ids;
    } catch { return null; } finally { db?.close(); }
}
/** Explicit IDs are an injected authoritative history for offline callers. Production
 * reads the saved-job database inside the same lock used to register live pins. */
export async function cleanupInstallations(root = coverageRoot(), retainedIds?: readonly string[], routeJobsDb = resolve(/* turbopackIgnore: true */ process.env.ALPINE_ROUTE_JOBS_DB ?? '.local-data/runtime/route-jobs.sqlite')) {
    return withPublicationLock(root, async store => {
        const keep = retainedIds ? new Set(retainedIds) : savedInstallationReferences(routeJobsDb);
        if (!keep) return [];
        const current = await loadInstallation(root);
        if (current) keep.add(current.installation.id);
        for (const row of store.db.prepare('SELECT * FROM pins').iterate()) {
            try { if (ownerAlive(row)) keep.add(String(row.installation)); } catch { return []; }
        }
        const artifacts = new Set<string>();
        for (const row of store.db.prepare('SELECT payload,release FROM jobs').iterate()) {
            const job = JSON.parse(String(row.payload)) as {status: string; sectionIds: string[]};
            if (job.status !== 'completed') {
                for (const id of selection(dataReleaseSchema.parse(JSON.parse(String(row.release))), job.sectionIds).artifactIds) artifacts.add(id);
            }
        }
        const candidates: Array<{file: string; installation: CoverageInstallation}> = [];
        // Finish validating all references before deleting anything.
        for (const file of await readdir(join(root, 'installations')).catch(() => [])) {
            if (!file.endsWith('.json')) continue;
            let installed;
            try { installed = await loadInstallation(root, file.slice(0, -5)); } catch { return []; }
            if (!installed) continue;
            if (keep.has(installed.installation.id)) {
                for (const id of installed.installation.artifactIds) artifacts.add(id);
                keep.delete(installed.installation.id);
            } else candidates.push({file, installation: installed.installation});
        }
        if (keep.size) return []; // A missing saved or live reference is unknown history.
        const deleted: string[] = [];
        for (const candidate of candidates) {
            await rm(join(root, 'installations', candidate.file)); deleted.push(candidate.installation.id);
        }
        for (const file of await readdir(join(root, 'artifacts')).catch(() => [])) {
            if (file.endsWith('.sqlite') && !artifacts.has(file.slice(0, -7))) await rm(join(root, 'artifacts', file));
        }
        for (const file of await readdir(join(root, 'downloads')).catch(() => [])) {
            if (/^[a-f0-9]{64}\.gz$/.test(file) && !artifacts.has(file.slice(0, -3))) await rm(join(root, 'downloads', file));
        }
        return deleted;
    });
}
