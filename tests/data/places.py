"""Independent entrance preservation and supporting-network boundaries."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools/prepare'))
from graph import assemble, measure, topology


def compile_graph(ways, pois, points, node_tags=None):
    corridors, _, entrances, _ = topology(ways, pois, node_tags or {}, points, [-.01, -.01, .02, .02])
    measure(corridors, lambda positions: [100] * len(positions))
    return assemble(corridors, entrances, {'id': 'fixture'})[0]


class StartEntrances(unittest.TestCase):
    def test_public_parking_survives_nearby_uncertain_trailhead(self):
        points = {'1': (0, 0), '2': (.0004, 0), '3': (.004, .004)}
        ways = {'loop': {'id': 'loop', 'nodes': ['1', '2', '3', '1'], 'tags': {'highway': 'path'}}}
        pois = [{'id': 'n1', 'kind': 'trailhead', 'nodes': ['1'], 'tags': {'highway': 'trailhead'}},
                {'id': 'w2', 'kind': 'parking', 'nodes': ['2'], 'tags': {'amenity': 'parking', 'access': 'yes'}}]
        graph = compile_graph(ways, pois, points)
        self.assertEqual([(start['id'], start['access']) for start in graph['starts']],
                         [('osm-entrance:1', 'unknown'), ('osm-entrance:2', 'public')])
        # Public-only queries must retain the parking entrance.
        self.assertEqual([start['id'] for start in graph['starts'] if start['access'] == 'public'], ['osm-entrance:2'])

    def test_one_way_connection_does_not_remove_either_start(self):
        points = {'1': (0, 0), '2': (.0004, 0)}
        ways = {'path': {'id': 'path', 'nodes': ['2', '1'], 'tags': {'highway': 'path', 'oneway:foot': 'yes'}}}
        pois = [{'id': 'n' + node, 'kind': 'trailhead', 'nodes': [node], 'tags': {'highway': 'trailhead'}}
                for node in points]
        graph = compile_graph(ways, pois, points)
        self.assertEqual({start['id'] for start in graph['starts']}, {'osm-entrance:1', 'osm-entrance:2'})
        self.assertEqual(len(graph['edges']), 1)
        edge = graph['edges'][0]
        self.assertEqual((graph['nodes'][edge['from']][:2], graph['nodes'][edge['to']][:2]),
                         ([.0004, 0], [0, 0]))

    def test_all_distinct_lot_exits_keep_their_positions(self):
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
                         [('osm-entrance:2', 'parking', 'Mapped parking access'),
                          ('osm-entrance:3', 'trailhead', 'Lot Trailhead'),
                          ('osm-entrance:4', 'parking', 'Mapped parking access'),
                          ('osm-entrance:5', 'road-contact', 'Trail entrance')])
        self.assertEqual(graph['info']['startCount'], 4)
        self.assertEqual([graph['nodes'][start['node']][:2] for start in graph['starts']],
                         [list(points[node]) for node in ['2', '3', '4', '5']])
        # A boundary around exit 2 can select it independently of exit 3.
        self.assertEqual([start['id'] for start in graph['starts']
                          if graph['nodes'][start['node']][0] < .0006], ['osm-entrance:2'])

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
        for surface in [None, 'gravel', 'asphalt', 'concrete', 'paved', 'paving_stones']:
            with self.subTest(surface=surface):
                if surface is None:
                    ways['fire']['tags'].pop('surface', None)
                else:
                    ways['fire']['tags']['surface'] = surface
                corridors, _, entrances, audit = topology(ways, pois, {'s3': trailhead}, points, [-.01, -.01, .02, .02])
                supports = surface in (None, 'gravel')
                self.assertEqual(set(entrances), {'ns2', 'ns3'} if supports else {'ns3'})
                self.assertEqual(audit['counts']['isolatedEntrances'], 1 if supports else 2)
                fire = [corridor for corridor in corridors
                        if any(source['way'] == 'fire' for member in corridor['source'] for source in member['source'])]
                self.assertTrue(fire, 'Paved tracks stay walkable; they only cease supporting a hiking entrance')
                self.assertTrue(all(corridor['kind'] == 'connector' for corridor in fire))


if __name__ == '__main__':
    unittest.main()
