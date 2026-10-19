"""Independent gateway boundaries, without spatial libraries or downloaded data."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools/prepare'))
from access_policy import APPROACH_METERS, explicit_trail, hiking_distances


def edge(a, b, length, trail, road=False):
    return {'from': a, 'to': b, 'distance': length, 'trail': trail, 'connector': road}


class HikingApproaches(unittest.TestCase):
    def test_explicit_trails_need_no_land_polygon_or_route_relation(self):
        self.assertTrue(explicit_trail({'highway': 'path', 'surface': 'ground', 'informal': 'yes'}))
        self.assertTrue(explicit_trail({'highway': 'bridleway'}))
        for tags in ({'highway': 'footway'}, {'highway': 'residential'},
                     {'highway': 'path', 'footway': 'sidewalk'},
                     {'highway': 'path', 'footway': 'crossing'}, {}):
            self.assertFalse(explicit_trail(tags))

    def test_entrance_reaches_hiking_evidence_over_unnamed_trails(self):
        edges = [edge(0, 1, 318, 0), edge(1, 2, 200, 1), edge(2, 3, 900, 2)]
        self.assertEqual(hiking_distances(edges, [False, False, True], allow_roads=False)[0], 518)

    def test_urban_road_does_not_turn_into_a_trail_approach(self):
        edges = [edge(0, 1, 100, 0, road=True), edge(1, 2, 100, 1)]
        self.assertNotIn(0, hiking_distances(edges, [False, True], allow_roads=False))
        self.assertEqual(hiking_distances(edges, [False, True], allow_roads=True)[0], 100)

    def test_half_mile_is_inclusive_and_uses_total_path_distance(self):
        edges = [edge(0, 1, 400, 0), edge(1, 2, APPROACH_METERS - 400, 1),
                 edge(3, 0, .001, 2), edge(2, 4, 1000, 3)]
        distances = hiking_distances(edges, [False, False, False, True], allow_roads=False)
        self.assertEqual(distances[0], APPROACH_METERS)
        self.assertNotIn(3, distances)

    def test_connections_must_allow_walking_toward_the_hiking_network(self):
        edges = [edge(1, 0, 100, 0), edge(1, 2, 1000, 1)]
        self.assertNotIn(0, hiking_distances(edges, [False, True], allow_roads=False))


if __name__ == '__main__':
    unittest.main()
