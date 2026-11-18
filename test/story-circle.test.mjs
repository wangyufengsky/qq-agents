import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createServer } from "../src/server.mjs";
import { config, context, fixture } from "./helpers.mjs";

const payload = (kind, fields) => ({
  ...fields,
  kind,
  requestId: randomUUID(),
});

test("an idle AI opens a book, people and peers add text, and the opener publishes the reviewed version", async (t) => {
  const cfg = config(3);
  cfg.agents.forEach((agent, i) => {
    agent.subject.enabled = true;
    if (i < 2) agent.tools.push("story_circle");
  });
  let next,
    check,
    openings = 0;
  const { runtime } = fixture(t, {
    cfg,
    run: async ({ tools, prompt, callTool }) => {
      openings++;
      check = (async () => {
        assert.ok(tools.some((tool) => tool.name === "story_circle"));
        assert.match(prompt, /story_circle/);
        return next((kind, args = {}) =>
          callTool("story_circle", { kind, ...args }),
        );
      })();
      await check;
    },
  });
  async function subject(agentId, action) {
    next = action;
    const before = openings;
    await runtime.wake(agentId, "@subject");
    assert.equal(openings, before + 1);
    return check;
  }
  const token = randomUUID();
  const server = createServer({ runtime, token, allowLive: true });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${await server.listen()}/api/home-stories`;
  const http = async (payload, headers = {}) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-admin-token": token,
        "content-type": "application/json",
        connection: "close",
        ...headers,
      },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  };

  assert.equal(
    (
      await http(
        { kind: "list", shelf: "writing" },
        { "x-admin-token": "invalid" },
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await http(
        { kind: "list", shelf: "writing" },
        { origin: "https://example.test" },
      )
    ).status,
    403,
  );
  assert.equal(
    (await http({ kind: "list", shelf: "writing", author: "agent-0" })).status,
    400,
  );
  for (const [id, scope] of [
    ["agent-2", "@subject"],
    ["agent-0", "private:30000"],
  ]) {
    await assert.rejects(
      runtime.callTool(context(runtime, id, scope), "story_circle", {
        kind: "list",
        shelf: "writing",
      }),
      /TOOL_DISABLED/,
    );
  }

  const first = payload("open", {
    title: "湿漉漉的还书口",
    text: "打烊后，还书口掉出了一本湿书。",
  });
  const { bookId, id: paragraphId } = await subject("agent-0", async (act) => {
    const opened = await act("open", first);
    assert.deepEqual(await act("open", first), opened);
    const different = { ...first, text: "另一段开头" };
    await assert.rejects(
      () => act("open", different),
      /STORY_REQUEST_CONFLICT/,
    );
    return opened;
  });
  const stale = payload("append", {
    bookId,
    revision: 1,
    text: "你听见书页里有雨。",
  });
  assert.equal((await http(stale)).status, 200);
  assert.equal((await http(stale)).body.revision, 2);
  assert.equal(
    (await http({ ...stale, requestId: randomUUID() })).body.error,
    "STORY_REVISION_CONFLICT",
  );

  const note = (
    await http(
      payload("annotate", { bookId, paragraphId, text: "她认得这本书吗？" }),
    )
  ).body;
  const read = await http({ kind: "read", bookId });
  assert.equal(read.body.revision, 2);
  assert.equal(read.body.paragraphs[0].noteCount, 1);
  assert.equal(read.body.mine, false);

  const endingId = await subject("agent-1", async (act) => {
    await assert.rejects(
      () =>
        act(
          "withdraw_note",
          payload("withdraw_note", {
            bookId,
            paragraphId,
            noteId: note.id,
            revision: 1,
          }),
        ),
      /STORY_WRITE_DENIED/,
    );
    const revision = (await act("read", { bookId })).revision;
    const ending = await act(
      "ending",
      payload("ending", { bookId, revision, text: "她合上书，雨停了。" }),
    );
    return ending.id;
  });
  const finish = {
    bookId,
    revision: 2,
    endingId,
    title: "还书日",
    synopsis: "一场从书里飘出来的雨。",
  };
  assert.equal((await http(payload("publish", finish))).status, 403);
  const newText = await http(
    payload("append", { bookId, revision: 2, text: "她翻开最后一页。" }),
  );
  assert.equal(newText.body.revision, 3);

  await subject("agent-0", async (act) => {
    await assert.rejects(
      () => act("publish", payload("publish", finish)),
      /STORY_REVISION_CONFLICT/,
    );
    const updated = await act("read", { bookId });
    assert.equal(updated.endings[0].revision, 2);
    assert.equal(updated.revision, 3);
    const publish = payload("publish", {
      ...finish,
      revision: updated.revision,
    });
    const saved = await act("publish", publish);
    assert.deepEqual(await act("publish", publish), saved);
  });
  assert.equal(
    (await http(payload("append", { ...stale, revision: 4 }))).body.error,
    "STORY_PUBLISHED",
  );
  for (const query of ["还书日", "角色1"]) {
    const library = await http({ kind: "list", shelf: "library", query });
    assert.deepEqual(
      library.body.items.map(({ id }) => id),
      [bookId],
    );
  }
  assert.equal(
    (await http({ kind: "list", shelf: "writing" })).body.items.length,
    0,
  );
  const published = (await http({ kind: "read", bookId })).body;
  assert.deepEqual(published.authors, ["角色0", "你", "角色1"]);
  assert.equal(published.paragraphs.at(-1).text, "她合上书，雨停了。");
  assert.equal(
    (
      await http(
        payload("edit_note", {
          bookId,
          paragraphId,
          noteId: note.id,
          revision: 1,
          text: "重读时看懂了。",
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await http(
        payload("annotate", { bookId, paragraphId, text: "封面也在下雨。" }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await http(
        payload("withdraw_note", {
          bookId,
          paragraphId,
          noteId: note.id,
          revision: 2,
        }),
      )
    ).status,
    200,
  );
  const notes = (await http({ kind: "notes", bookId, paragraphId })).body;
  assert.deepEqual(
    notes.items.map(({ text }) => text),
    ["封面也在下雨。"],
  );
  const after = (await http({ kind: "read", bookId })).body;
  assert.equal(after.publishedAt, published.publishedAt);
  assert.deepEqual(after.paragraphs, published.paragraphs);

  const agentCtx = context(runtime, "agent-0", "@subject");
  await assert.rejects(
    runtime.callTool(
      agentCtx,
      "story_circle",
      payload("open", { title: "安全测试", text: agentCtx.token }),
    ),
    /CAPABILITY_EXFILTRATION_BLOCKED/,
  );
  agentCtx.privateRead.add("protected:unknown-story-origin");
  await assert.rejects(
    runtime.callTool(
      agentCtx,
      "story_circle",
      payload("open", { title: "安全测试", text: "不应写入。" }),
    ),
    /HOME_SOURCE_DENIED/,
  );
});
