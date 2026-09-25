import { z } from 'zod';
import { downloadActionSchema, downloadRequestSchema } from '@/lib/contracts/releases';
import { DownloadError } from './store';
import { DownloadService } from './service';
async function body(request: Request) {
    if (!request.body)
        throw new DownloadError(400, 'Missing JSON body');
    const reader = request.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            size += value.byteLength;
            if (size > 100000) {
                await reader.cancel();
                throw new DownloadError(413, 'Request too large');
            }
            parts.push(value);
        }
        return JSON.parse(Buffer.concat(parts).toString());
    }
    catch (e) {
        if (e instanceof DownloadError)
            throw e;
        throw new DownloadError(400, 'Invalid JSON body');
    }
    finally {
        reader.releaseLock();
    }
}
function local(request: Request) {
    const url = new URL(request.url);
    const target = request.headers.get('host') ? new URL(`${url.protocol}//${request.headers.get('host')}`) : url;
    const origin = request.headers.get('origin');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || target.username || target.password || (origin && origin !== target.origin) || request.headers.get('sec-fetch-site') === 'cross-site')
        throw new DownloadError(403, 'Coverage changes require a same-origin local request');
}
export async function handleDownload(request: Request, operation: 'catalog' | 'plan' | 'jobs' | 'job' | 'action', id?: string, action?: string) {
    let service: DownloadService | undefined;
    try {
        service = new DownloadService();
        if (request.method !== 'GET')
            local(request);
        if (operation === 'catalog')
            return Response.json(request.method === 'DELETE' ? await service.remove(z.object({ sectionIds: z.array(z.string()).min(1) }).strict().parse(await body(request)).sectionIds) : await service.catalog());
        if (operation === 'plan')
            return Response.json(await service.plan(downloadRequestSchema.parse(await body(request))));
        if (operation === 'jobs')
            return Response.json(request.method === 'GET' ? service.store.list() : await service.create(downloadRequestSchema.parse(await body(request))), { status: request.method === 'GET' ? 200 : 202 });
        if (operation === 'job')
            return Response.json(service.get(id!));
        return Response.json(service.action(id!, downloadActionSchema.parse(action)));
    }
    catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: e instanceof DownloadError ? e.status : e instanceof z.ZodError ? 400 : 500 });
    }
    finally {
        service?.close();
    }
}
