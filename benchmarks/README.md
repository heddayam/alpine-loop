# Frozen real-data checks

`queries.json` fixes 24 requests across Snoqualmie, Central Cascades and Mount
Rainier. Distances and elevation gains are meters; repetition counts extra
physical-trail traversal divided by total route distance. Its SHA-256 remains
`bc41b5ee66c8c1ee3e08cb38f57907e0e3a408e2dcb0e6151bbc55ec8d7652f4`.
Do not change these requests to make an implementation pass.

The [completed-jobs review](completed-jobs-review.json) records the previous
exhaustive implementation: one frozen request completed, 21 remained unfinished after
30 seconds, and two failed at the worker memory boundary. The default all-region
request remained unfinished after 15 minutes. These observations reject the
ordinary-job runtime target; they do not certify complete discovery or absence
of qualifying hikes. Private profiling identifies repeated approach enumeration
for one main circuit as a dominant cost. A disk-backed scratch experiment is
preserved separately and is not deployed as a runtime fix. The current app uses
bounded diverse discovery, one full search per job, and exact returned-route
constraints. Completion certifies finishing the planned work, not finding every
qualifying hike.

The app now searches exact prepared sections. The harness uses each frozen
rectangle only to identify sections containing at least one prepared start in
the installed dataset, then searches every eligible start in those sections.
Region selection is independent of the access filter, matching the app. The
unchanged request applies access eligibility during exploration, including for
`stevens-known`, whose original rectangle contains only uncertain starts.
Distance, gain, repetition and access constraints stay frozen. Reports retain
the complete original definition, adapted `effectiveRequest` with exact section
IDs, and the app's resolved query. The harness requires installed data and checks
prepared-start checksums; missing sections or no eligible original starts fail
clearly.

Whole-section searches expand the original start scope. Their timings, start
counts and results are **not directly comparable** to the earlier rectangular
observations. Rectangles are retained solely in these frozen benchmark inputs.

After building the app and preparing mountain sections:

```sh
node benchmarks/app/run.mjs --dataset .local-data/mountains --output /tmp/alpine-app-results.json --observation-ms 30000
```

Use `--query north-bend-known` for one frozen request or `--query all-regions`
for the default 5–12 mile, 0–4000 foot all-region request. Use an observation
window of 900000 ms to measure the ordinary-job target; shorter diagnostics
remain explicitly unfinished when they do not complete. Status polling contains
no route data, and the harness uses isolated job storage under its temporary
directory. Each runs through a fresh HTTP
server and actual search worker. The observation window and RSS guard belong
to the harness; they do not relax constraints or impose app timeouts. Reports
include frozen definitions, adapted requests, durable completion/unfinished status,
saved family/witness counts after completion, history reconnect, cancellation
latency, memory, and input/code hashes. A failure or cancelled job never proves
no matches. Memory excludes the browser; timing is descriptive.

`mountain-preparation-review.json` records the replacement footprint, partitions,
real compilation and runtime observations. A source-size proxy is a conservative
capacity policy, not a guarantee about search duration or arbitrary future data.

The historical complete Cascades review retains all seven qualifying known walks
with identical sampled 3D profiles and original starts. All 24 HTTP observations
preserve their original rectangular requests and reconnect without failures:
five complete within
the ten-second measurement window, nineteen unfinished. Peak server/worker RSS
is 441 MB; largest-section exploration with route/GPX inspection reaches 701 MB.
Worst observed Stop latency is 14.1 ms. Preparation is measured separately at
1.65 GB compiler RSS. These are observations, not future source guarantees.
These pre-section-search measurements are retained unchanged. Full reports and
the one-off measurement/checker artifacts are retained locally
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
