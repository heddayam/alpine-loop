import type { TrailSegment } from "./search";

export async function parseSelectedSegmentNdjson(
  body: ReadableStream<Uint8Array>,
  selectedIds: ReadonlySet<string>,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const selected: TrailSegment[] = [];
  let pending = "";

  const consume = (line: string) => {
    if (!line) return;
    const segment = JSON.parse(line) as TrailSegment;
    if (selectedIds.has(segment.id)) selected.push(segment);
  };

  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      consume(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
    if (done) break;
  }
  consume(pending);
  return selected;
}
