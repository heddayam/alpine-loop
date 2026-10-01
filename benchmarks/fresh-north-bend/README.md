# North Bend source-backed slice

This is one independently justified hike carried through fresh raw-source
preparation, engine recovery, the app's retained choices, inspection and GPX.
It is a small slice proof, not validation of all Washington trails or every
possible loop. The source footprint is `[-121.9, 47.4, -121.6, 47.62]`.

The automated observation uses the **unchanged** frozen `north-bend-known`
request in `../queries.json`: starts inside `[-121.82, 47.43, -121.68, 47.54]`,
**4–10 miles, 0–3,500 feet gain, at most 30% repeated trail, uncertain access
excluded**. No query was tuned using the replacement engine's discoveries.

## Independent source evidence

`witness.json` preserves the original frozen witness, the reconstructed v1
directed edge sequence, ordered raw way/segment/node evidence, source hashes,
and source objects. The same physical hike follows Little Si, Boulder Garden,
Douglas Fir, Mount Si, Talus, Spring, Teneriffe and Roaring Creek trails before
returning along its approach. All 17 path ways have `foot=designated`.
OSM evidence is © OpenStreetMap contributors, ODbL 1.0; the USGS 3DEP elevation
source is public domain. Source URLs and hashes remain in the recorded evidence.

Corrected preparation removed redundant parking-boundary start `12761651948`.
The witness now starts at named Little Si Trailhead `4729927256`, whose public
permission is supported by the same mapped parking polygon. This explicitly
adds the existing 1.320699 m segment of way `40413381` to both ends of the walk;
the cycle and frozen query are unchanged. `source-replay.json` records the
result: **5.919875 miles, 2,230.473 feet gain, 27.629515% repeated trail**.

`replay.py` imports no engine code. It verifies the pinned raw OSM hash and
objects, checks the prescribed raw walk and simple lollipop topology, then
matches successive prefixes of that exact walk to compiled corridors. It can
accommodate changed degree-two anchors but cannot find a substitute route.
It checks preserved source coordinates, public permission, distance and
repetition against raw coordinates, gain against the compiled DEM profile,
and the original constraints. The gain check is not an independent resampling
or accuracy assessment of the USGS rasters.

The corrected graph SHA-256 is
`e35aaf73c61fe6df4c067b65d44d8eae7d4063f7649fbd2c53cca1c26c0ab373`;
geometry SHA-256 is
`1951ac1ac5d94e7a11096b77db1905319e0632e205dde94f984a60591ab1e254`.
The original and corrected directories advertised the same dataset ID, so
file hashes distinguish this evidence. Generated data and raw inputs remain
outside Git. Source preparation is described in `../../tools/prepare/README.md`.

## Recorded observations

`recovery.json` and `report.json` retain the original 2026-09-30 observations
on an Apple M3 with 16 GiB RAM and Node 24.11.0. The engine and app observations
ran as separate processes; their elapsed times must not be combined.

| Check | Observed result |
| --- | --- |
| Exact ordered source witness recovered by engine | Yes; 550 candidate emissions, all 4 eligible starts fully explored |
| App retained results for the frozen request | 17 choices; all 4 starts fully explored |
| Inspection | Matching source start and measurements; 1,049 points; closed route; profile gain agrees |
| GPX | HTTP 200; 1,049 track points |
| Current-search reconnect endpoint | Same search returned |
| Peak observed server/worker process RSS | 165,855,232 bytes, approximately 158 MiB |

The app runner observed a first retained exact choice at 53.8 ms and all starts
attempted at 74.9 ms, measured after launching the request. It sampled RSS every
20 ms, beginning before dataset loading. The measurement includes the Node
server, actual worker and runner overhead, but **not browser memory**, browser
rendering, or HTTP transport. API requests use Fastify injection. These are
single observations, not performance promises or controlled comparisons. The
30-second observation window stops and labels unfinished measurement runs; it
is not an application search cutoff. Cancellation was not exercised in the
recorded run because exploration completed.

The earlier 24-query timings in `../results/` concern retired pilot data and
earlier engine revisions. They are historical evidence, not current timings
for this fresh slice. They do not establish current long-hike completeness.

A separate manual desktop check used a **drawn rectangle around Little Si**,
with the same distance/gain/repetition/access limits. It completed **1 of 1
starts with 7 choices**, including the independently verified displayed
5.9-mile / 2,230-foot / 28% choice from named Little Si Trailhead. This narrower
area is not the frozen four-start benchmark. The browser's downloaded GPX
byte-matched the app observation's witness export, SHA-256
`6653d939fbf7b968d55562a5cb2751207ba5ca3fbe881a5f27539986986a648f`.

## Reproduce

These are explicit offline maintainer checks, not an additional automated test
suite. Use Node 24, installed app dependencies, Python 3.11+ and Osmium. Prepare
the corrected source dataset first, then run from the repository root:

```sh
npm run build
python3 benchmarks/fresh-north-bend/replay.py .local-data/rewrite/fresh-north-bend-v2 > /tmp/alpine-source-replay.json
node benchmarks/fresh-north-bend/recover.mjs .local-data/rewrite/fresh-north-bend-v2 /tmp/alpine-source-replay.json > /tmp/alpine-engine-recovery.json
node benchmarks/fresh-north-bend/run.mjs .local-data/rewrite/fresh-north-bend-v2 /tmp/alpine-source-replay.json > /tmp/alpine-app-observation.json
```

The dataset path is an argument. Raw OSM defaults to
`.cache/<sourceSnapshot.file>` from `witness.json`; pass `--raw-source FILE` to
use another local copy of that exact snapshot. The Node scripts require the
independent replay's graph hash to match their input and assert that the query
still equals its frozen original. They print new observations without replacing
the recorded files. The portable app runner also parses the exported GPX and
checks every coordinate against inspection. If engine recovery is not observed
within the measurement window, the script reports failure to observe this
witness; it does not declare that no qualifying route exists.
