# Elevation resolution decision — 2026-09-28

After reviewing whether 30 m should replace 10 m everywhere, the user approved
retaining 10 m as primary and using official 30 m USGS data only for missing
primary samples. Implementation and verification are recorded in status.
A global 30 m switch would require metric/threshold acceptance, not merely
changing a download URL.

## Observed failure

`osm-way-1381017880:20` is Depot Creek Trail between
`[-121.334427,49.0005699]` and `[-121.3346143,49.0007618]`. The latter has no
10 m elevation in the owned n50w122 tile. Native raster and WarpedVRT sampling
agree. Four northern trail points lie inside the precise IBC US mask; the
failure is not proof that the trail is in Canada. The next two points lie about
12.85 m and 0.056 m south of the boundary. Their nearest valid 10 m cells are
12.05 m and 24.58 m away. A one-pixel retry does not solve the whole void.

The official USGS 1-arc-second n50w12220180202 product returns valid values at
all four points and at the earlier Chilliwack void. It is 55,903,776 bytes.
Product ID: `5df04fb8e4b02caea0f4ffaf`.
[Pinned source URL](https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1/TIFF/historical/n50w122/USGS_1_n50w122_20180202.tif).
The implemented fallback subsequently acquired and verified this one full tile
for a two-point integration check. Its SHA-256 is
`8f91194123173f0924118f7148fcaa98b18d052c07a4b9c930a5c55226e6a220`.
The original valid sample stayed exactly 837.034668 m; the missing sample became
836.936523 m. A second, network-disabled sampler returned identical values and
the resume descriptor retained the final source identity. All nine primary
product pins were preserved. The complete check took 7.867 seconds and peaked
at 536,768,512 cgroup bytes; it did not run graph preparation or publication.
The useful tile and its separate backup collection remain cached for the retry.

## Bounded comparison

Three 300 m sections of the same real Depot Creek way were sampled through the
app's existing metric functions: 25 m densification, 1 m elevation-noise rule,
and 100 m sustained-grade window. These 57 points are a sensitivity example,
not representative statewide validation or ground-truth accuracy measurements.

| Section | Maximum 100 m grade: 10 m → 30 m | Gain: 10 m → 30 m | Loss: 10 m → 30 m |
| --- | --- | --- | --- |
| Upper | 31.67% → 30.03% | 10.47 → 12.28 m | 49.70 → 50.84 m |
| Middle | 59.80% → 56.94% | 12.13 → 25.55 m | 85.35 → 91.79 m |
| Lower | 13.94% → 12.77% | 5.56 → 11.10 m | 17.61 → 27.90 m |

The 30 m input does not necessarily reduce accumulated gain with the existing
noise/sampling rules. Maximum absolute point-height differences were 7.76,
6.96 and 10.07 m. This comparison does not establish which individual estimate
is closest to the actual trail. USGS explicitly cautions that DEM accuracy varies
with terrain, source quality and land cover; its nationwide 10 m RMSE statistic
must not be presented as Cascades trail-grade accuracy.
[USGS accuracy guidance](https://www.usgs.gov/faqs/what-vertical-accuracy-3d-elevation-program-3dep-dems?items_per_page=6&page=1).

For the same n49w122 extent, cached 10 m data occupies 479,441,377 bytes;
the tested 30 m product occupies 57,752,344 bytes (8.3× smaller).
[30 m source](https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1/TIFF/historical/n49w122/USGS_1_n49w122_20250813.tif).
This reduces DEM storage/acquisition, not OSM graph work or the sample count.
North's failed run spent 289 seconds reading links/context, 22 seconds resolving
DEM and 38 seconds measuring before failure. It cannot establish total measurement
cost or an 8–9× whole-build speedup. The comparison used 3.33 MB of HTTP range
reads, 1.35 seconds and 91 MB peak RSS; scratch/processes were removed.

Both products belong to the USGS NAD83/NAVD88 datum family, avoiding a new
global DEM's datum/surface-model conversion. Product metadata must still be
validated. [USGS products and coverage](https://www.usgs.gov/3d-elevation-program/about-3dep-products-services).

A backup implementation must include actual source hashes and resolution in
provenance and metric/cache identity, use it only for missing primary samples,
and finalize artifact identity after any fallback acquisition. Never synthesize
zero elevations, silently interpolate across voids, or drop US trails to finish
a build. An all-30 m implementation should instead replace the active source
policy and revalidate gain/grade behavior before acceptance.

The implemented cache conservatively includes available backup pins for each
owned tile. Acquiring a new backup can cause one-time remeasurement of otherwise
valid primary-only cached segments in that tile. Unaffected tile keys stay valid;
subsequent builds reuse the final composite keys. This avoids claiming a cached
measurement used a source it did not use.
