"""Urban walkways count like roads; mountain trails stay trails."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools/prepare'))
from graph import role


class WalkwayRoles(unittest.TestCase):
    def test_lit_pavement_and_pedestrian_streets_are_connectors(self):
        for tags in ({'highway': 'footway', 'surface': 'concrete', 'lit': 'yes'},
                     {'highway': 'steps', 'surface': 'paving_stones', 'lit': 'yes'},
                     {'highway': 'pedestrian'}):
            self.assertEqual(role(tags), 'connector', tags)

    def test_unlit_unpaved_or_path_walkways_stay_trails(self):
        for tags in ({'highway': 'footway', 'surface': 'asphalt'}, {'highway': 'footway', 'surface': 'gravel', 'lit': 'yes'},
                     {'highway': 'footway', 'lit': 'yes'}, {'highway': 'path', 'surface': 'asphalt', 'lit': 'yes'},
                     {'highway': 'bridleway', 'surface': 'concrete', 'lit': 'yes'}):
            self.assertEqual(role(tags), 'trail', tags)


if __name__ == '__main__':
    unittest.main()
