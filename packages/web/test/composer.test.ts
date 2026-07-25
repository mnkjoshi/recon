import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyTextEdit, connectDocs } from "../app/lib/textsync";

/** Composer CRDT convergence with two clients editing simultaneously. */
describe("shared composer CRDT", () => {
  it("two connected clients converge on interleaved edits", () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const disconnect = connectDocs(docA, docB);
    const textA = docA.getText("composer");
    const textB = docB.getText("composer");

    applyTextEdit(textA, "", "build the login page");
    expect(textB.toString()).toBe("build the login page");

    applyTextEdit(textB, textB.toString(), "build the login page with passkeys");
    applyTextEdit(textA, textA.toString(), "please build the login page with passkeys");
    expect(textA.toString()).toBe(textB.toString());
    expect(textA.toString()).toBe("please build the login page with passkeys");
    disconnect();
  });

  it("concurrent offline edits at different positions merge without loss", () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    // seed both with the same base state
    applyTextEdit(docA.getText("composer"), "", "fix the bug in parser");
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

    // Concurrent edits while "disconnected": A prepends, B appends.
    applyTextEdit(docA.getText("composer"), "fix the bug in parser", "URGENT: fix the bug in parser");
    applyTextEdit(docB.getText("composer"), "fix the bug in parser", "fix the bug in parser and add a test");

    // Exchange updates (order shouldn't matter).
    const updateA = Y.encodeStateAsUpdate(docA);
    const updateB = Y.encodeStateAsUpdate(docB);
    Y.applyUpdate(docB, updateA);
    Y.applyUpdate(docA, updateB);

    const a = docA.getText("composer").toString();
    const b = docB.getText("composer").toString();
    expect(a).toBe(b); // convergence
    expect(a).toContain("URGENT:");
    expect(a).toContain("and add a test");
  });

  it("applyTextEdit produces minimal ops (middle edit keeps prefix/suffix)", () => {
    const doc = new Y.Doc();
    const text = doc.getText("composer");
    applyTextEdit(text, "", "hello brave world");
    let inserted = "";
    text.observe((event) => {
      for (const op of event.changes.delta) {
        if (typeof op.insert === "string") inserted += op.insert;
      }
    });
    applyTextEdit(text, "hello brave world", "hello new world");
    expect(text.toString()).toBe("hello new world");
    expect(inserted).toBe("new"); // not a full rewrite
  });
});
