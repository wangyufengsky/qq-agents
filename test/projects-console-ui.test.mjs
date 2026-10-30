import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function workspace() {
  const pending = [],
    queries = [],
    nodes = new Map();
  const node = (selector) => {
    queries.push(selector);
    if (!nodes.has(selector))
      nodes.set(selector, { innerHTML: "", isConnected: true });
    return nodes.get(selector);
  };
  const root = {
    innerHTML: "",
    isConnected: true,
    querySelector: node,
    querySelectorAll: () => [],
  };
  const sandbox = vm.createContext({
    root,
    tab: "projects",
    $: () => root,
    URLSearchParams,
    api: () =>
      new Promise((resolve, reject) => pending.push({ resolve, reject })),
    action: (fn) => fn(),
    bindProjectParticipation: () => {},
    esc: (value) => String(value ?? ""),
    select: () => "",
    tag: () => "",
    conversationLabel: (value) => value,
  });
  vm.runInContext(
    fs.readFileSync(
      new URL("../public/projects-ui.js", import.meta.url),
      "utf8",
    ),
    sandbox,
  );
  return { sandbox, root, pending, queries };
}
test("a late project list cannot replace the newly selected role", async () => {
  const f = workspace();
  const a = vm.runInContext(
    "projectAgentId='agent-a'; renderProjects()",
    f.sandbox,
  );
  const b = vm.runInContext(
    "projectAgentId='agent-b'; renderProjects()",
    f.sandbox,
  );
  const list = (title) => ({
    counts: { personal: 1, shared: 0 },
    total: 1,
    nextOffset: null,
    items: [
      {
        id: title,
        title,
        why: "目标",
        status: "active",
        updatedAt: 1,
        fileCount: 0,
      },
    ],
  });
  f.pending[1].resolve(list("B 项目"));
  await b;
  const current = f.root.innerHTML;
  f.pending[0].resolve(list("A 项目"));
  await a;
  assert.equal(f.root.innerHTML, current);
  assert.ok(f.root.innerHTML.includes("B 项目"));
});
test("a failed old preview cannot bind its comparison controls to the new page", async () => {
  const f = workspace();
  f.sandbox.isActive = true;
  const promise = vm.runInContext(
    `showProjectDetail(root,'agent-a',{project:{id:'a',title:'A 项目',status:'active',updatedAt:1,steps:[]},files:[{fileId:'a',name:'a.md',readable:true},{fileId:'b',name:'b.md',readable:true}]},()=>isActive)`,
    f.sandbox,
  );
  f.sandbox.isActive = false;
  f.root.innerHTML = "B 项目";
  f.pending[0].reject(Error("FILE_NOT_FOUND"));
  await promise;
  assert.equal(f.root.innerHTML, "B 项目");
  assert.ok(!f.queries.includes("#project-compare"));
});
test("rapid historical draft selection ignores a late response for the older selection", async () => {
  const f = workspace();
  const a = vm.runInContext(
    "loadProjectDraft(root,'agent-a',{id:'a',revision:2},()=>true,1)",
    f.sandbox,
  );
  const b = vm.runInContext(
    "loadProjectDraft(root,'agent-a',{id:'a',revision:2},()=>true,2)",
    f.sandbox,
  );
  const draft = (revision, text) => ({
    version: { revision },
    draft: {
      title: "原稿",
      author: "agent",
      revision,
      text,
      offset: 0,
      totalChars: text.length,
      nextOffset: null,
    },
    history: [{ revision, progress: "保存" }],
    historyTotal: 1,
    nextHistoryOffset: null,
  });
  f.pending[1].resolve(draft(2, "新选择"));
  await b;
  const current = f.root.innerHTML;
  f.pending[0].resolve(draft(1, "旧选择"));
  await a;
  assert.equal(f.root.innerHTML, current);
  assert.ok(f.root.innerHTML.includes("新选择"));
});
