import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { downloadRequestSchema, type DownloadRequest, type DownloadPlan, type DataRelease, type DownloadCatalog } from '@/lib/contracts/releases';
import { Store, DownloadError } from './store';
import { activate, cleanupInstallations, publishInstallation, coverageRoot, loadInstallation, selection, withPublicationLock } from './index';
import { downloadArtifact, DownloadStopped, loadRelease, requireDisk, verifyArtifact, verifyCompressedArtifact } from './download';
export type Options = {
    root?: string;
    routeJobsDb?: string;
    source?: string;
    fetcher?: typeof fetch;
    startWorker?: (root: string) => void;
    available?: () => Promise<number>;
};
export function startDownloadWorker(root: string) {
    const failed = (error: Error) => {
        const store = new Store(root);
        try {
            store.tx(() => {
                store.recover();
                if (store.db.prepare('SELECT 1 FROM lease').get())
                    return;
                for (const job of store.list())
                    if (job.status === 'queued') {
                        job.status = 'failed';
                        job.error = error.message;
                        store.save(job);
                    }
            });
        }
        finally {
            store.close();
        }
    };
    const child = spawn(process.execPath, ['--import', 'tsx', resolve(/* turbopackIgnore: true */ process.cwd(), 'scripts/coverage-download-worker.ts'), root], { cwd: process.cwd(), detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: process.env });
    child.once('error', failed);
    child.once('exit', (code, signal) => {
        if (code !== 0)
            failed(new Error(`Download worker exited (${signal ?? code})`));
    });
    child.once('message', message => {
        if (message === 'download-worker-ready') {
            child.disconnect();
            child.unref();
        }
    });
}
export class DownloadService {
    readonly root: string;
    readonly source: string;
    readonly store: Store;
    constructor(readonly options: Options = {}) {
        this.root = options.root ?? coverageRoot();
        this.source = options.source ?? process.env.ALPINE_COVERAGE_CATALOG ?? '';
        this.store = new Store(this.root);
        this.store.tx(() => this.store.recover());
    }
    close() {
        this.store.close();
    }
    wake() {
        (this.options.startWorker ?? startDownloadWorker)(this.root);
    }
    async release() {
        if (!this.source)
            throw new DownloadError(503, 'No prepared coverage catalog configured. Set ALPINE_COVERAGE_CATALOG to a release.json HTTPS URL or local release directory.');
        return loadRelease(this.source, this.options.fetcher);
    }
    async catalog(): Promise<DownloadCatalog> {
        this.store.tx(() => this.store.recover());
        if (this.store.list().some(job => job.status === 'queued'))
            this.wake();
        let release: DataRelease | null = null, error: string | null = null;
        try {
            release = await this.release();
        }
        catch (e) {
            error = e instanceof Error ? e.message : String(e);
        }
        const installed = await loadInstallation(this.root);
        return { release: release ?? installed?.release ?? null, installed: installed?.installation ?? null, jobs: this.store.list(), error };
    }
    async makePlan(input: DownloadRequest, release: DataRelease, checkpoint: () => void = () => {}): Promise<DownloadPlan> {
        const request = downloadRequestSchema.parse(input);
        if (request.releaseId !== release.id)
            throw new DownloadError(409, 'Catalog release changed; review the current catalog');
        const selected = selection(release, request.sectionIds);
        const installed = await loadInstallation(this.root);
        if (installed?.installation.sectionIds.some(id => !selected.sectionIds.includes(id)))
            throw new DownloadError(409, 'Installation would remove existing sections. Remove them explicitly first.');
        const artifacts = release.artifacts.filter(a => selected.artifactIds.includes(a.id));
        let reusableBytes = 0, downloadBytes = 0, additionalBytes = 0;
        for (const artifact of artifacts) {
            if (await verifyArtifact(join(this.root, 'artifacts', `${artifact.id}.sqlite`), artifact, release.id, checkpoint))
                reusableBytes += artifact.bytes;
            else {
                const retainedCompressed = await verifyCompressedArtifact(join(this.root, 'downloads', `${artifact.id}.gz`), artifact, checkpoint);
                downloadBytes += retainedCompressed ? 0 : artifact.compressedBytes;
                additionalBytes += artifact.bytes + (retainedCompressed ? 0 : artifact.compressedBytes);
            }
        }
        return { ...request, ...selected, downloadBytes, installedBytes: artifacts.reduce((n, a) => n + a.bytes, 0), additionalBytes, reusableBytes };
    }
    async plan(input: DownloadRequest) {
        return this.makePlan(input, await this.release());
    }
    async create(input: DownloadRequest) {
        const release = await this.release();
        const plan = await this.makePlan(input, release);
        await requireDisk(this.root, plan.additionalBytes, this.options.available);
        const job = await withPublicationLock(this.root, store => store.create(release, this.source, plan.sectionIds, plan.downloadBytes));
        this.wake();
        return job;
    }
    get(id: string) {
        this.store.tx(() => this.store.recover());
        return this.store.get(id);
    }
    action(id: string, action: 'pause' | 'resume' | 'cancel') {
        const job = this.store.action(id, action);
        if (action === 'resume')
            this.wake();
        return job;
    }
    async cleanup() { return cleanupInstallations(this.root, undefined, this.options.routeJobsDb); }
    async remove(sectionIds: string[]) {
        const removed = await withPublicationLock(this.root, async (store) => {
            if (store.list().some(j => ['queued', 'running', 'pausing'].includes(j.status)))
                throw new DownloadError(409, 'Pause active downloads before removing sections');
            const installed = await loadInstallation(this.root);
            if (!installed)
                return null;
            if (sectionIds.some(id => !installed.installation.sectionIds.includes(id)))
                throw new DownloadError(400, 'Cannot remove an uninstalled section');
            const keep = installed.installation.sectionIds.filter(id => !sectionIds.includes(id));
            if (!keep.length) {
                publishInstallation(this.root, null);
                return null;
            }
            return activate(this.root, installed.release, keep);
        });
        await this.cleanup();
        return removed;
    }
}
export async function runDownloadWorker(options: Options = {}) {
    const service = new DownloadService({ ...options, startWorker: () => {
        } });
    const store = service.store;
    const token = randomUUID();
    if (!store.acquire(token)) {
        service.close();
        return;
    }
    try {
        while (true) {
            const job = store.tx(() => {
                const next = store.list().reverse().find(j => j.status === 'queued');
                if (next) {
                    next.status = 'running';
                    next.stage = 'Downloading prepared trails';
                    store.save(next);
                }
                return next;
            });
            if (!job)
                break;
            const { release, source } = store.inputs(job.id);
            let done = 0;
            const checkpoint = () => {
                const current = store.get(job.id);
                if (current.status === 'pausing' || current.status === 'cancelled')
                    throw new DownloadStopped();
            };
            try {
                const plan = await service.makePlan({ releaseId: release.id, sectionIds: job.sectionIds }, release, checkpoint);
                await requireDisk(service.root, plan.additionalBytes, options.available);
                for (const artifact of release.artifacts.filter(a => plan.artifactIds.includes(a.id))) {
                    checkpoint();
                    await downloadArtifact({
                        root: service.root, source, releaseId: release.id, artifact, checkpoint, fetcher: options.fetcher, available: options.available, progress(bytes) {
                            store.progress(job.id, done + bytes);
                        }
                    });
                    done += artifact.compressedBytes;
                }
                await withPublicationLock(service.root, async (locked) => {
                    checkpoint();
                    const current = await loadInstallation(service.root);
                    if (current?.installation.sectionIds.some(id => !job.sectionIds.includes(id)))
                        throw new DownloadError(409, 'Installed sections changed while downloading; review selection');
                    await activate(service.root, release, job.sectionIds, installation => locked.tx(() => {
                        const latest = locked.get(job.id);
                        if (latest.status === 'pausing' || latest.status === 'cancelled') throw new DownloadStopped();
                        publishInstallation(service.root, installation);
                        latest.status = 'completed'; latest.stage = 'Completed'; latest.installation = installation;
                        latest.downloadedBytes = latest.totalBytes; locked.save(latest);
                    }));
                });
                await service.cleanup();
            }
            catch (error) {
                store.tx(() => {
                    const current = store.get(job.id);
                    if (current.status === 'completed') return;
                    current.status = current.stage === 'Cancelling' ? 'cancelled' : error instanceof DownloadStopped ? 'paused' : 'failed';
                    current.stage = current.status;
                    current.error = current.status === 'failed' ? (error instanceof Error ? error.message : String(error)) : null;
                    store.save(current);
                });
            }
        }
    }
    finally {
        store.release(token);
        const pending = store.list().some(j => j.status === 'queued');
        service.close();
        if (pending)
            (options.startWorker ?? startDownloadWorker)(options.root ?? coverageRoot());
    }
}
