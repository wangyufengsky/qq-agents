import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

test("a completed cognitive run refreshes the selected page and filters", async () => {
  const nodes = new Map();
  const button = { dataset: { dreamRun: "nap" } };
  const detail = {
      dataset: { dreamDetail: "0" },
      setAttribute() {},
      get nextElementSibling() {
        return get("detail-slot");
      },
    },
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
        scrollIntoView() {},
        insertAdjacentHTML() {},
        querySelectorAll: (selector) => buttons[selector] ?? [],
      });
    return nodes.get(id);
  };
  const requests = [];
  let committed = false;
  let count = 6;
  let draft = "筛选";
  let deferList;
  const api = async (url) => {
    if (url.includes("/trigger")) {
      committed = true;
      return { runId: "run", status: "QUEUED" };
    }
    if (url.includes("/overview"))
      return {
        cognitive: { enabled: true, timeoutMs: 600000 },
        imaginative: { enabled: false, timeoutMs: 45000, limit: 1 },
        used: 1,
        limit: 6,
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
      const params = new URL(url, "http://localhost").searchParams;
      requests.push(params);
      const offset = Number(params.get("offset"));
      const total = count;
      if (deferList)
        await new Promise((resolve) => {
          deferList(resolve);
          deferList = undefined;
        });
      return {
        items: Array.from(
          { length: Math.max(0, Math.min(5, total - offset)) },
          (_, i) => ({
            id: "cognition-" + (offset + i),
            content: committed ? "新认知" : "旧认知",
          }),
        ),
        total,
        nextOffset: offset + 5 < total ? offset + 5 : null,
      };
    }
    if (url.includes("/runs") && committed)
      return { items: [{ run_id: "run", mode: "nap", status: "COMMITTED" }] };
    return { items: [] };
  };
  const context = vm.createContext({
    roleId: "agent-0",
    find: () => ({ name: "示例角色" }),
    tab: "dreams",
    $: get,
    api,
    action: (fn) => fn(),
    esc: String,
    icon: () => "",
    foldOpen: () => false,
    fold: (id, title, body) =>
      `<details data-fold="${id}"><summary>${title}</summary>${body}</details>`,
    readMemory: (id, options) =>
      reads.push([id, options.agentId, options.revision]),
    URLSearchParams,
    FormData: class extends Map {
      constructor() {
        super([["query", draft]]);
      }
    },
  });
  vm.runInContext(
    fs.readFileSync(new URL("../public/dream-ui.js", import.meta.url), "utf8"),
    context,
  );
  await vm.runInContext("renderDreams()", context);
  const page = get("#content").innerHTML;
  assert.ok(page.indexOf("长期认知") < page.indexOf("最近运行"));
  assert.ok(page.indexOf("幻想梦境") < page.indexOf("梦境设置"));
  assert.match(
    get("#dream-cover-status").innerHTML,
    /认知梦已开启.*幻想梦未开启/,
  );
  assert.match(
    get("#dream-settings-summary").innerHTML,
    /认知梦 10 分钟.*幻想梦 45 秒/,
  );
  assert.match(get("#dream-pagination").innerHTML, /第 1 \/ 2 页/);
  assert.equal(get("#dream-count").textContent, "6 条");
  assert.equal(
    (get("#dream-list").innerHTML.match(/class="dream-entry"/g) || []).length,
    5,
  );
  assert.match(get("#dream-pagination").innerHTML, /id="dream-prev" disabled/);
  draft = "尚未提交";
  await get("#dream-next").onclick();
  assert.match(get("#dream-pagination").innerHTML, /第 2 \/ 2 页/);
  assert.match(get("#dream-pagination").innerHTML, /id="dream-next" disabled/);

  await button.onclick();
  assert.equal(requests.length, 3);
  assert.equal(requests.at(-1).get("offset"), "5");
  assert.equal(requests.at(-1).get("query"), "筛选");
  assert.match(get("#dream-list").innerHTML, /新认知/);
  assert.ok(requests.every((p) => p.get("limit") === "5"));
  await detail.onclick();
  assert.match(get("detail-slot").innerHTML, /新认知/);
  await source.onclick();
  assert.deepEqual(reads, [["diary", "agent-0", 2]]);
  await get("#dream-prev").onclick();
  assert.equal(requests.at(-1).get("offset"), "0");
  let release;
  deferList = (resolve) => {
    release = resolve;
  };
  const late = get("#dream-next").onclick();
  count = 1;
  await get("#dream-filters").onsubmit({ preventDefault() {} });
  await Promise.resolve();
  release();
  await late;
  assert.equal(get("#dream-count").textContent, "1 条");
  assert.equal(get("#dream-pagination").innerHTML, "");
  assert.equal(requests.at(-1).get("query"), "尚未提交");
  count = 6;
  await get("#dream-refresh").onclick();
  await get("#dream-next").onclick();
  count = 5;
  await get("#dream-refresh").onclick();
  assert.deepEqual(
    requests.slice(-2).map((p) => p.get("offset")),
    ["5", "0"],
  );
  assert.equal(get("#dream-count").textContent, "5 条");
  assert.equal(get("#dream-pagination").innerHTML, "");
});
