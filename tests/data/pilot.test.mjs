import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { convertDatabase } from '../../tools/pilot/export.mjs';
import { verifyWitness } from '../../benchmarks/source-witnesses.mjs';

test('sealed conversion keeps one physical geometry with independent directional gain/access', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE nodes(id,lon,lat,elevation_m);
    CREATE TABLE physical_edges(physical_edge_key,stable_physical_id);
    CREATE TABLE edges(id,physical_edge_key,from_node,to_node,geometry,length_m,gain_m,access_state,flags);
    CREATE TABLE access_points(id,node_id,name,access_state);
    INSERT INTO nodes VALUES('a',-121,47,100),('b',-121.01,47.01,150);
    INSERT INTO physical_edges VALUES(1,'source-way:3');
    INSERT INTO edges VALUES('forward',1,'a','b','[[-121,47],[-121.01,47.01]]',100,60,'public','["trail-name:Test"]');
    INSERT INTO edges VALUES('reverse',1,'b','a','[[-121.01,47.01],[-121,47]]',100,10,'unknown','[]');
    INSERT INTO access_points VALUES('start','a','Entrance','unknown');`);
  try {
    const { graph, geometry } = convertDatabase(db, { id: 'fixture' });
    assert.equal(geometry.length, 1);
    assert.deepEqual(graph.edges, [
      { from: 0, to: 1, trail: 0, reverse: false, distance: 100, gain: 60, access: 'public' },
      { from: 1, to: 0, trail: 0, reverse: true, distance: 100, gain: 10, access: 'unknown' },
    ]);
    assert.equal(graph.starts[0].access, 'unknown');
    db.exec("UPDATE edges SET access_state='private' WHERE id='reverse'");
    assert.equal(convertDatabase(db, { id: 'fixture' }).graph.edges.length, 1);
  } finally { db.close(); }
});

test('source witness validator accepts a real stem/cycle pattern and rejects extra spurs', () => {
  const rows = [
    ['ab', 'a', 'b', 'stem', 2], ['ba', 'b', 'a', 'stem', 0],
    ['bc', 'b', 'c', 'one', 3], ['cd', 'c', 'd', 'two', 0], ['db', 'd', 'b', 'three', 0],
  ];
  const edges = rows.map(([id, from, to, trail, gain]) => ({ id, from, to, trail, gain, distance: 10, access: 'public' }));
  const source = { starts: [{ id: 's', node: 'a', access: 'public' }],
    positions: new Map([['a', [0, 0]]]), edgeById: new Map(edges.map(edge => [edge.id, edge])) };
  const query = { area: [-1, -1, 1, 1], distance: [0, 100], gain: [0, 100], repetition: 0.5, includeUnknown: true };
  const valid = { startId: 's', edgeIds: ['ab', 'bc', 'cd', 'db', 'ba'] };
  assert.deepEqual(verifyWitness(source, { query }, valid),
    { distance: 50, gain: 5, repetition: 0.2, kind: 'lollipop', uncertain: false });
  assert.throws(() => verifyWitness(source, { query }, { ...valid, edgeIds: ['ab', 'ba', ...valid.edgeIds] }));
  assert.throws(() => verifyWitness(source, { query: { ...query, repetition: 0.19 } }, valid));
});
