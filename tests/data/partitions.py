"""Offline independent geometry and hard-boundary correctness checks."""
import sys
import tempfile
import unittest
from collections import defaultdict
from pathlib import Path

from shapely import LineString, MultiPolygon, Point, Polygon, box
from shapely.ops import unary_union

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools/prepare"))
from footprint import Footprint
from graph import distance, topology
from partition import SegmentCounts, choose_sections, representative, split_section


def road(*traces):
    points, adjacent = {}, defaultdict(dict)
    for index, trace in enumerate(traces):
        nodes = [f"{index}:{i}" for i in range(len(trace))]
        points.update(zip(nodes, trace))
        for left, right, a, b in zip(nodes, nodes[1:], trace, trace[1:]):
            adjacent[left][right] = adjacent[right][left] = distance(a, b)
    return {"points": points, "adjacent": adjacent}


class Partitions(unittest.TestCase):
    def assert_partition(self, original, sections):
        areas = [area for area, _ in sections]
        self.assertLess(original.symmetric_difference(unary_union(areas)).area, 1e-10)
        for index, area in enumerate(areas):
            self.assertTrue(area.is_valid)
            for other in areas[index + 1:]:
                self.assertLess(area.intersection(other).area, 1e-10)

    def test_size_gate_priority_and_exact_minimum_lower_tier_cuts(self):
        with tempfile.TemporaryDirectory() as temporary:
            counts = SegmentCounts(Path(temporary) / "segments.sqlite")
            for x in range(10):
                for y in range(10):
                    counts.add((x + .2, y + .2), (x + .8, y + .2))
            geometry = MultiPolygon([box(0, 0, 10, 10)])
            roads = {"US2": road([(-1, 2.5), (11, 2.5)]), "WA20": road([(5, -1), (5, 11)]),
                     "I90": road([(-1, 5), (11, 5)])}
            whole, cuts = choose_sections(geometry, roads, counts.count, 100)
            self.assertEqual(cuts, [], "Available highways cannot justify cutting a small region")
            self.assertEqual(len(whole), 1)
            halves, cuts = choose_sections(geometry, roads, counts.count, 50)
            self.assertEqual([cut["ref"] for cut in cuts], ["I90"], "Freeway cut satisfies capacity, so lower roads remain unused")
            self.assertEqual(sorted(counts.count(area) for area, _ in halves), [50, 50])
            quarters, cuts = choose_sections(geometry, roads, counts.count, 30)
            self.assertEqual([cut["ref"] for cut in cuts], ["I90", "WA20"], "One lower-tier road that splits both oversized halves beats two cuts")
            self.assertEqual(sorted(counts.count(area) for area, _ in quarters), [25] * 4)
            reordered, again = choose_sections(geometry, dict(reversed(list(roads.items()))), counts.count, 30)
            self.assertEqual(cuts, again, "Road discovery order cannot choose different cuts")
            self.assertEqual([area.wkb for area, _ in quarters], [area.wkb for area, _ in reordered])
            for sections in (whole, halves, quarters):
                self.assert_partition(geometry, sections)
            counts.close()

    def test_mapping_gap_and_divided_carriageways(self):
        geometry = MultiPolygon([box(0, 0, 10, 10)])
        broken = road([(-1, 5), (4, 5)], [(6, 5), (11, 5)])
        line = representative(broken, geometry)
        self.assertIsNone(split_section(geometry, line), "A missing highway connection must not be invented")
        divided = road([(-1, 5), (11, 5)], [(-1, 5.1), (11, 5.1)])
        line = representative(divided, geometry)
        sections = [(area, []) for area in split_section(geometry, line)]
        self.assertEqual(len(sections), 2, "Two carriageways represent one divider, without a median section")
        self.assert_partition(geometry, sections)

    def test_road_becomes_a_through_divider_at_a_selected_highway_boundary(self):
        with tempfile.TemporaryDirectory() as temporary:
            counts = SegmentCounts(Path(temporary) / "segments.sqlite")
            for x in range(10):
                for y in range(10):
                    counts.add((x + .2, y + .2), (x + .8, y + .2))
            geometry = MultiPolygon([box(0, 0, 10, 10)])
            # US2 alone ends inside the mountain; US12 gives it a real end boundary.
            # Deliberately reverse discovery order; applicability gets retried.
            roads = {"US2": road([(5, 11), (5, 5)]), "US12": road([(-1, 5), (11, 5)]),
                     "WA410": road([(-1, 2.5), (11, 2.5)])}
            sections, cuts = choose_sections(geometry, roads, counts.count, 30)
            self.assertEqual({cut["ref"] for cut in cuts}, {"US2", "US12", "WA410"})
            self.assertEqual(sorted(counts.count(area) for area, _ in sections), [20, 25, 25, 30])
            self.assert_partition(geometry, sections)
            counts.close()

    def test_winding_cut_holes_and_disconnected_patches_keep_exact_coverage(self):
        mainland = Polygon([(0, 0), (10, 0), (10, 10), (0, 10)],
                           [[(2, 2), (2, 3), (3, 3), (3, 2)]])
        geometry = MultiPolygon([mainland, box(-2, 8, -1, 9), box(11, 1, 12, 2)])
        line = LineString([(-3, 5), (2, 4), (5, 6), (8, 4), (13, 5)])
        sections = [(area, []) for area in split_section(geometry, line)]
        self.assertEqual(len(sections), 2, "Disconnected GMBA pieces stay in two logical downloads")
        self.assert_partition(geometry, sections)
        footprint = Footprint(mainland)
        self.assertEqual(len(footprint.intervals((-1, 2.5), (11, 2.5))), 2, "A sparse source segment cannot bridge a mountain-footprint hole")
        self.assertFalse(footprint.covers((2.5, 2.5)))

    def test_hard_highway_clips_bridges_preserves_real_side_starts_and_blocks_highway_walking(self):
        line = LineString([(0, -1), (0, 1)])
        regions = [Footprint(box(-1, -1, 0, 1), [line]), Footprint(box(0, -1, 1, 1), [line])]
        points = {"1": (-.8, 0), "2": (0, 0), "3": (.8, 0), "4": (-.8, .5), "5": (.8, .5),
                  "6": (0, -.8), "7": (0, .8), "8": (-.8, -.5), "9": (.8, -.5)}
        ways = {"10": {"id": "10", "nodes": ["1", "2", "3"], "tags": {"highway": "path", "foot": "yes", "bridge": "yes"}},
                "11": {"id": "11", "nodes": ["4", "5"], "tags": {"highway": "path", "foot": "yes", "tunnel": "yes"}},
                "12": {"id": "12", "nodes": ["6", "2", "7"], "tags": {"highway": "primary", "foot": "yes"}},
                "13": {"id": "13", "nodes": ["8", "9"], "tags": {"highway": "path", "foot": "yes"}}}
        poi = [{"id": "n2", "nodes": ["2"], "kind": "trailhead", "tags": {"highway": "trailhead", "foot": "yes", "name": "At highway"}}]
        for index, region in enumerate(regions):
            corridors, _, entrances, audit = topology(ways, poi, {}, points, region)
            self.assertEqual(set(entrances), {"n2"}, "A real mapped starting node remains independently selectable on each side")
            self.assertNotIn("n2", audit["frontiers"], "An original source node is not an invented clipped start")
            self.assertEqual(entrances["n2"]["name"], "At highway")
            self.assertEqual(len(corridors), 3)
            self.assertFalse(any(item["kind"] == "connector" for item in corridors), "Selected highway gets no walking edges")
            for corridor in corridors:
                for lon, _ in corridor["coordinates"]:
                    self.assertLessEqual(lon, 0) if index == 0 else self.assertGreaterEqual(lon, 0)
                self.assertFalse(line.covers(LineString(corridor["coordinates"])))
            self.assertEqual(len(audit["frontiers"]), 2, "Geometric crossings split even without a shared OSM node")

    def test_reversed_duplicate_source_segment_deduplicates_at_exact_boundary(self):
        points = {"1": (-1, .123), "2": (1, .321)}
        ways = {"10": {"id": "10", "nodes": ["1", "2"], "tags": {"highway": "path", "foot": "yes"}},
                "11": {"id": "11", "nodes": ["2", "1"], "tags": {"highway": "footway", "footway": "sidewalk"}}}
        corridors, _, _, audit = topology(ways, [], {}, points, Footprint(box(-.3, -1, .4, 1)))
        self.assertEqual(len(corridors), 1, "The same source node pair is one physical corridor despite reversed duplicate geometry")
        self.assertEqual(corridors[0]["kind"], "connector", "Conservative physical classification survives clipping")
        self.assertEqual(corridors[0]["access"], ["unknown", "unknown"])
        self.assertEqual(len(audit["frontiers"]), 2)
        self.assertEqual(audit["counts"]["duplicateSegments"], 1)


if __name__ == "__main__":
    unittest.main()
