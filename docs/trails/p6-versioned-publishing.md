# P6 versioned trail publishing and runtime delivery

Status: integrated local implementation; deployed private-binding smoke pending

## Publication contract

`scripts/trails/versioned-publisher.mjs` is an explicit, non-request-path
publisher. It takes a complete artifact-contract-v2 directory, its derived
`search-index.json`, an injectable private-object-storage adapter, and an
activation reviewer/timestamp. It performs these steps in order:

1. Run the complete P4 offline validator over every manifest-declared local
   object.
2. Require QA `pass` or `pass-with-exceptions` and an accepted review with a
   reviewer identity.
3. Check that the runtime search index names the same region, manifest hash,
   named-trail hash, segment-index hash, trail-geometry-index hash, and
   partition width.
4. Stream each artifact to its immutable
   `trails/<region>/<build-id>/<path>` key. An existing key is not overwritten.
5. Read every remote object back and verify its body byte count, SHA-256,
   SHA-256 custom metadata, content type, cache policy, and identity encoding.
   Metadata comparison alone is not considered upload verification.
6. Upload the accepted manifest and search index below the same immutable build
   prefix.
7. Write `trails/<region>/current.json` last.

An interrupted upload leaves no new pointer. Retrying skips immutable objects
only after they pass the same full verification, then resumes the remaining
objects. Publishing an already active, byte-identical build does not rewrite
the pointer. A conflicting object below an existing build ID fails closed.

The provided R2 adapter uses conditional immutable puts. `current.json` is the
only mutable object, and every activation or rollback uses the ETag read with
the prior pointer as a compare-and-swap precondition. A concurrent pointer
change rejects the stale operation instead of overwriting lineage. No
credentials, physical bucket identifiers, public bucket URLs, or object-list
operations are part of the contract.

## Additive artifact-contract-v2 delivery revision

Two-hex segment partitions remain the canonical graph/routing representation,
but they are not an acceptable selected-trail display layout: cached regional
trails touch up to 256 partitions, which would exceed a Worker's connection,
memory, and transfer budget. V2 therefore adds:

- required runtime `trail-geometry/index.json`;
- one required immutable runtime object at
  `trail-geometry/<two trail-ID hex characters>/<named-trail-id>.ndjson` for
  each named trail;
- exact index-to-named-trail and index-to-manifest coverage;
- canonical records in the exact `segmentIds` order, byte-value equivalent to
  the corresponding canonical segment records; and
- `trailGeometryIndexSha256` in the derived search-index source contract.

Shared canonical segments may appear in more than one legitimate named-trail
object. Duplicate IDs within one named trail, missing/extra index entries,
changed record values, and out-of-order records fail validation. All new bytes
participate in manifest hashes and the stable build ID. Schema-v1 Yosemite
does not produce these files, so its historical bytes and packaged lookup are
unchanged.

Read-only cached evidence across the four pipeline regions measured 1,136
trail-local objects and about 50.85 MB total raw: Midpen 406 objects/15.85 MB
(538,479-byte maximum), East Bay 379/8.63 MB (389,830-byte maximum), Sierra
41/6.32 MB (990,740-byte maximum), and Tahoe 310/20.05 MB (858,666-byte
maximum). Every measured object is below the ordinary 8 MiB raw target.

## Pointer and rollback

The small pointer contains:

- schema and region IDs;
- an active build reference with the exact manifest and search-index byte
  counts and SHA-256 values;
- the prior accepted build reference, or `null` on first activation;
- activation time, reviewer identity, and `publish` or `rollback` reason.

Rollback fully reads and verifies the retained manifest, every declared build
object, and its search index; rechecks accepted QA/review state; then swaps the
active and prior references in one final pointer write. This makes the last
accepted build recoverable without deleting or rewriting either immutable
build.

## Runtime behavior

V2 runtime loading requests exact keys in this order:

1. `trails/<region>/current.json`
2. the pointer-declared immutable manifest
3. manifest-declared named trails
4. manifest-declared access points
5. the manifest-declared segment index
6. the manifest-declared trail-geometry index
7. the pointer-declared immutable search index
8. exactly one trail-local geometry object for a selected trail detail request

The runtime verifies pointer structure, manifest/search hashes and body sizes,
accepted QA/review state, region/build consistency, required artifact roles,
and partition width. Cold metadata hydration is sequential, so only one
serialized metadata object is buffered at a time; a 15-second, one-catalog
in-isolate cache bounds retention while allowing search and selected detail to
share the hydrated catalog. A cold load is seven exact-key reads and no list.

Selected v2 geometry performs one additional exact-key read. Its declared size
and content SHA-256 are checked over the returned bytes; object hash metadata
alone is not treated as proof of content. The ordinary raw limit is 8 MiB. A
manifest exception must exactly name the path, raw/compressed sizes, and a
nonempty reviewed note, and the runtime still refuses anything above a 16 MiB
absolute raw ceiling. The runtime never eagerly fetches QA or provenance.
Missing, truncated, mismatched, corrupt, or malformed required objects fail
closed; API routes return a no-store `503` service response.

The hydrated catalog preserves P7's complete canonical access features and
`connectedNodeIds`; search still applies its bounded representative summary,
while selected detail returns the full access evidence. Existing
Yosemite–Stanislaus schema v1 continues to resolve synchronously from packaged
`ASSETS` and does not consult the private pointer or R2 binding.

## Retention and cache policy

Object retention is pointer-safe rather than age-only:

- Never delete the build referenced by `current.json.active` or
  `current.json.previous`.
- Retain older accepted builds for at least 30 days after they stop being the
  previous build. This leaves an additional recovery window without weakening
  the two-build rollback guarantee.
- An incomplete, never-activated upload may be collected after seven days from
  its last publication attempt, but only after an offline maintenance job
  proves that no region pointer references its build ID.
- Garbage collection is a separate reviewed maintenance operation. Publisher
  retries, API requests, and ordinary runtime loading never list or delete
  bucket contents.

The runtime cache holds at most one hydrated regional catalog per isolate for
15 seconds. It never retains selected geometry, QA, provenance, or artifact
response bodies. Historical cached metadata for the four pipeline regions is
about 12 MiB at the largest serialized region before the derived search index
and JavaScript object overhead; each P8 report must record the actual v2
metadata bytes. The deployed smoke must confirm acceptable heap and latency.
If measured catalog retention is unsafe, lower the TTL or compact metadata;
do not expand the one-entry cache or the Worker memory budget.

## Sites handoff

The integration branch declares the logical binding:

```diff
-  "r2": null
+  "r2": "TRAIL_ARTIFACTS"
```

Sites owns the physical private resource and deployment wiring. A deployed
private-binding smoke test and runtime/cache measurement remain Gate F work.
No regional corpus has been uploaded or activated.
