import { runDownloadWorker } from '../lib/coverage-install/service';
process.send?.('download-worker-ready');
await runDownloadWorker({root:process.argv[2]});
