# Access-entry implementation: independent source validation

The audit found corrected area-perimeter and ordinary-rooted unknown-track bugs. Original
source checks retain Top Lake, permitted Denny walking and actual outer interfaces while
rejecting tested interior contacts. These are concrete regressions, not regional precision,
recall, public car accessibility or route suitability.

## Reproduction and scope

Run against immutable retained PBFs; no downloads, existing pack/database reads,
publication or regional build occurs:

```sh
node --import tsx scripts/audit-access-entries.ts \
  --washington=/absolute/path/geofabrik-washington-osm-washington-260801.osm.pbf \
  --norcal=/absolute/path/geofabrik-norcal-osm-norcal-260801.osm.pbf \
  --output=.cache/access-entry-audit --reuse-extracts=true
```

The script hashes PBFs, extracts complete ways into fresh scratch stores and evaluates
production proof over geometric segments with **null elevation**. Traces retain original
node/root tags, incident/root source way IDs/references, directed departures, endpoint
passage flags, assertions and witnesses. Reuse requires source/geometry identity.
[Fixture provenance](../../../data/fixtures/access-review/README.md) records exact hashes/IDs
and unchanged original records. Baseline detector `7894ea3` uses the **same corrected
normalization/movement projection**; this isolates nomination, not all historical semantics.
Six windows were selected before output inspection, then used to diagnose fixes: final
reruns are regression evidence, not untouched accuracy holdouts. They span urban forest,
forest foothill, mountain valley and California foothills. There is no mountain association,
50-mile support qualification/pruning, DEM, full-pack coverage evaluation or route search.
Final evaluator: `1dab992`; SHA-256 `d55246ea731c7f0cc6f3a50675211caf45b38d2cea422d607ccb1d931cc9023e`.

## Final source-role comparison

Active normalization/cache v14 and standalone adapter v15 preserve physical role, separate
foot/motor directions and node restrictions. Unknown-motor tracks stay walking geometry;
only motor-public track directions propagate arrival. Ordinary roads or eligible mapped
places root service/track spines; asserted trailheads require directed walking connection.
`I/K` means unknown-included / known-foot-only, before mountain/route policies.

| Window | Old I/K | Final I/K | Old I/K, historical density | Final I/K, historical density | New-only / removed |
| --- | ---: | ---: | ---: | ---: | ---: |
| Discovery Park | 43/21 | 286/62 | 0/0 | 0/0 | 250 / 7 |
| Tiger High Point | 5/2 | 9/5 | 2/1 | 5/4 | 4 / 0 |
| Denny Creek | 9/6 | 15/10 | 4/2 | 4/2 | 6 / 0 |
| Mitchell Canyon | 20/1 | 28/2 | 15/1 | 17/1 | 8 / 0 |
| Sunol | 14/3 | 16/3 | 14/3 | 16/3 | 2 / 0 |
| Alum Rock | 15/8 | 61/9 | 5/2 | 10/2 | 46 / 0 |

The former fewer-than-ten-buildings-within-500-m rule is a separate historical
counterfactual; no removed production admission API is restored. Discovery's 250 additions
are 246 interfaces and four parking assertions: 28 service-root, 94 service/street and 128
street-root contacts, no track roots; 48 public-foot and 202 unknown-foot. Root motor
alternatives are unknown-only at 194, include public at 40, all restricted at 15, and
restricted/unknown at one. Incident-source alternatives are not car claims. All 286 fail
historical density; mountain eligibility was not evaluated. More candidates do not prove
an accuracy improvement, and density must not hide detector failures.

## Concrete evidence: bugs, choices and gaps

- **Area bug corrected:** NorCal `w356872374` is a closed `area=yes,highway=track`
  footprint. Before v11 its outline could compile as a false trail circuit. Potential
  walking highway areas are now context-only; the original fixture guards this. This
  Humboldt case lies outside offered California areas; no published-route failure is
  claimed. No trail-area outline remains in the six windows.
- **Road/road interfaces removed:** Discovery `n1716565176` joins tertiary `w159547070`
  to residential `w681276520` (`foot=yes,motor_vehicle=destination`). Old admission called
  it a public Washington Avenue trailhead. Walking permission does not turn physical road
  function into hiking function. Six other removals share this mechanism; historical density
  already excluded all seven.
