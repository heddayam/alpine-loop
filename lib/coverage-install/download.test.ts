import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import type { DataRelease } from '@/lib/contracts/releases';
import { DownloadService, runDownloadWorker } from './service';
import { cleanupInstallations, loadInstallation, withInstallationPins, assertMigrationReady, withPublicationLock } from './index';
import { downloadArtifact, DownloadStopped, verifyArtifact } from './download';
import { Store, currentProcessBirth } from './store';
import { createPreparedSchema } from '@/lib/data/sqlite-writer';
const paths: string[] = [];
afterEach(async () => {
    for (const path of paths.splice(0))
        await rm(path, { recursive: true, force: true });
});
const geometry: DataRelease["geometry"] = { type: 'Polygon' as const, coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
async function fixture(releaseId = 'r1', marker = '') {
    const dir = await mkdtemp(join(tmpdir(), 'coverage-download-test-'));
    paths.push(dir);
    const source = join(dir, 'source'), root = join(dir, 'installed');
    await mkdir(join(source, 'objects'), { recursive: true });
    const file = join(dir, 'tiny.sqlite');
    const db = new DatabaseSync(file);
    createPreparedSchema(db);
    db.exec(`INSERT INTO nodes VALUES('n1',1,0.5,0.5,NULL,'[]');
        INSERT INTO node_spatial VALUES(1,0.5,0.5,0.5,0.5);
        INSERT INTO access_points VALUES('a1','n1','Fixture start','trailhead','public','high',NULL,'[]',0,0,0,0,0,0,'n1','street',NULL,NULL,NULL);`);
    db.prepare('INSERT INTO metadata VALUES(?,?)').run('fixture', marker);
    db.prepare('INSERT INTO metadata VALUES(?,?)').run('schemaVersion', '7');
    db.prepare('INSERT INTO metadata VALUES(?,?)').run('releaseId', releaseId);
    db.close();
    const raw = await readFile(file), gz = gzipSync(raw), id = createHash('sha256').update(raw).digest('hex');
    const artifact = { id, path: `objects/${id}.sqlite.gz`, compressedBytes: gz.length, bytes: raw.length, geometry };
    await writeFile(join(source, artifact.path), gz);
    const release: DataRelease = {
        schemaVersion: 1, graphSchemaVersion: '7', id: releaseId, builtAt: '2026-09-24T00:00:00.000Z', compilerVersion: 'test', metricAlgorithmVersion: 'test', sources: [{
                id: 'osm', authority: 'fixture', dataset: 'fixture', version: 'test', contentHash: 'sha256:' + id, url: 'https://example.com', license: 'ODbL', retrievedAt: '2026-09-24T00:00:00.000Z'
            }], geometry, sections: [{ id: 'a', geometry, artifactIds: [id] }, { id: 'b', geometry: { type: 'Polygon', coordinates: [[[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]]] }, artifactIds: [id] }], artifacts: [artifact], regions: [], limitations: []
    };
    await writeFile(join(source, 'release.json'), JSON.stringify(release));
    return { root, source, release, artifact, options: { root, source, startWorker: () => {
            } } };
}
async function install(f: Awaited<ReturnType<typeof fixture>>, sections = ['a']) {
    const service = new DownloadService(f.options);
    try {
        const job = await service.create({ releaseId: f.release.id, sectionIds: sections });
        await runDownloadWorker(f.options);
        return service.get(job.id);
    }
    finally {
        service.close();
    }
}
describe('prepared coverage installation', () => {
    it('downloads and atomically activates exact section union, then reuses verified bytes', async () => {
        const f = await fixture();
        expect((await install(f)).status).toBe('completed');
        const old = await loadInstallation(f.root);
        expect(old?.installation.sectionIds).toEqual(['a']);
        const service = new DownloadService(f.options);
        try {
            const plan = await service.plan({ releaseId: 'r1', sectionIds: ['a', 'b'] });
            expect(plan.downloadBytes).toBe(0);
            expect(plan.reusableBytes).toBe(f.artifact.bytes);
            expect((await install(f, ['b', 'a'])).status).toBe('completed');
            expect((await loadInstallation(f.root))?.installation.sectionIds).toEqual(['a', 'b']);
            await expect(service.plan({ releaseId: 'r1', sectionIds: ['b'] })).rejects.toThrow('Remove them explicitly');
        }
        finally {
            service.close();
        }
    });
    it('counts only transferred bytes when expanding past a cached artifact', async () => {
        const f = await fixture(), second = await fixture('r1', 'second');
        f.release.artifacts.push(second.artifact);
        f.release.sections[1]!.artifactIds = [second.artifact.id];
        await writeFile(join(f.source, 'release.json'), JSON.stringify(f.release));
        await install(f);
        const compressed = await readFile(join(second.source, second.artifact.path));
        const half = Math.floor(compressed.length / 2);
        let jobId = '', observed = 0;
        const options = { ...f.options, source: 'https://example.com/release.json', fetcher: (async (url) => {
            if (String(url).endsWith('release.json')) return new Response(JSON.stringify(f.release));
            let part = 0;
            return new Response(new ReadableStream({ async pull(controller) {
                if (part++ === 0) { controller.enqueue(compressed.subarray(0, half)); return; }
                const deadline = Date.now() + 3000;
                while (service.get(jobId).downloadedBytes === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
                observed = service.get(jobId).downloadedBytes;
                controller.enqueue(compressed.subarray(half)); controller.close();
            } }));
        }) as typeof fetch };
        const service = new DownloadService(options);
        try {
            const job = await service.create({ releaseId: 'r1', sectionIds: ['a', 'b'] }); jobId = job.id;
            expect(job.totalBytes).toBe(compressed.length);
            await runDownloadWorker(options);
            expect(observed).toBe(half);
            expect(service.get(job.id)).toMatchObject({ status: 'completed', totalBytes: compressed.length, downloadedBytes: compressed.length });
        } finally { service.close(); }
    });
    it('preserves active data on corrupted update and insufficient disk', async () => {
        const f = await fixture();
        await install(f);
        const old = (await loadInstallation(f.root))!.installation.id;
        const changed = await fixture('r2');
        const service = new DownloadService({ ...f.options, source: changed.source, available: async () => 0 });
        try {
            await expect(service.create({ releaseId: 'r2', sectionIds: ['a'] })).rejects.toThrow('Insufficient disk');
        }
        finally {
            service.close();
        }
        await writeFile(join(changed.source, changed.artifact.path), Buffer.alloc(changed.artifact.compressedBytes));
        const broken = new DownloadService({ ...f.options, source: changed.source });
        try {
            const job = await broken.create({ releaseId: 'r2', sectionIds: ['a'] });
            await runDownloadWorker({ ...f.options, source: changed.source });
            expect(broken.get(job.id).status).toBe('failed');
            expect((await loadInstallation(f.root))!.installation.id).toBe(old);
        }
        finally {
            broken.close();
        }
    });
    it('pauses interruptions, enforces a single writer, and resumes cancelled work', async () => {
        const f = await fixture();
        const service = new DownloadService(f.options);
        try {
            const job = await service.create({ releaseId: 'r1', sectionIds: ['a'] });
            expect(service.store.acquire('first')).toBe(true);
            expect(service.store.acquire('second')).toBe(false);
            const running = service.get(job.id);
            running.status = 'running';
            service.store.save(running);
            service.store.db.exec('UPDATE lease SET pid=99999999');
            service.store.tx(() => service.store.recover());
            expect(service.get(job.id).status).toBe('paused');
            expect(service.action(job.id, 'cancel').status).toBe('cancelled');
            expect(service.action(job.id, 'resume').status).toBe('queued');
            await runDownloadWorker(f.options);
            expect(service.get(job.id).status).toBe('completed');
        }
        finally {
            service.close();
        }
    });
    it('removes references atomically and protects active readers during explicit cleanup', async () => {
        const f = await fixture();
        await install(f);
        const first = (await loadInstallation(f.root))!.installation.id;
        await install(f, ['a', 'b']);
        const service = new DownloadService(f.options);
        try {
            await withInstallationPins([first], async () => {
                expect(await cleanupInstallations(f.root, [])).toEqual([]);
            }, f.root);
            expect(await cleanupInstallations(f.root, [])).toEqual([first]);
            const removed = await service.remove(['a']);
            expect(removed?.sectionIds).toEqual(['b']);
            await service.remove(['b']);
            expect(await loadInstallation(f.root)).toBeNull();
            expect((await stat(join(f.root, 'artifacts', `${f.artifact.id}.sqlite`))).size).toBe(f.artifact.bytes);
        }
        finally {
            service.close();
        }
    });
    it('retains completed compressed downloads through pause and validates them on resume', async () => {
        const f = await fixture();
        let checkpoints = 0;
        await expect(downloadArtifact({ ...f, releaseId: 'r1', checkpoint() {
                if (++checkpoints === 3)
                    throw new DownloadStopped();
            }, progress() {
            } })).rejects.toBeInstanceOf(DownloadStopped);
        await downloadArtifact({ ...f, releaseId: 'r1', checkpoint() {
            }, progress() {
            } });
        expect((await stat(join(f.root, 'artifacts', `${f.artifact.id}.sqlite`))).size).toBe(f.artifact.bytes);
    });
    it('uses only configured HTTPS release paths and safely restarts partial transfers', async () => {
        const f = await fixture();
        await mkdir(join(f.root, 'downloads'), { recursive: true });
        await writeFile(join(f.root, 'downloads', `${f.artifact.id}.gz.partial`), 'truncated');
        const urls: string[] = [];
        const fetcher: typeof fetch = async (input) => {
            urls.push(String(input));
            return new Response(await readFile(join(f.source, f.artifact.path)), { status: 200 });
        };
        await downloadArtifact({ ...f, source: 'https://example.com/releases/release.json', releaseId: 'r1', checkpoint() {
            }, progress() {
            }, fetcher });
        expect(urls).toEqual([`https://example.com/releases/${f.artifact.path}`]);
    });
    it('does not clean installations when saved-reference history is unknown', async () => {
        const f = await fixture();
        await install(f);
        await install(f, ['a', 'b']);
        expect(await cleanupInstallations(f.root)).toEqual([]);
        const store = new Store(f.root);
        store.close();
    });
    it('rejects checksummed graphs with missing schema7 hints or wrong release metadata', async () => {
        const f = await fixture();
        const file = join(f.source, '..', 'tiny.sqlite');
        await expect(verifyArtifact(file, f.artifact, 'wrong-release')).rejects.toThrow('identity mismatch');
        const db = new DatabaseSync(file);
        db.exec('ALTER TABLE access_points DROP COLUMN known_minimum_stem_m');
        db.close();
        const bytes = await readFile(file);
        await expect(verifyArtifact(file, { ...f.artifact, id: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }, 'r1')).rejects.toThrow('lacks known_minimum_stem_m');
    });
    it.each(['edges', 'node_spatial'])('rejects a checksummed artifact missing required %s before activation', async (table) => {
        const f = await fixture();
        const file = join(f.source, '..', 'tiny.sqlite');
        const db = new DatabaseSync(file);
        db.exec(`DROP TABLE ${table}`); db.close();
        const raw = await readFile(file), compressed = gzipSync(raw);
        const id = createHash('sha256').update(raw).digest('hex');
        const artifact = { ...f.artifact, id, path: `objects/${id}.sqlite.gz`, bytes: raw.length, compressedBytes: compressed.length };
        const release = { ...f.release, artifacts: [artifact], sections: f.release.sections.map(section => ({ ...section, artifactIds: [id] })) };
        await writeFile(join(f.source, artifact.path), compressed);
        await writeFile(join(f.source, 'release.json'), JSON.stringify(release));
        const job = await install(f);
        expect(job).toMatchObject({ status: 'failed', installation: null });
        expect(job.error).toContain(table);
        expect(await loadInstallation(f.root)).toBeNull();
    });
    it('blocks legacy cutover until unfinished searches are completed or cancelled', async () => {
        const f = await fixture();
        const file = join(f.source, '..', 'jobs.sqlite');
        const db = new DatabaseSync(file);
        db.exec('CREATE TABLE route_jobs(status TEXT,plan_json TEXT)');
        db.prepare('INSERT INTO route_jobs VALUES(?,?)').run('queued', JSON.stringify({ packs: [] }));
        expect(() => assertMigrationReady(file)).toThrow('legacy searches');
        db.exec("UPDATE route_jobs SET status='completed'");
        expect(() => assertMigrationReady(file)).not.toThrow();
        db.close();
    });
    it('completes in a detached worker after the requesting service closes', async () => {
        const f = await fixture();
        const service = new DownloadService({ root: f.root, source: f.source });
        const job = await service.create({ releaseId: 'r1', sectionIds: ['a'] });
        service.close();
        let status = 'queued';
        for (let i = 0; i < 100; i++) {
            await new Promise(resolve => setTimeout(resolve, 50));
            const store = new Store(f.root);
            status = store.get(job.id).status;
            store.close();
            if (['completed', 'failed'].includes(status))
                break;
        }
        expect(status).toBe('completed');
    });
    it('retains saved installations across release updates and offline removal, then reclaims after deletion', async () => {
        const old = await fixture(); await install(old, ['a', 'b']);
        const initial = (await loadInstallation(old.root))!.installation;
        const jobs = join(old.source, '..', 'saved-jobs.sqlite');
        const db = new DatabaseSync(jobs); db.exec('CREATE TABLE route_jobs(plan_json TEXT)');
        db.prepare('INSERT INTO route_jobs VALUES(?)').run(JSON.stringify({ installationId: initial.id, area: { label: 'Saved' } }));
        const update = await fixture('r2');
        const options = { ...old.options, source: update.source, routeJobsDb: jobs };
        const service = new DownloadService(options);
        try {
            await expect(service.create({releaseId:'r2',sectionIds:['a']})).rejects.toThrow('Remove them explicitly');
            const job = await service.create({releaseId:'r2',sectionIds:['a','b']});
            await runDownloadWorker(options); expect(service.get(job.id).status).toBe('completed');
            expect((await loadInstallation(old.root, initial.id))!.installation).toEqual(initial);
            const offline = new DownloadService({...options, source:'https://example.com/release.json', fetcher:async()=>{throw new Error('Offline');}});
            try {
                expect(await offline.catalog()).toMatchObject({release:{id:'r2'},error:'Offline'});
                await offline.remove(['a','b']); expect(await loadInstallation(old.root)).toBeNull();
            } finally { offline.close(); }
            expect((await loadInstallation(old.root, initial.id))!.installation).toEqual(initial);
            db.exec('DELETE FROM route_jobs'); expect(await service.cleanup()).toEqual([initial.id]);
            await expect(stat(join(old.root,'artifacts',`${old.artifact.id}.sqlite`))).rejects.toThrow();
        } finally { service.close(); db.close(); }
    });
    it('retains everything for malformed or legacy saved reference history', async () => {
        const f=await fixture(); await install(f); await install(f,['a','b']);
        const jobs=join(f.source,'..','saved-jobs.sqlite');const db=new DatabaseSync(jobs);db.exec('CREATE TABLE route_jobs(plan_json TEXT)');
        for(const payload of ['bad-json',JSON.stringify({packs:[]}),JSON.stringify({installationId:null}),JSON.stringify({installationId:'valid'})]) {
            db.exec('DELETE FROM route_jobs');db.prepare('INSERT INTO route_jobs VALUES(?)').run(payload);
            expect(await cleanupInstallations(f.root,undefined,jobs)).toEqual([]);
        } db.close();
    });
    it('does not block ordinary job mutations while publication awaits filesystem work', async () => {
        const f=await fixture();const service=new DownloadService(f.options);const job=await service.create({releaseId:'r1',sectionIds:['a']});
        await withPublicationLock(f.root,async()=>{
            await new Promise(resolve=>setImmediate(resolve));
            expect(service.action(job.id,'pause').status).toBe('paused');
        }); service.close();
    });
    it('rejects finite-domain and profile-order corruption in checksummed hint rows', async()=>{
        const f=await fixture();const file=join(f.source,'..','tiny.sqlite');const db=new DatabaseSync(file);
        for(const values of [[-1,0],[2,3],[2,null],[Infinity,0]]) {
            db.exec('PRAGMA ignore_check_constraints=ON');db.prepare('UPDATE access_points SET known_minimum_stem_m=?, inclusive_minimum_stem_m=?').run(...values);
            const bytes=await readFile(file);const artifact={...f.artifact,id:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};
            await expect(verifyArtifact(file,artifact,'r1')).rejects.toThrow('minimum-stem hints');
        } db.close();
    });

    it('retains verified cancelled artifacts and resumes them without downloading', async()=>{
        const f=await fixture();const service=new DownloadService(f.options);const job=await service.create({releaseId:'r1',sectionIds:['a']});
        await downloadArtifact({...f,releaseId:'r1',checkpoint(){},progress(){}});
        service.action(job.id,'cancel');await cleanupInstallations(f.root,[]);
        expect((await stat(join(f.root,'artifacts',`${f.artifact.id}.sqlite`))).size).toBe(f.artifact.bytes);
        await rm(join(f.source,f.artifact.path));service.action(job.id,'resume');await runDownloadWorker(f.options);
        expect(service.get(job.id)).toMatchObject({status:'completed',totalBytes:0,downloadedBytes:0});service.close();
    });

    it('preserves concurrent cancellation when another connection reports progress', async()=>{
        const f=await fixture();const service=new DownloadService(f.options);const job=await service.create({releaseId:'r1',sectionIds:['a']});
        const worker=new Store(f.root);expect(worker.acquire('worker')).toBe(true);
        const running=worker.get(job.id);running.status='running';worker.save(running);
        service.action(job.id,'cancel');worker.progress(job.id,10);
        expect(service.get(job.id)).toMatchObject({status:'pausing',stage:'Cancelling',downloadedBytes:10});
        worker.release('worker');worker.close();service.close();
    });

    it('recovers a reused writer PID after reopening without stealing a live process lease', async()=>{
        const f=await fixture();const service=new DownloadService(f.options);const job=await service.create({releaseId:'r1',sectionIds:['a']});
        expect(service.store.acquire('old')).toBe(true);
        const running=service.get(job.id);running.status='running';service.store.save(running);
        service.store.db.prepare('UPDATE lease SET birth=?').run('previous-boot-or-process');service.close();
        const reopened=new DownloadService(f.options);
        expect(reopened.get(job.id).status).toBe('paused');expect(reopened.store.acquire('new')).toBe(true);
        expect(reopened.store.acquire('competitor')).toBe(false);
        expect(reopened.store.db.prepare('SELECT birth FROM lease').get()?.birth).toBe(currentProcessBirth());
        reopened.store.release('new');reopened.close();
    });
    it('recovers reused publication PIDs and reports unknown owners without waiting forever', async()=>{
        const f=await fixture();const store=new Store(f.root);
        store.db.prepare('INSERT INTO publication_lease(id,token,pid,birth) VALUES(1,?,?,?)').run('old',process.pid,'previous-process');
        await expect(withPublicationLock(f.root,async()=>true)).resolves.toBe(true);
        store.db.prepare('INSERT INTO publication_lease(id,token,pid,birth) VALUES(1,?,?,NULL)').run('unknown',process.pid);
        await expect(withPublicationLock(f.root,async()=>true)).rejects.toThrow('Cannot verify coverage owner');
        store.db.exec('DELETE FROM publication_lease');
        store.db.prepare('INSERT INTO lease(id,token,pid,birth) VALUES(1,?,?,NULL)').run('unknown',process.pid);
        expect(()=>store.acquire('candidate')).toThrow('Cannot verify coverage owner');store.close();
    });
    it('retains unknown live pins but discards pins belonging to a reused PID', async()=>{
        const f=await fixture();await install(f);const old=(await loadInstallation(f.root))!.installation.id;await install(f,['a','b']);
        const store=new Store(f.root);
        store.db.prepare('INSERT INTO pins(token,pid,installation,birth) VALUES(?,?,?,NULL)').run('unknown',process.pid,old);
        expect(await cleanupInstallations(f.root,[])).toEqual([]);
        store.db.prepare('UPDATE pins SET birth=?').run('previous-process');
        expect(await cleanupInstallations(f.root,[])).toEqual([old]);store.close();
    });

});
