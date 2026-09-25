import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { downloadJobSchema, type DownloadJob, type DataRelease } from '@/lib/contracts/releases';
export class DownloadError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
    }
}
export function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
}
export class Store {
    readonly db: DatabaseSync;
    constructor(readonly root: string) {
        mkdirSync(root, { recursive: true });
        this.db = new DatabaseSync(join(root, 'downloads.sqlite'));
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=30000;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, payload TEXT NOT NULL, release TEXT NOT NULL, source TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lease(id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL, pid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS publication_lease(id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL, pid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pins(token TEXT, pid INTEGER, installation TEXT, PRIMARY KEY(token,installation));`);
    }
    close() {
        this.db.close();
    }
    tx<T>(fn: () => T): T {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const value = fn();
            this.db.exec('COMMIT');
            return value;
        }
        catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
    }
    list(): DownloadJob[] {
        return this.db.prepare('SELECT payload FROM jobs ORDER BY rowid DESC').all().map(row => downloadJobSchema.parse(JSON.parse(String(row.payload))));
    }
    get(id: string): DownloadJob {
        const row = this.db.prepare('SELECT payload FROM jobs WHERE id=?').get(id);
        if (!row)
            throw new DownloadError(404, 'Download job was not found');
        return downloadJobSchema.parse(JSON.parse(String(row.payload)));
    }
    save(job: DownloadJob) {
        job.updatedAt = new Date().toISOString();
        this.db.prepare('UPDATE jobs SET payload=? WHERE id=?').run(JSON.stringify(downloadJobSchema.parse(job)), job.id);
    }
    recover() {
        const lease = this.db.prepare('SELECT * FROM lease').get();
        if (lease && alive(Number(lease.pid)))
            return;
        this.db.exec('DELETE FROM lease');
        for (const job of this.list())
            if (['running', 'pausing'].includes(job.status)) {
                job.status = job.stage === 'Cancelling' ? 'cancelled' : 'paused';
                job.stage = 'Interrupted download paused';
                this.save(job);
            }
    }
    acquire(token: string): boolean {
        return this.tx(() => {
            this.recover();
            if (this.db.prepare('SELECT 1 FROM lease').get())
                return false;
            this.db.prepare('INSERT INTO lease VALUES(1,?,?)').run(token, process.pid);
            return true;
        });
    }
    release(token: string) {
        this.tx(() => {
            this.db.prepare('DELETE FROM lease WHERE token=?').run(token);
            this.recover();
        });
    }
    create(release: DataRelease, source: string, sectionIds: string[], totalBytes: number) {
        const now = new Date().toISOString();
        const job: DownloadJob = {
            id: randomUUID(), releaseId: release.id, sectionIds, status: 'queued', stage: 'Queued', downloadedBytes: 0, totalBytes, createdAt: now, updatedAt: now, error: null, installation: null
        };
        this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?)').run(job.id, JSON.stringify(job), JSON.stringify(release), source);
        return job;
    }
    inputs(id: string) {
        const row = this.db.prepare('SELECT release,source FROM jobs WHERE id=?').get(id)!;
        return { release: JSON.parse(String(row.release)) as DataRelease, source: String(row.source) };
    }
    action(id: string, action: 'pause' | 'resume' | 'cancel') {
        return this.tx(() => {
            this.recover();
            const job = this.get(id);
            if (action === 'resume') {
                if (!['paused', 'failed', 'cancelled'].includes(job.status))
                    throw new DownloadError(409, 'Job cannot resume');
                job.status = 'queued';
                job.stage = 'Queued';
                job.error = null;
            }
            else if (action === 'pause') {
                if (!['queued', 'running', 'pausing', 'paused'].includes(job.status))
                    throw new DownloadError(409, 'Job cannot pause');
                job.status = job.status === 'running' ? 'pausing' : job.status === 'queued' ? 'paused' : job.status;
                job.stage = 'Pausing';
            }
            else {
                if (job.status === 'completed')
                    throw new DownloadError(409, 'Completed job cannot cancel');
                job.status = ['running', 'pausing'].includes(job.status) ? 'pausing' : 'cancelled';
                job.stage = 'Cancelling';
            }
            this.save(job);
            return job;
        });
    }
}
