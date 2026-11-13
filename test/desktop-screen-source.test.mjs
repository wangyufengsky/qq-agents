import assert from "node:assert/strict";
import test from "node:test";
import {
  findScreenSource,
  observationSources,
  observationTarget,
  readObservationFrame,
} from "../desktop/home/screen-source.mjs";

test("screen capture retains the selected source when its title changes", () => {
  const selected = { id: "window:1:0", display_id: "", name: "Document A" };
  const renamed = { ...selected, name: "Document B" };
  const differentWindow = { ...selected, id: "window:2:0" };
  assert.equal(findScreenSource([differentWindow, renamed], selected), renamed);
  assert.equal(findScreenSource([differentWindow], selected), undefined);
});

test("observation drops a captured frame if the target or permission changes", async () => {
  const ready = { state: "ready", source: observed };
  const read = (source) => {
    assert.equal(source, observed);
    return { data: "fixture frame" };
  };
  for (const status of ["minimized", "unavailable", "permission"]) {
    const reads = [ready, { state: status }];
    assert.deepEqual(
      await readObservationFrame(
        () => reads.shift(),
        read,
        () => true,
      ),
      { status },
    );
    assert.deepEqual(reads, []);
  }
  assert.deepEqual(
    await readObservationFrame(
      () => ready,
      () => ({ permission: true }),
      () => true,
    ),
    { status: "permission" },
  );
  let current = true;
  assert.deepEqual(
    await readObservationFrame(
      () => ready,
      (source) => {
        current = false;
        return read(source);
      },
      () => current,
    ),
    {},
  );
  assert.deepEqual(
    await readObservationFrame(
      () => ready,
      read,
      () => true,
    ),
    {
      data: "fixture frame",
    },
  );
});

test("screen capture rejects a changed display identity", () => {
  const selected = { id: "screen:1:0", display_id: "1", name: "Display" };
  const differentDisplay = { ...selected, display_id: "2" };
  assert.equal(findScreenSource([differentDisplay], selected), undefined);
});

const observed = {
  id: "window:47:0",
  display_id: "",
  name: "Same title",
};
const owner = {
  id: "w-47",
  pid: 19,
  processInstance: "instance-1",
  app: "Window Fixture",
  state: "ready",
};

test("observation picker only lists external, uniquely identified native windows", () => {
  const sources = [
    observed,
    { ...observed, id: "screen:1:0" },
    { ...observed, id: "window:48:1" },
    { ...observed, id: "window:49:0" },
    { ...observed, id: "window:50:0" },
    { ...observed, id: "window:51:0" },
    { ...observed, id: "window:52:0" },
    { ...observed, id: "window:52:0", display_id: "other" },
  ];
  const windows = [
    owner,
    { ...owner, id: "w-48" },
    { ...owner, id: "w-49" },
    { ...owner, id: "w-50", pid: 7 },
    { ...owner, id: "w-51", state: "minimized" },
    { ...owner, id: "w-52" },
  ];
  assert.deepEqual(observationSources(sources, windows, ["window:49:1"], 7), [
    { ...observed, identity: owner },
  ]);
});

test("observation revalidates the exact owner, closes on substitution, and pauses on minimization", () => {
  const selected = { ...observed, identity: owner };
  const renamed = { ...observed, name: "Changed title" };
  const replacement = { ...observed, id: "window:48:0" };
  const validate = (sources, windows, own = []) =>
    observationTarget(sources, windows, selected, own, 7);
  assert.deepEqual(validate([renamed, replacement], [owner]), {
    state: "ready",
    source: renamed,
  });
  assert.deepEqual(validate([], [{ ...owner, state: "minimized" }]), {
    state: "minimized",
  });
  for (const result of [
    validate([renamed], []),
    validate([replacement], [owner]),
    validate([renamed], [{ ...owner, processInstance: "reused-pid" }]),
    validate([renamed], [{ ...owner, pid: 20 }]),
    validate([renamed], [{ ...owner, state: "unavailable" }]),
    validate([renamed], [owner], ["window:47:1"]),
    validate([renamed, { ...renamed, display_id: "other" }], [owner]),
  ])
    assert.deepEqual(result, { state: "unavailable" });
  assert.deepEqual(validate([renamed], [owner]), {
    state: "ready",
    source: renamed,
  });
});
