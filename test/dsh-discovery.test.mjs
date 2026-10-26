import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { temp } from "./helpers.mjs";
import {
  discoverDshInstances,
  selectDshInstance,
  parseDshListeners,
  localDshUrl,
} from "../src/backends/dsh-discovery.mjs";

test("published desktop binding follows a new port and never chooses an unrelated DSH", async (t) => {
  const home = temp(t),
    dir = path.join(home, "plugins/dsh-relay/web");
  fs.mkdirSync(dir, { recursive: true });
  let pid = 123,
    port = 6001;
  const write = () => {
    fs.writeFileSync(
      path.join(dir, "relay-endpoint.json"),
      JSON.stringify({
        authorityId: "fixture",
        ownerEpoch: 1,
        mode: "embedded",
        hostWebUrl: `http://127.0.0.1:${port}/`,
      }),
    );
    fs.writeFileSync(
      path.join(dir, "relay-status.json"),
      JSON.stringify({
        authorityId: "fixture",
        ownerEpoch: 1,
        mode: "embedded",
        state: "ready",
        ownerPid: pid,
        dshHome: home,
      }),
    );
  };
  const list = async () => [
    { pid: 999, url: "http://127.0.0.1:3217" },
    { pid, url: `http://127.0.0.1:${port}` },
  ];
  const probe = async () => true;
  write();
  let candidates = await discoverDshInstances({ home, list, probe });
  assert.throws(
    () => selectDshInstance({}, candidates),
    /DSH_SELECTION_REQUIRED/,
  );
  const config = { recovery: { dshInstance: "relay:web" } };
  assert.equal(
    selectDshInstance(config, candidates).url,
    "http://127.0.0.1:6001",
  );
  pid = 124;
  port = 6002;
  write();
  candidates = await discoverDshInstances({ home, list, probe });
  assert.equal(
    selectDshInstance(config, candidates).url,
    "http://127.0.0.1:6002",
  );
  assert.throws(
    () =>
      selectDshInstance(
        config,
        candidates.filter((x) => !x.followsRestart),
      ),
    /DSH_INSTANCE_UNAVAILABLE/,
  );
  assert.throws(
    () =>
      selectDshInstance(
        { baseUrl: "http://127.0.0.1:6001" },
        candidates,
        undefined,
        { automatic: true },
      ),
    /DSH_SELECTION_REQUIRED/,
  );
  // A stale descriptor cannot take ownership of a different process's port.
  const status = JSON.parse(
    fs.readFileSync(path.join(dir, "relay-status.json")),
  );
  status.ownerPid = 777;
  fs.writeFileSync(path.join(dir, "relay-status.json"), JSON.stringify(status));
  assert(
    !(await discoverDshInstances({ home, list, probe })).some(
      (x) => x.id === "relay:web",
    ),
  );
});
test("discovery rejects external addresses and requires both process and DSH protocol evidence", async (t) => {
  for (const url of [
    "https://example.com/",
    "http://127.0.0.1:6001/private",
    "http://x:y@localhost:6001/",
  ])
    assert.throws(() => localDshUrl(url));
  const rows = parseDshListeners(
    "p1\ncOther\nn127.0.0.1:1234\np2\ncDeepSeek Harness\nn127.0.0.1:5678\nn*:5555\n",
  );
  assert.deepEqual(rows, [{ pid: 2, url: "http://127.0.0.1:5678" }]);
  const result = await discoverDshInstances({
    home: temp(t),
    list: async () => rows,
    probe: async () => false,
  });
  assert.deepEqual(result, []);
});
