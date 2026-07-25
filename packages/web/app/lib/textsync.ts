import * as Y from "yjs";

/**
 * Minimal textarea <-> Y.Text binding: turn a plain string edit into CRDT
 * operations by diffing common prefix/suffix. Multiple users editing the
 * pending prompt simultaneously converge because all mutation goes through
 * the Y.Text type.
 */
export function applyTextEdit(text: Y.Text, prev: string, next: string): void {
  if (prev === next) return;
  let start = 0;
  const minLen = Math.min(prev.length, next.length);
  while (start < minLen && prev[start] === next[start]) start += 1;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
    endPrev -= 1;
    endNext -= 1;
  }
  text.doc?.transact(() => {
    if (endPrev > start) text.delete(start, endPrev - start);
    if (endNext > start) text.insert(start, next.slice(start, endNext));
  });
}

/** Wire two docs together in-process (used by tests to prove convergence). */
export function connectDocs(a: Y.Doc, b: Y.Doc): () => void {
  const aToB = (update: Uint8Array, origin: unknown) => {
    if (origin !== "relay") Y.applyUpdate(b, update, "relay");
  };
  const bToA = (update: Uint8Array, origin: unknown) => {
    if (origin !== "relay") Y.applyUpdate(a, update, "relay");
  };
  a.on("update", aToB);
  b.on("update", bToA);
  // initial sync both ways
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a), "relay");
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b), "relay");
  return () => {
    a.off("update", aToB);
    b.off("update", bToA);
  };
}
