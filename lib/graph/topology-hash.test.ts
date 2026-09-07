import { describe, expect, it } from "vitest";
import { canonicalTopologyJson, topologySha256 } from "./topology-hash";

describe("schema-6 topology identity", () => {
  it("preserves the frozen pre-refactor hash and canonical JSON rules", () => {
    const input = {
      z: [{ b: 2, a: 1 }, undefined, null, "é🏔"],
      omitted: undefined,
      a: { minus: -0, exponent: 1e30, quote: '"\n' },
    };
    expect(canonicalTopologyJson(input)).toBe('{"a":{"exponent":1e+30,"minus":0,"quote":"\\\"\\n"},"z":[{"a":1,"b":2},null,null,"é🏔"]}');
    expect(topologySha256(input)).toBe("sha256:9ec7fde9fbdf1899b1f4e39d121ec30ed8c99a76ce42276d93b35eb6fae4cab6");
    expect(topologySha256({ a: input.a, z: input.z })).toBe(topologySha256(input));
    expect(topologySha256({ ...input, z: [...input.z].reverse() })).not.toBe(topologySha256(input));
  });
});
