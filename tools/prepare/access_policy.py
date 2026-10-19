"""Bounded directed walking approaches to corridors with hiking evidence."""
import collections
import heapq

APPROACH_METERS = 804.672


def explicit_trail(tags):
    """Trail type is positive evidence even when surrounding land is unmapped."""
    return (tags.get('highway') in {'path', 'bridleway'}
            and tags.get('footway') not in {'sidewalk', 'crossing'})


def hiking_distances(edges, core, *, allow_roads):
    incoming = collections.defaultdict(list)
    distances = {}
    for edge in edges:
        if core[edge['trail']]:
            for node in (edge['from'], edge['to']):
                distances[node] = 0
        elif allow_roads or not edge['connector']:
            incoming[edge['to']].append((edge['from'], edge['distance']))
    queue = [(0, node) for node in distances]
    heapq.heapify(queue)
    while queue:
        distance, node = heapq.heappop(queue)
        if distance != distances[node]:
            continue
        for previous, length in incoming[node]:
            approach = distance + length
            if approach <= APPROACH_METERS and approach < distances.get(previous, float('inf')):
                distances[previous] = approach
                heapq.heappush(queue, (approach, previous))
    return distances
