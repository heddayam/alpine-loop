"""Independent place grouping boundaries for duplicate hiking starts."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools/prepare'))
from graph import assemble, measure, places, topology


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

    def test_compiled_lot_with_several_exits_is_one_start(self):
        # A lot touches the trail at three nodes, one of them a mapped trailhead,
        # and a road reaches the lot. A distant road contact stays its own start.
        points = {'1': (0, 0), '2': (.0004, 0), '3': (.0008, 0), '4': (.0012, 0), '5': (.006, .003),
                  '8': (.0004, -.001), '9': (.006, .004)}
        ways = {'loop': {'id': 'loop', 'nodes': ['1', '2', '3', '4', '5', '1'], 'tags': {'highway': 'path'}},
                'lot-road': {'id': 'lot-road', 'nodes': ['8', '2'], 'tags': {'highway': 'service'}},
                'far-road': {'id': 'far-road', 'nodes': ['9', '5'], 'tags': {'highway': 'unclassified'}}}
        trailhead = {'highway': 'trailhead', 'name': 'Lot Trailhead'}
        pois = [{'id': 'n3', 'kind': 'trailhead', 'nodes': ['3'], 'tags': trailhead},
                {'id': 'w100', 'kind': 'parking', 'nodes': ['2', '3', '4'], 'tags': {'amenity': 'parking'}}]
        corridors, _, entrances, _ = topology(ways, pois, {'3': trailhead}, points, [-.01, -.01, .01, .01])
        self.assertEqual(set(entrances), {'n2', 'n3', 'n4', 'n5'})
        measure(corridors, lambda positions: [100] * len(positions))
        graph, _, _ = assemble(corridors, entrances, {'id': 'fixture'})
        self.assertEqual([(start['id'], start['kind'], start['name']) for start in graph['starts']],
                         [('osm-entrance:3', 'trailhead', 'Lot Trailhead'), ('osm-entrance:5', 'road-contact', 'Trail entrance')])
        self.assertEqual(graph['info']['startCount'], 2)

    def test_parking_must_meet_a_trail(self):
        # One lot touches only its road; the other touches the trail. Neither is a mapped trailhead.
        points = {'1': (0, 0), '2': (.003, 0), '3': (.003, .003), '7': (.006, 0), '8': (.006, .001), '9': (.009, .001)}
        ways = {'loop': {'id': 'loop', 'nodes': ['1', '2', '3', '1'], 'tags': {'highway': 'path'}},
                'road': {'id': 'road', 'nodes': ['7', '8', '9'], 'tags': {'highway': 'service'}}}
        pois = [{'id': 'w50', 'kind': 'parking', 'nodes': ['8'], 'tags': {'amenity': 'parking'}},
                {'id': 'w51', 'kind': 'parking', 'nodes': ['2'], 'tags': {'amenity': 'parking'}}]
        _, _, entrances, audit = topology(ways, pois, {}, points, [-.01, -.01, .02, .02])
        self.assertEqual(set(entrances), {'n2'})
        self.assertEqual([(poi['id'], poi['reason']) for poi in audit['unresolvedPois']], [('w50', 'no shared trail node')])

    def test_entrances_need_a_connected_trail_network(self):
        # Three ~110 m stubs from one street: alone, joined to a 1.1 km fire road, and at a mapped trailhead.
        points = {'s1': (0, 0), 's2': (.002, 0), 's3': (.004, 0), 'a': (0, .001), 'b': (.002, .001), 'c': (.004, .001),
                  'f': (.002, .011)}
        ways = {'street': {'id': 'street', 'nodes': ['s1', 's2', 's3'], 'tags': {'highway': 'residential'}},
                'stub': {'id': 'stub', 'nodes': ['s1', 'a'], 'tags': {'highway': 'footway'}},
                'spur': {'id': 'spur', 'nodes': ['s2', 'b'], 'tags': {'highway': 'path'}},
                'fire': {'id': 'fire', 'nodes': ['b', 'f'], 'tags': {'highway': 'track', 'motor_vehicle': 'no'}},
                'nature': {'id': 'nature', 'nodes': ['s3', 'c'], 'tags': {'highway': 'path'}}}
        trailhead = {'highway': 'trailhead', 'name': 'Nature Walk'}
        pois = [{'id': 'nc', 'kind': 'trailhead', 'nodes': ['s3'], 'tags': trailhead}]
        _, _, entrances, audit = topology(ways, pois, {'s3': trailhead}, points, [-.01, -.01, .02, .02])
        self.assertEqual(set(entrances), {'ns2', 'ns3'})
        self.assertEqual(audit['counts']['isolatedEntrances'], 1)


if __name__ == '__main__':
    unittest.main()
