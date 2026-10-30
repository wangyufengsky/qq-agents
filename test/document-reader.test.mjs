import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { randomBytes } from "node:crypto";
import { fixture } from "./helpers.mjs";
import { readFileText } from "../src/tools/file-text.mjs";
import { FileStore } from "../src/tools/files.mjs";
import path from "node:path";
import { createServer } from "../src/server.mjs";

async function setup(t) {
  const f = fixture(t),
    token = randomBytes(32).toString("hex");
  f.runtime.files = new FileStore(path.join(f.root, "files"));
  const server = createServer({ runtime: f.runtime, token });
  const port = await server.listen();
  t.after(() => server.close());
  const request = (route, auth = true) =>
    fetch(`http://127.0.0.1:${port}${route}`, {
      headers: auth ? { "x-admin-token": token } : {},
    });
  const put = (name, text, agentId = "agent-0") =>
    f.runtime.files.put(
      agentId,
      Buffer.isBuffer(text) ? text : Buffer.from(text),
      name,
      f.runtime.agent(agentId).files,
      { kind: "generated-text", conversation: "@subject" },
    );
  return { ...f, request, put };
}
test("administrator reads immutable UTF-8 pages, searches the whole file, and follows project links", async (t) => {
  const f = await setup(t);
  const text =
    "字".repeat(511) + "🐟👍🏽👨‍👩‍👧‍👦🇨🇳" + "后文".repeat(600) + "最后的关键词";
  const file = f.put("story.md", text);
  const p = f.store
    .bind("agent-0")
    .identity.saveProject(
      { title: "一起写故事", why: "留下原稿", files: [file.fileId] },
      { writtenIn: "@subject", now: Date.now() },
    );
  const url = `/api/files/read?agentId=agent-0&fileId=${file.fileId}&maxChars=512`;
  assert.equal((await f.request(url, false)).status, 401);
  let offset = 0,
    whole = "";
  do {
    const result = await (await f.request(url + `&offset=${offset}`)).json();
    assert.equal(result.projects[0].id, p.id);
    assert.ok(!result.text.includes("�"));
    whole += result.text;
    offset = result.nextOffset;
  } while (offset !== null);
  assert.equal(whole, text);
  const found = await (
    await f.request(url + "&query=" + encodeURIComponent("最后的关键词"))
  ).json();
  assert.deepEqual(found.matches, [text.indexOf("最后的关键词")]);
  const work = await (
    await f.request(`/api/project/files?agentId=agent-0&id=${p.id}`)
  ).json();
  assert.equal(work.files[0].fileId, file.fileId);
  assert.equal(work.files[0].readable, true);
  assert.deepEqual(f.store.bind("agent-0").identity.project(p.id), p);
  assert.equal(
    f.runtime.files.read("agent-0", file.fileId, 10000).buffer.toString(),
    text,
  );
  assert.ok(!(await f.request(url.replace("agent-0", "agent-1"))).ok);
  assert.ok(
    !(await f.request(`/api/project/files?agentId=agent-1&id=${p.id}`)).ok,
  );
});
test("Markdown code context survives page boundaries and search jumps", async (t) => {
  const f = await setup(t);
  const text = "```js\n" + "code\n".repeat(180) + "```\n# prose";
  const file = f.put("code.md", text);
  const read = async (offset) =>
    (
      await f.request(
        `/api/files/read?agentId=agent-0&fileId=${file.fileId}&offset=${offset}&maxChars=512`,
      )
    ).json();
  const first = await read(0);
  assert.equal(first.codeFence, false);
  assert.equal((await read(first.nextOffset)).codeFence, true);
  assert.equal((await read(text.indexOf("# prose"))).codeFence, false);
  const fence = await read(text.lastIndexOf("```") + 1);
  assert.ok(fence.text.startsWith("```"));
  assert.equal(fence.codeFence, true);
});
test("paging preserves leading blank lines and every grapheme at the candidate boundary", async (t) => {
  const f = await setup(t);
  for (const emoji of ["👍🏽", "👨‍👩‍👧‍👦", "🇨🇳", "1️⃣"]) {
    const text = "a".repeat(510) + emoji + "z".repeat(600);
    const file = f.put("boundary.txt", text);
    const first = readFileText(f.runtime.files, "agent-0", file.fileId, {
      maxChars: 512,
    });
    assert.equal(first.text.length, 510);
    const second = readFileText(f.runtime.files, "agent-0", file.fileId, {
      offset: first.nextOffset,
      maxChars: 512,
    });
    assert.ok(second.text.startsWith(emoji));
  }
  const text = "\n```js\n" + "value\n".repeat(200) + "```\n";
  const file = f.put("leading.md", text);
  let offset = 0,
    result = "";
  do {
    const page = readFileText(f.runtime.files, "agent-0", file.fileId, {
      offset,
      maxChars: 512,
    });
    result += page.text;
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(result, text);
});
test("preview rejects binary, invalid UTF-8, unsafe paging and modified file bytes", async (t) => {
  const f = await setup(t);
  for (const [name, bytes] of [
    ["blob.pdf", "text"],
    ["nul.txt", "a\0b"],
    ["bad.md", Buffer.from([0xff, 0xfe])],
  ]) {
    const file = f.put(name, bytes);
    const r = await f.request(
      `/api/files/read?agentId=agent-0&fileId=${file.fileId}`,
    );
    assert.equal((await r.json()).error, "FILE_NOT_TEXT");
  }
  const file = f.put("test.txt", "original");
  for (const suffix of [
    "offset=-1",
    "offset=NaN",
    "maxChars=1",
    "maxChars=99999",
  ])
    assert.ok(
      !(
        await f.request(
          `/api/files/read?agentId=agent-0&fileId=${file.fileId}&${suffix}`,
        )
      ).ok,
    );
  fs.writeFileSync(
    `${f.runtime.files.dir("agent-0")}/${file.fileId}.bin`,
    "modified",
  );
  assert.ok(
    !(await f.request(`/api/files/read?agentId=agent-0&fileId=${file.fileId}`))
      .ok,
  );
});
test("Markdown renders common documents without interpreting source HTML or loading images", () => {
  const sandbox = vm.createContext({
    esc: (s) =>
      String(s).replace(
        /[&<>"']/g,
        (c) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[c],
      ),
  });
  vm.runInContext(
    fs.readFileSync(
      new URL("../public/document-reader.js", import.meta.url),
      "utf8",
    ),
    sandbox,
  );
  const render = (text) => {
    sandbox.input = text;
    return vm.runInContext("documentMarkdown(input)", sandbox);
  };
  const html = render(
    '# 标题\n- **条目**\n\n| 一 | 二 |\n| --- | --- |\n| 值 | 值 |\n```\n<script>alert(1)</script>\n```\n<img src=x onerror=alert(1)>\n![远程](https://example.com/a.png)\n[危险](javascript:alert(1))\n[安全](https://example.com/?x="onclick="bad)',
  );
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<li><strong>条目<\/strong><\/li>/);
  assert.match(html, /<table>/);
  assert.ok(!/<script|<img|href="javascript:|href="[^"]*"onclick=/.test(html));
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /&lt;script&gt;/);
  sandbox.input = "# still code\n```\n# Back to prose";
  const continuation = vm.runInContext(
    "documentMarkdown(input, {codeFence:true})",
    sandbox,
  );
  assert.match(
    continuation,
    /<pre><code># still code<\/code><\/pre><h1>Back to prose<\/h1>/,
  );
});
