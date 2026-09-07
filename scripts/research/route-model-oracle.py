#!/usr/bin/env python3
"""Dependency-free exact oracle for tiny, bounded directed-use route models.

Each physical edge has <=1 traversal in each legal direction. This restricted
search is exhaustive, not an exact solver for arbitrary repeated hiking walks.
Run: python3 scripts/research/route-model-oracle.py
"""
from dataclasses import dataclass
from itertools import product
import json
from time import perf_counter


@dataclass(frozen=True)
class Edge:
    source: str
    target: str
    length: int
    forward_gain: int = 0
    reverse_gain: int = 0
    one_way: bool = False


def reachable(start, adjacency):
    seen, pending = {start}, [start]
    while pending:
        for other in adjacency.get(pending.pop(), []):
            if other not in seen:
                seen.add(other)
                pending.append(other)
    return seen


def cycle_length(edges):
    """Physical length on nonbridge edges in this selected support."""
    total = 0
    for removed, edge in enumerate(edges):
        adjacency = {}
        for index, other in enumerate(edges):
            if index == removed:
                continue
            adjacency.setdefault(other.source, []).append(other.target)
            adjacency.setdefault(other.target, []).append(other.source)
        if edge.target in reachable(edge.source, adjacency):
            total += edge.length
    return total


def euler_walk(start, arcs):
    adjacency = {}
    for source, target in arcs:
        adjacency.setdefault(source, []).append(target)
    stack, result = [start], []
    while stack:
        choices = adjacency.get(stack[-1], [])
        if choices:
            stack.append(choices.pop())
        else:
            result.append(stack.pop())
    walk = list(reversed(result))
    assert len(walk) == len(arcs) + 1 and walk[0] == walk[-1] == start
    return walk


def solve(edges, minimum, maximum, repeat_fraction, connected=True,
          gain_bounds=None, allow_multi=True, start="s"):
    best, feasible, examined = None, 0, 0
    choices = [(0, 1) if edge.one_way else (0, 1, 2, 3) for edge in edges]
    for selection in product(*choices):
        examined += 1
        distance = sum(e.length * (int(bool(m & 1)) + int(bool(m & 2)))
                       for e, m in zip(edges, selection))
        if not minimum <= distance <= maximum:
            continue
        used = [e for e, mask in zip(edges, selection) if mask]
        unique = sum(e.length for e in used)
        repeated = distance - unique
        if repeated > repeat_fraction * distance + 1e-9:
            continue
        balance, adjacency, arcs, gain = {}, {}, [], 0
        for edge, mask in zip(edges, selection):
            for enabled, source, target, climb in (
                    (mask & 1, edge.source, edge.target, edge.forward_gain),
                    (mask & 2, edge.target, edge.source, edge.reverse_gain)):
                if not enabled:
                    continue
                arcs.append((source, target))
                adjacency.setdefault(source, []).append(target)
                balance[source] = balance.get(source, 0) + 1
                balance[target] = balance.get(target, 0) - 1
                gain += climb
        if start not in balance or any(balance.values()):
            continue
        if gain_bounds and not gain_bounds[0] <= gain <= gain_bounds[1]:
            continue
        if connected and reachable(start, adjacency) != set(balance):
            continue
        rank = len(used) - len(balance) + 1
        if rank < 1 or (not allow_multi and rank > 1):
            continue
        feasible += 1
        # Illustrative first-use prize with repetition and target penalties.
        score = unique - repeated - abs(distance - (minimum + maximum) / 2)
        if best is None or score > best["score"]:
            best = {"distance_m": distance, "unique_m": unique,
                    "repeated_m": repeated, "gain_m": gain,
                    "cycle_rank": rank, "score": score,
                    "cycle_trail_m": cycle_length(used),
                    "selection": selection,
                    "walk": euler_walk(start, arcs) if connected else None}
    return {"examined": examined, "feasible": feasible, "best": best}


def triangle(root="s", left="a", right="b", length=1000, one_way=False):
    return [Edge(root, left, length, one_way=one_way),
            Edge(left, right, length, one_way=one_way),
            Edge(right, root, length, one_way=one_way)]


def main():
    begun = perf_counter()
    chain = triangle() + [Edge("s", "p", 500)] + triangle("p", "x", "y", 700)
    chain_result = solve(chain, 6000, 6200, 0.1)
    assert chain_result["examined"] == 4 ** 7 and chain_result["feasible"] == 4
    assert chain_result["best"]["distance_m"] == 6100
    assert chain_result["best"]["repeated_m"] == 500
    assert chain_result["best"]["cycle_rank"] == 2
    disconnected = triangle() + triangle("p", "x", "y")
    trap = solve(disconnected, 5900, 6100, 0)
    relaxed = solve(disconnected, 5900, 6100, 0, connected=False)
    assert trap["feasible"] == 0 and relaxed["feasible"] == 4
    tiny = solve([Edge("s", "p", 1000)] + triangle("p", "a", "b", 10),
                 2000, 2050, 0.5)
    assert tiny["best"]["distance_m"] == 2030
    assert tiny["best"]["cycle_trail_m"] == 30 and tiny["feasible"] == 2
    lap = solve(triangle(), 5900, 6100, 0.55)
    assert lap["feasible"] == 1 and lap["best"]["repeated_m"] == 3000
    directed = solve(triangle(one_way=True), 2900, 3100, 0)
    assert directed["feasible"] == 1 and directed["examined"] == 8
    impossible_gain = solve(chain, 6000, 6200, 0.1, gain_bounds=(1, 100))
    assert impossible_gain["feasible"] == 0
    no_multi = solve(chain, 6000, 6200, 0.1, allow_multi=False)
    assert no_multi["feasible"] == 0
    for name, value in (("chain", chain_result), ("disconnected", trap),
                        ("disconnected_without_flow", relaxed), ("tiny_loop", tiny),
                        ("reverse_lap", lap), ("one_way", directed),
                        ("impossible_gain", impossible_gain), ("no_multi", no_multi)):
        print(json.dumps({"case": name, **value}, sort_keys=True))
    print(json.dumps({"assertions": "passed", "elapsed_seconds": perf_counter() - begun}))


if __name__ == "__main__":
    main()
