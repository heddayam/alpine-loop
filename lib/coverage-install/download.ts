import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, statfs, rm, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { dataReleaseSchema, type ReleaseArtifact } from '@/lib/contracts/releases';
import { DownloadError } from './store';
export async function loadRelease(source: string, fetcher: typeof fetch = fetch) {
    if (source.startsWith('https://')) {
        const response = await fetcher(source, { redirect: 'error', signal: AbortSignal.timeout(30000) });
        if (!response.ok)
            throw new Error(`Catalog HTTP ${response.status}`);
        if (!response.body)
            throw new Error('Empty catalog');
        let text = '';
        for await (const chunk of Readable.fromWeb(response.body as never)) {
            text += chunk.toString();
            if (text.length > 8000000)
                throw new Error('Catalog is too large');
        }
        return dataReleaseSchema.parse(JSON.parse(text));
    }
    if (/^[a-z]+:\/\//i.test(source))
        throw new Error('Coverage catalog must be HTTPS or a local directory');
    const { readFile } = await import('node:fs/promises');
    return dataReleaseSchema.parse(JSON.parse(await readFile(join(source, 'release.json'), 'utf8')));
}
export async function size(file: string) {
    return (await stat(file).catch(() => null))?.size ?? 0;
}
export async function verifyArtifact(file: string, artifact: ReleaseArtifact, releaseId: string, checkpoint: () => void = () => {
}): Promise<boolean> {
    if (await size(file) !== artifact.bytes)
        return false;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) {
        checkpoint();
        hash.update(chunk);
    }
    if (hash.digest('hex') !== artifact.id)
        return false;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        const metadata = new Map(db.prepare('SELECT key,value FROM metadata').all().map(r => [r.key, r.value]));
        if (metadata.get('schemaVersion') !== '7' || metadata.get('releaseId') !== releaseId)
            throw new Error('Artifact schema or release identity mismatch');
        const columns = new Set(db.prepare('PRAGMA table_info(access_points)').all().map(r => r.name));
        for (const field of ['known_minimum_stem_m', 'inclusive_minimum_stem_m'])
            if (!columns.has(field))
                throw new Error(`Artifact lacks ${field}`);
        for (const row of db.prepare('SELECT known_minimum_stem_m AS known, inclusive_minimum_stem_m AS inclusive FROM access_points').iterate()) {
            checkpoint();
            for (const value of [row.known, row.inclusive]) if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw new Error('Artifact has invalid minimum-stem hints');
            if (row.known !== null && (row.inclusive === null || Number(row.inclusive) > Number(row.known))) throw new Error('Artifact has inconsistent minimum-stem hints');
        }
        if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
            throw new Error('Artifact SQLite integrity check failed');
        return true;
    }
    finally {
        db.close();
    }
}
export async function verifyCompressedArtifact(file: string, artifact: ReleaseArtifact, checkpoint: () => void = () => {}): Promise<boolean> {
    if (await size(file) !== artifact.compressedBytes) return false;
    const hash = createHash('sha256'); let bytes = 0;
    try {
        await pipeline(createReadStream(file), createGunzip(), new Transform({
            transform(chunk, _encoding, callback) {
                try { checkpoint(); } catch (error) { callback(error as Error); return; }
                bytes += chunk.length;
                if (bytes > artifact.bytes) { callback(new Error('Artifact exceeds declared size')); return; }
                hash.update(chunk); callback();
            },
        }));
        return bytes === artifact.bytes && hash.digest('hex') === artifact.id;
    } catch (error) { if (error instanceof DownloadStopped) throw error; return false; }
}
export async function requireDisk(root: string, bytes: number, available?: () => Promise<number>) {
    const free = available ? await available() : await statfs(root).then(s => s.bavail * s.bsize);
    if (free < bytes)
        throw new DownloadError(409, `Insufficient disk space: ${bytes} additional bytes required, ${free} available`);
}
/** Partial transfers restart safely; completed compressed and raw artifacts are reused after verification. */
export async function downloadArtifact(options: {
    root: string;
    source: string;
    releaseId: string;
    artifact: ReleaseArtifact;
    checkpoint: () => void;
    progress: (bytes: number) => void;
    fetcher?: typeof fetch;
    available?: () => Promise<number>;
}) {
    const { root, source, artifact, releaseId, checkpoint, progress } = options;
    const target = join(root, 'artifacts', `${artifact.id}.sqlite`);
    await mkdir(join(root, 'artifacts'), { recursive: true });
    await mkdir(join(root, 'downloads'), { recursive: true });
    if (await verifyArtifact(target, artifact, releaseId, checkpoint))
        return;
    const compressed = join(root, 'downloads', `${artifact.id}.gz`), partial = `${compressed}.partial`, raw = `${target}.partial`;
    await rm(raw, { force: true });
    await rm(partial, { force: true });
    const retainedCompressed = await verifyCompressedArtifact(compressed, artifact, checkpoint);
    if (!retainedCompressed) await rm(compressed, { force: true });
    await requireDisk(root, artifact.bytes + (retainedCompressed ? 0 : artifact.compressedBytes), options.available);
    if (!retainedCompressed) {
        checkpoint();
        let input: Readable;
        let lastActivity = Date.now();
        const controller = new AbortController();
        const timer = setInterval(() => {
            try {
                checkpoint();
                if (Date.now() - lastActivity > 30000)
                    throw new Error('Artifact download stalled');
            }
            catch (e) {
                controller.abort(e);
            }
        }, 100);
        timer.unref();
        try {
            if (source.startsWith('https://')) {
                const response = await (options.fetcher ?? fetch)(new URL(artifact.path, source), { redirect: 'error', signal: controller.signal });
                if (response.status !== 200 || !response.body)
                    throw new Error(`Artifact HTTP ${response.status}`);
                input = Readable.fromWeb(response.body as never);
            }
            else
                input = createReadStream(join(source, artifact.path));
            let bytes = 0;
            await pipeline(input, new Transform({
                transform(chunk, _encoding, callback) {
                    try {
                        checkpoint();
                        lastActivity = Date.now();
                        bytes += chunk.length;
                        if (bytes > artifact.compressedBytes)
                            throw new Error('Compressed artifact exceeds declared size');
                        progress(bytes);
                        callback(null, chunk);
                    }
                    catch (e) {
                        callback(e as Error);
                    }
                }
            }), createWriteStream(partial), { signal: controller.signal });
            if (bytes !== artifact.compressedBytes)
                throw new Error('Compressed artifact size mismatch');
            await rename(partial, compressed);
        }
        catch (e) {
            if (controller.signal.aborted)
                throw controller.signal.reason;
            throw e;
        }
        finally {
            clearInterval(timer);
        }
    }
    let bytes = 0;
    const hash = createHash('sha256');
    try {
        await pipeline(createReadStream(compressed), createGunzip(), new Transform({
            transform(chunk, _encoding, callback) {
                try {
                    checkpoint();
                    bytes += chunk.length;
                    if (bytes > artifact.bytes)
                        throw new Error('Raw artifact exceeds declared size');
                    hash.update(chunk);
                    callback(null, chunk);
                }
                catch (e) {
                    callback(e as Error);
                }
            }
        }), createWriteStream(raw));
        if (bytes !== artifact.bytes || hash.digest('hex') !== artifact.id)
            throw new Error('Artifact checksum or size mismatch');
        if (!await verifyArtifact(raw, artifact, releaseId, checkpoint))
            throw new Error('Artifact verification failed');
        checkpoint();
        await rename(raw, target);
    }
    catch (e) {
        await rm(raw, { force: true });
        if (!(e instanceof DownloadStopped))
            await rm(compressed, { force: true });
        throw e;
    }
}
export class DownloadStopped extends Error {
}
