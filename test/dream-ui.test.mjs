import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

test("a completed cognitive run refreshes the selected page and filters", async () => {
  const nodes = new Map();
  const button = { dataset: { dreamRun: "nap" } };
  const detail = { dataset: { dreamDetail: "0" } },
    source = { dataset: { dreamSource: "0" } };
  const reads = [];
  const buttons = {
    "[data-dream-run]": [button],
    "[data-dream-detail]": [detail],
    "[data-dream-source]": [source],
  };
  const get = (id) => {
    if (!nodes.has(id))
      nodes.set(id, {
        contains: () => true,
        replaceChildren() {},
        insertAdjacentHTML() {},
        querySelectorAll: (selector) => buttons[selector] ?? [],
      });
    return nodes.get(id);
  };
  const requests = [];
  let committed = false;
  const api = async (url) => {
    if (url.includes("/trigger")) {
      committed = true;
      return { runId: "run", status: "QUEUED" };
    }
    if (url.includes("/overview"))
      return {
        cognitive: { enabled: true },
        imaginative: { enabled: false },
        lag: {},
      };
    if (url.includes("/revisions?"))
      return {
        cognition: { content: "新认知", version: 1 },
        items: [{ version: 1, after_json: '{"content":"新认知"}' }],
        evidence: [
          {
            source_type: "diary",
            source_id: "diary",
            source_revision: 2,
            cognition_version: 1,
          },
        ],
      };
    if (url.includes("/cognitions")) {
      requests.push(new URL(url, "http://localhost").searchParams);
      return {
        items: committed ? [{ id: "cognition", content: "新认知" }] : [],
        nextOffset: 20,
      };
    }
    if (url.includes("/runs") && committed)
      return { items: [{ run_id: "run", mode: "nap", status: "COMMITTED" }] };
    return { items: [] };
  };
  const context = vm.createContext({
    roleId: "agent-0",
    tab: "dreams",
    $: get,
    api,
    action: (fn) => fn(),
    esc: String,
    readMemory: (id, options) =>
      reads.push([id, options.agentId, options.revision]),
    URLSearchParams,
    FormData: class extends Map {
      constructor() {
        super([["query", "筛选"]]);
      }
    },
  });
  vm.runInContext(
    fs.readFileSync(new URL("../public/dream-ui.js", import.meta.url), "utf8"),
    context,
  );
  await vm.runInContext("renderDreams()", context);
  await get("#dream-next").onclick();
  await button.onclick();
  assert.equal(requests.length, 3);
  assert.equal(requests.at(-1).get("offset"), "20");
  assert.equal(requests.at(-1).get("query"), "筛选");
  assert.match(get("#dream-list").innerHTML, /新认知/);
  await detail.onclick();
  await source.onclick();
  assert.deepEqual(reads, [["diary", "agent-0", 2]]);
});
