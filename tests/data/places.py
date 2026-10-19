"""Independent place grouping boundaries for duplicate hiking starts."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools/prepare'))
from graph import places


def start(node, kind='road-contact', access='unknown'):
    return {'id': f'osm-entrance:{node}', 'node': node, 'kind': kind, 'access': access}


def path(*pairs):
    return [{'from': a, 'to': b, 'distance': length} for a, b, length in pairs]


class StartPlaces(unittest.TestCase):
    def test_lot_sharing_nodes_joins_nearby_trailhead(self):
        starts = [start(0, 'parking'), start(1, 'parking'), start(2, 'parking'), start(3, 'trailhead')]
        # The far lot node is beyond walking reach of the trailhead but belongs to the same lot.
        edges = path((3, 0, 80), (0, 1, 100), (1, 2, 150))
        self.assertEqual(set(places(starts, edges, [['w10'], ['w10'], ['w10'], ['n3']])), {'osm-entrance:3'})

    def test_distant_road_contacts_stay_separate(self):
        starts = [start(0), start(1)]
        self.assertEqual(places(starts, path((0, 1, 400)), [[], []]), ['osm-entrance:0', 'osm-entrance:1'])

    def test_nearby_contacts_do_not_chain_into_one_place(self):
        starts = [start(node) for node in range(5)]
        edges = path(*((node, node + 1, 100) for node in range(4)))
        self.assertEqual(places(starts, edges, [[]] * 5),
                         ['osm-entrance:0', 'osm-entrance:0', 'osm-entrance:2', 'osm-entrance:2', 'osm-entrance:4'])


if __name__ == '__main__':
    unittest.main()
