# Trail-segment condition inspection

## Product decision

Generated routes expose an ordered list of meaningful trail segments. The list
and the selected route on the map are synchronized: hovering or focusing a list
row emphasizes that geometry on the map, while hovering that part of the map
emphasizes and scrolls its matching row into view. Clicking either surface keeps
the segment selected.

This is an inspection aid, not a route filter and not a maintenance verdict.
Missing OpenStreetMap tags mean unknown. Segment condition data never silently
removes, promotes, or demotes a generated route. Exact and close matches remain
separate.

## Segment boundary

A route segment is a consecutive run of reconstructed directed edges with the
same display identity, access state, and condition observations.

- A named trail remains one segment across harmless OSM way splits while its
  condition observations stay the same.
- An unnamed trail uses its OSM source feature as its identity when the pack
  carries one.
- A name, access, or condition change starts a new segment.
- Re-entering the same trail later in a route creates a new ordered occurrence;
  non-consecutive geometry is never joined.
- Existing packs without source-feature flags fall back to deterministic
  contiguous grouping, so saved jobs remain readable.

Segment IDs are route-scoped and ordered. Each segment includes its own
LineString geometry, route-distance interval, length, name or explicit unnamed
state, access state, source IDs, optional OSM source feature, and raw mapped
observations.

## OSM observations and limitations

The pack adapter preserves these values without turning them into an inferred
score:

| Field | What it can say | What it cannot say |
| --- | --- | --- |
| `surface=*` | Mapped material or structure | Current upkeep or passability |
| `trail_visibility=*` | How easy the path is to follow and the orientation skill required | Maintenance responsibility or freshness |
| `sac_scale=*` | Mapped hiking difficulty | Current trail condition |
| `smoothness=*` | Surface regularity for wheeled travel | Hiking difficulty or maintenance quality |
| `informal=*` | Whether the way is mapped as informal | Whether access is legal or the trail is currently usable |
| `disused=yes` / `abandoned=yes` | Explicit lifecycle observations on a retained hiking way | A current closure unless access evidence also says so |

OpenStreetMap documents `trail_visibility` as a wayfinding classification,
[`surface`](https://wiki.openstreetmap.org/wiki/Key%3Asurface) as physical
material/structure, and [`smoothness`](https://wiki.openstreetmap.org/wiki/Key%3Asmoothness)
primarily as wheeled-vehicle usability. These observations remain in the route
data for later condition work, but the compact inspector does not display them.

## Interaction and visual language

- The ordered segment list sits inside the expanded selected result card, below
  the elevation profile and trailhead coordinates.
- The card heading is the trailhead followed by the longest named segment. It
  no longer lists every trail name or repeats “same trailhead” in Route details.
- Each row shows only its order, trail name, distance, and condition-search
  icon. It uses the existing compact type scale, neutral surfaces, rounded
  border, and map-synchronized hover/selection colors.
- Map emphasis keeps the selected route orange and increases only the active
  segment's line weight over a white casing; hover is green and selection is
  orange, matching the list.
- Every row is a real button with keyboard focus and `aria-pressed`; the map is
  an additional pointer interaction, not the only way to inspect segments.

## Close-match result cards

`nearMisses` remains the internal response field and `near-miss` remains the
stored job discriminator for compatibility. User-facing copy says **Close
matches**. A close-match card does not allocate a separate constraint-warning
block; each visible metric that violates the request uses the existing orange
warning color. This applies to distance, elevation gain, grade experience,
maximum elevation, repeated trail, and shared approach.

## Deferred maintainability discovery

Each segment now exposes a safely encoded Google condition search in a new tab.
Named segments search for `<trail name> conditions`; unnamed segments use the
segment's first coordinate as a deterministic fallback. The link is an adjacent
control rather than nested inside the segment-selection button, and hovering or
focusing it preserves the same map/list emphasis.

The following issue #2 work remains deferred to a later stage:

- stable human-readable search terms for unnamed segments using nearby named
  trails, parks, junctions, and coordinates;
- external evidence freshness, ranking, review, and uncertainty policy;
- any optional warnings or filters based on that evidence.

That stage must preserve the same rule: externally discovered evidence is
attributed and dated, inference is labeled, and no route is silently removed.
