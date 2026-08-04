# Trail search API contract

T9 serves the accepted static regional corpus without contacting trail-data providers during a
request. Search responses contain metadata only; selected display geometry is loaded separately.

## Search reachable trails

`POST /api/trails/search`

```json
{
  "regionId": "yosemite-stanislaus",
  "driveTimePolygon": {
    "type": "Polygon",
    "coordinates": [[[-120, 37.5], [-119.3, 37.5], [-119.3, 38.2], [-120, 38.2], [-120, 37.5]]]
  },
  "query": "falls",
  "limit": 100
}
```

`driveTimePolygon` accepts a GeoJSON Polygon, MultiPolygon, Feature, or FeatureCollection. The
existing reachability payload may also be passed as `geoJson`. `query` and `limit` are optional;
the maximum limit is 500. Requests are capped at 8 MiB and normalized drive-time geometry is
capped at 200,000 vertices. Reachability is computed once for each regional access point, keeping
request cost bounded while accommodating detailed four- and five-hour provider contours.

The response has this shape:

```ts
{
  schemaVersion: 1;
  artifactVersion: string;
  region: { id: string; label: string; bounds: [number, number, number, number] };
  count: number;
  trails: Array<{
    id: string;
    name: string;
    manager?: string;
    bounds: [number, number, number, number];
    lengthMeters?: number;
    dataConfidence: "high" | "medium" | "low";
    hiking: "allowed" | "unknown";
    access: "public" | "unknown";
    status: "open" | "seasonal" | "unknown";
    surfaces?: string[];
    elevation?: { minMeters: number; maxMeters: number };
    notices: string[];
    accessPointCount: number;
    accessPoints: Array<{
      id: string;
      name?: string;
      type: "trailhead" | "entrance" | "parking" | "derived";
      confidence: "official" | "mapped" | "derived";
      longitude: number;
      latitude: number;
      sourceRefs: SourceRef[];
    }>;
    sourceRefs: SourceRef[];
    geometryUrl: string;
  }>;
}
```

`count` is the total after access, policy, and optional text filtering but before `limit`.
`accessPointCount` is the number of geographically distinct reachable access points before
representative limiting. `accessPoints` retains its v1-compatible shape but contains at most two
representatives, selected deterministically by conservative evidence rank (`official`, then
`mapped`, then `derived`). Returned access metadata is only for points inside the active drive-time
polygon. A trail line crossing the polygon without a connected access point inside it is never
returned.

Unknown hiking permission remains searchable with an explicit notice. Blocked, private, closed,
advanced climbing/scramble, and Gate C-suppressed catalog entries are omitted. Derived access points
retain `confidence: "derived"` and are never promoted to mapped or official.

## Load selected trail geometry

`GET /api/trails/:regionId/:trailId/geometry`

The endpoint returns a GeoJSON FeatureCollection for a user-facing search result and reads only the
segment shards needed by that trail. Each feature contains display geometry and canonical segment
metadata. Raw per-edge `maxGradePct` is deliberately omitted under the Gate C elevation exception.
The collection-level `properties.accessPoints` contains the selected trail's complete access detail,
including original confidence, source references, and connected canonical graph-node IDs;
`properties.accessPointCount` reports the geographically distinct product count. This detail is lazy
and is not included in ordinary list/search responses. The response has an ETag and a one-hour
public cache lifetime.
