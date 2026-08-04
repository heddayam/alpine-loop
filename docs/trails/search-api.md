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
the maximum limit is 500.

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

`count` is the total after access, policy, and optional text filtering but before `limit`. Returned
access points are only those inside the active drive-time polygon. A trail line crossing the polygon
without a connected access point inside it is never returned.

Unknown hiking permission remains searchable with an explicit notice. Blocked, private, closed,
advanced climbing/scramble, and Gate C-suppressed catalog entries are omitted. Derived access points
retain `confidence: "derived"` and are never promoted to mapped or official.

## Load selected trail geometry

`GET /api/trails/:regionId/:trailId/geometry`

The endpoint returns a GeoJSON FeatureCollection for a user-facing search result and reads only the
segment shards needed by that trail. Each feature contains display geometry and canonical segment
metadata. Raw per-edge `maxGradePct` is deliberately omitted under the Gate C elevation exception.
The response has an ETag and a one-hour public cache lifetime.
