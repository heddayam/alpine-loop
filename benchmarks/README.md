# Frozen real-data checks

`queries.json` fixes 24 requests across Snoqualmie, Central Cascades and Mount
Rainier. Distances and elevation gains are meters; repetition counts extra
physical-trail traversal divided by total route distance. Its SHA-256 remains
`bc41b5ee66c8c1ee3e08cb38f57907e0e3a408e2dcb0e6151bbc55ec8d7652f4`.
Do not change these requests to make an implementation pass.

After building the app and preparing mountain sections:

```sh
node benchmarks/app/run.mjs --dataset .local-data/mountains --output /tmp/alpine-app-results.json --observation-ms 30000
```

Use `--query north-bend-known` for one request. Each runs through a fresh HTTP
server and actual search worker. The observation window and RSS guard belong
to the harness; they do not relax constraints or impose app timeouts. Reports
include effective queries, progressive results, completion/unfinished status,
reconnect, Stop latency, memory, and input/code hashes. A failure or stopped
search never proves no matches. Memory excludes the browser; timing is descriptive.

`mountain-preparation-review.json` records the replacement footprint, partitions,
real compilation and runtime observations. A source-size proxy is a conservative
capacity policy, not a guarantee about search duration or arbitrary future data.

The complete Cascades review retains all seven qualifying known walks with
identical sampled 3D profiles and original starts. All 24 HTTP observations
preserve their requests and reconnect without failures: five complete within
the ten-second measurement window, nineteen unfinished. Peak server/worker RSS
is 441 MB; largest-section exploration with route/GPX inspection reaches 701 MB.
Worst observed Stop latency is 14.1 ms. Preparation is measured separately at
1.65 GB compiler RSS. These are observations, not future source guarantees.
Full reports and the one-off measurement/checker artifacts are retained locally
under `.local-data/mountains/audit/review/`; hashes are in the committed review.

The independent `verifyWitness` function in `source-witnesses.mjs` checks directed
continuity, access, a simple cycle with an optional identical return stem,
distance/gain, and repeated physical trail. It imports no production solver.

Historical source reports and retired exporters, tile compilers, replay scripts,
and snapshot-specific runners are preserved at
`archive/before-mountain-preparation-2026-10-05`. The frozen witnesses remain in
this checkout, but their numeric trail IDs describe the explicitly pinned older
source snapshot, rather than new mountain sections. A hike excluded by an applied hard highway boundary
must be reported separately from a constraint failure or solver miss.