- **Rooting alone was insufficient:** Sunol `n1107300663` remained nominated via Welch
  Creek Road `w6388803/w6389308`, then tracks `w122293236 → w122293238 → w95489689 →
  w95489692`, departing onto `w1375487753`. All used tracks had unknown foot/motor access
  and no hard node stop. [Agency trail information](https://www.ebparks.org/parks/sunol) and
  [loop guidance](https://www.ebparks.org/trails/short-loop/southern) distinguish hiking function/staging.
  Final proof stops generic arrival spread: this contact and known-foot `w127025904`
  contacts `n1107300713/n1406776609` are absent in complete windows and fixtures. Sunol's
  intermediate 46/9 fell to 16/3 while all 14 baseline starts remain.
- **Remaining service assumption:** Sunol's two new unknown-foot contacts are
  `n1366350467` (service/track) and `n1366350521` (service/footway). They root at Calaveras
  Road `n1366350537` through service/driveway `w821761681/w796587760`, with absent foot,
  motor and crossing facts. This supports physical service context, not independently
  verified public/legal arrival. Disabling Unknown Access excludes both.
- **Motor stop can be a real foot frontier:** Denny gate `n1969228635` has
  `locked=yes,foot=permissive,motor_vehicle=no`, rooted from ordinary `w340010580` through
  service `w6324285`. It correctly stays a known-foot entry onto vehicle-closed, foot-public
  bridge `w607609231`; generic gate evidence alone did not establish this. Franklin contact
  `n2404325754` and actual tagged Denny `n12527998480` remain. Downstream generic
  `n53004792` is not newly emitted past that mode frontier.
- **Interior contacts excluded:** Mitchell `n452932593/n452933145` join paths to
  motor-prohibited tracks `w38346049/w38447479`; the [State Parks trail-use table](https://ohp.parks.ca.gov/pages/561/files/680-19-029%20-%20Diablo%20Range%20District%20Trail%20Use%20Policy.pdf)
  treats these as trail segment endpoints. Alum `n1357853410` joins a path to track
  `w121247885` (`ford=stepping_stones,foot=yes,motor_vehicle=no`), a pedestrian crossing.
  All are absent from final nominations; track tags alone do not establish arrival roots.
- **Top uses actual source identity:** Unknown-foot/motor tracks `w428036699/w372544732`,
  `w5846768/w428034416` connect ordinary `w427905142` at `n46912346` to `n3761092325`,
  tagged only `highway=turning_circle`. Actual trailhead `n3761092329` lies 20.8 m along
  public-foot path `w1356527414`. Typed turnaround rooting at the actual track contact
  preserves both known-foot starts without walking or certifying the unknown tracks.
  [OSM's definition](https://wiki.openstreetmap.org/wiki/Tag:highway=turning_circle) asserts vehicle
  turning geometry, including possible mid-road bends, not parking or a hiking start.
  Treating it as local arrival authority is the accepted product assumption.
- **Place typing cannot bypass context:** Discovery turnaround `n2737359445` joins
  public-foot `w268402206` only to private-foot/motor-prohibited service `w268402204`; it
  cannot root. Alum turnarounds `n9610159466/n9610159540` touch only golf paths
  `w1044401800/w1044401801`, without arrival-road contact, and stay excluded. Tiger
  `n4439373012` joins public-foot `w446699559` to private road `w6448402`; the original
  trail note names a no-trespassing approach. Both-mode restrictions remain decisive.

## Completeness, passage and route limitations

Directional-only road walking formerly lost permitted geometry; the mode-consistency fix
is covered synthetically, not observed in these windows. Unasserted starts beyond unknown
tracks may still be lost: this source-role tradeoff is not measured recall. Purpose restrictions
such as `access=destination` remain conservatively restricted states, not proof a park
arrival is illegal. Foot-no/motor-unknown ordinary roots are tested synthetically; no real
matching case was found in these windows. Heather's connected parking vertices support a
place without an interior line. Mitchell overflow parking `w1157730772` and Denny Lower
Lot `w434836179` lack mapped highway contact here; proximity cannot prove passage or
independently count an FN. Complete references do not prove mapping; context cuts never root.

No public departure trace uses a hard-restricted endpoint. Original Tiger MTB paths
`w970528918/w970528919` retain unknown reverse walking rather than an invented ban.
They are the only restrictive generic pedestrian one-way ways without foot directions
(two of 8,112 pedestrian ways in complete contexts), both outside scored windows.
[OSM foot-direction guidance](https://wiki.openstreetmap.org/wiki/Key:oneway:foot) supports this uncertainty.
August source cannot certify current closures; the [Sunol agency page](https://www.ebparks.org/parks/sunol)
reports a later Shady Glen closure. Physical cycles count segments once and are only
undirected potential, not directed or criteria-valid hikes. Final regional pack, terrain
and route validation remains the user's next observed gate; no final regional build ran.

## Resource observations and verification

The 343 MiB WA and 618 MiB NorCal inputs were scanned offline; native complete-way
extraction took 4.4–12.5 s/window. Cached final-policy runs retained 8,715 ways from
158,524 original nodes: preparation 2.25–4.98 s, proof 1.35–1.68 s. Sunol retained 141 ways
with proof 0.13–0.16 s. Cumulative Node peak was 471–567 MiB including raw maps, SQLite
and comparison/report allocations; native RSS was unavailable under sandbox accounting.
These bounded observations do not establish regional scaling. Separate closed synthetic
queries preserve 1,000 parking matches against 100,000 road roots while an assertion index
cuts lookup CPU from 2.3 s to 2–3 ms; this is mechanism evidence. A separate 500,000-node
synthetic flag benchmark preserves outputs while reducing median 2.708 s to 0.399 s.
Neither is a regional timing claim. Provenance sets are bounded by source snapshot count.
The integrator's cold v12 source-only prep took 1,787 s amid concurrent host pressure;
its receipt is obsolete for v14 and provides no final warm/build timing guarantee.

Verification: eight focused suites **262/262 passed**, including original-source audit
**15/15** and native extraction tests, with no skips; TypeScript and scoped ESLint passed. Sparse
and measured fixtures check actual movement, not nearby aliases. Scratch databases and
reports remain ignored; automated tests use no network.
