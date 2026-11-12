import assert from "node:assert/strict";
import test from "node:test";
import { findScreenSource } from "../desktop/home/screen-source.mjs";

test("screen capture retains the selected source when its title changes", () => {
  const selected = { id: "window:1:0", display_id: "", name: "Document A" };
  const renamed = { ...selected, name: "Document B" };
  const differentWindow = { ...selected, id: "window:2:0" };
  assert.equal(findScreenSource([differentWindow, renamed], selected), renamed);
  assert.equal(findScreenSource([differentWindow], selected), undefined);
});

test("screen capture rejects a changed display identity", () => {
  const selected = { id: "screen:1:0", display_id: "1", name: "Display" };
  const differentDisplay = { ...selected, display_id: "2" };
  assert.equal(findScreenSource([differentDisplay], selected), undefined);
});
