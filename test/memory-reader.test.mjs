import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { randomBytes } from "node:crypto";
import { fixture } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";

async function setup(t) {
  const f = fixture(t),
    token = randomBytes(32).toString("hex");
  const server = createServer({ runtime: f.runtime, token });
  const port = await server.listen();
  t.after(() => server.close());
  const request = (url) =>
    fetch(`http://127.0.0.1:${port}${url}`, {
      headers: { "x-admin-token": token },
    });
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id))
      nodes.set(id, {
        addEventListener() {},
        querySelectorAll: () => [],
        showModal() {
          this.open = true;
        },
      });
    return nodes.get(id);
  };
  node("#memory-agent").value = "agent-0";
  const sandbox = vm.createContext({
    document: {
      querySelector: node,
      querySelectorAll: () => [],
      body: { classList: { remove() {}, toggle() {} } },
    },
    sessionStorage: { getItem: () => "" },
    setInterval() {},
    setTimeout() {},
    clearTimeout() {},
    fetch: request,
    URLSearchParams,
    initialConfig: f.runtime.config,
  });
  vm.runInContext(
    fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8"),
    sandbox,
  );
  vm.runInContext("config = initialConfig", sandbox);
  return { ...f, request, node, sandbox };
}

test("diary reader shows plain paragraphs and appends the full long body instead of JSON chunks", async (t) => {
  const f = await setup(t);
  const body =
    "第一段\n\n" +
    "很长的日记。".repeat(1800) +
    '\n\n尾声：<img src=x onerror="alert(1)">，保留原样。';
  const d = f.store.bind("agent-0").diaryWrite({ title: "今天的日记", body });
  f.sandbox.diaryId = d.id;
  await vm.runInContext("readMemory(diaryId)", f.sandbox);
  assert.equal(f.node("#edit-title").textContent, "今天的日记");
  assert.equal(f.node("#memory-reader-body").textContent, body.slice(0, 8000));
  assert.doesNotMatch(
    f.node("#edit-fields").innerHTML,
    /json-text-chunk|<pre|onerror/,
  );
  assert.equal(f.node("#memory-read-more").hidden, false);
  await f.node("#memory-read-more").onclick();
  assert.equal(f.node("#memory-reader-body").textContent, body);
  assert.equal(f.node("#memory-read-more").hidden, true);
  assert.equal(f.node("#memory-read-progress").textContent, "正文已全部显示");
});

test("human record pages pin diary revisions and keep account isolation and model read compatibility", async (t) => {
  const f = await setup(t),
    m = f.store.bind("agent-0");
  const body = "旧版本\n" + "甲".repeat(9000);
  const d = m.diaryWrite({ title: "旧标题", body });
  const view = async (params) => {
    const response = await f.request(
      "/api/memory/view?" +
        new URLSearchParams({ agentId: "agent-0", id: d.id, ...params }),
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  const first = await view({});
  assert.equal(first.revision, 1);
  assert.equal(first.body, body.slice(0, 8000));
  m.diaryRevise({
    id: d.id,
    expectedRevision: 1,
    title: "新标题",
    body: "新版正文",
  });
  const second = await view({
    offset: first.nextOffset,
    revision: first.revision,
  });
  assert.equal(first.body + second.body, body);
  assert.equal(second.revision, 1);
  assert.equal(second.latestRevision, 2);
  assert.equal((await view({})).body, "新版正文");
  const wrong = await f.request(
    "/api/memory/view?" +
      new URLSearchParams({ agentId: "agent-1", id: d.id, revision: 1 }),
  );
  assert.notEqual(wrong.status, 200);
  const toolRecord = m.read({ id: d.id });
  assert.equal(toolRecord.format, "json-text-chunk");
  assert.equal(JSON.parse(toolRecord.chunk).body, "新版正文");
  f.sandbox.diaryId = d.id;
  await vm.runInContext("readMemory(diaryId)", f.sandbox);
  assert.equal(f.node("#memory-reader-body").textContent, "新版正文");
  await f.node("#memory-previous-version").onclick();
  assert.equal(f.node("#edit-title").textContent, "旧标题");
  assert.equal(f.node("#memory-reader-body").textContent, body.slice(0, 8000));
  assert.equal(f.node("#memory-previous-version").disabled, true);
});

test("experience records also render readable text, and late responses cannot replace a newer record", async (t) => {
  const f = await setup(t),
    m = f.store.bind("agent-0");
  const event = m.append({
    dedupe: "reader-event",
    kind: "message.received",
    conversation: "group:20000",
    body: "消息正文\n第二行",
    senderId: "30000",
  });
  f.sandbox.recordId = event.id;
  await vm.runInContext("readMemory(recordId)", f.sandbox);
  assert.equal(f.node("#memory-reader-body").textContent, "消息正文\n第二行");
  assert.equal(f.node("#memory-version-controls").hidden, true);
  let release;
  f.sandbox.fetch = async (url) => {
    if (url.includes("slow-record"))
      return new Promise((resolve) => {
        release = () =>
          resolve({
            ok: true,
            json: async () => ({
              id: "slow-record",
              type: "diary",
              title: "过时结果",
              body: "旧请求",
              revision: 1,
              latestRevision: 1,
              nextOffset: null,
            }),
          });
      });
    return f.request(url);
  };
  const slow = vm.runInContext("readMemory('slow-record')", f.sandbox);
  await vm.runInContext("readMemory(recordId)", f.sandbox);
  release();
  await slow;
  assert.equal(f.node("#memory-reader-body").textContent, "消息正文\n第二行");
});
