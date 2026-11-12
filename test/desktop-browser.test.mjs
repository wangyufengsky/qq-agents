import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DesktopBrowser } from "../src/home/desktop-browser.mjs";

const origin = "https://approved.example";
const first = "agent-0";
const second = "agent-1";
const navigation = { action: "navigate", url: origin + "/start" };
const observation = (text) => ({
  url: navigation.url,
  title: "Fixture",
  text,
  elements: [{ ref: "fixture-ref", kind: "link", label: "Continue" }],
});

function fixture(overrides = {}) {
  const roomEpoch = randomUUID();
  const roles = [{ id: first }, { id: second }];
  const live = {
    room: { epoch: roomEpoch },
    visits: new Map(roles.map(({ id }) => [id, {}])),
    here: () => roles.filter(({ id }) => live.visits.has(id)),
  };
  const ctxs = new Set();
  const stages = new Map();
  const optedIn = new Set([first, second]);
  const runtime = {
    config: { desktopHome: { browserControl: { enabled: true } } },
    agent: (id) => roles.find((role) => role.id === id),
    toolsFor: (agent, conversation) =>
      optedIn.has(agent.id) && conversation === "@desktop"
        ? ["desktop_browser_control"]
        : [],
    assertActive(ctx) {
      if (!ctxs.has(ctx) || ctx.controller.signal.aborted)
        throw Error("INVALID_CAPABILITY");
      return this.agent(ctx.agentId);
    },
    authorizeExternal(ctx, request) {
      assert.equal(request.tool, "desktop_browser_control");
      assert.equal(new URL(request.args.url).origin, origin);
      this.assertActive(ctx);
    },
    stageToolOutput(ctx, value, variants) {
      assert.equal(ctx.desktopPrivateObservation, true);
      stages.set(value, variants[0]);
    },
  };
  const host = {
    live,
    runtime,
    client: { id: randomUUID() },
    connected: () => Boolean(host.client),
  };
  const calls = [];
  const session = {
    async navigate(url) {
      calls.push(["navigate", url]);
      return observation("initial page");
    },
    async observe() {
      calls.push(["observe"]);
      return observation("current page");
    },
    async click(ref) {
      calls.push(["click", ref]);
      return observation("clicked page");
    },
    async fill(ref, text) {
      calls.push(["fill", ref, text]);
      return observation("filled page");
    },
    async close() {
      calls.push(["close"]);
    },
    ...overrides.session,
  };
  const driver = {
    async open(approved) {
      calls.push(["open", approved]);
      return session;
    },
    ...overrides.driver,
  };
  const browser = new DesktopBrowser(host, { driver });
  const context = (agentId = first, runtimeKind = "desktop") => {
    const ctx = {
      agentId,
      runtimeKind,
      conversation: runtimeKind === "desktop" ? "@desktop" : "private:30000",
      controller: new AbortController(),
      turnId: randomUUID(),
      inputEpoch: 1,
    };
    ctxs.add(ctx);
    return ctx;
  };
  const grant = (agentId = first, approved = origin) => {
    const value = {
      roomEpoch,
      grantId: randomUUID(),
      agentId,
      origin: approved,
    };
    browser.change("browser-grant", value);
    return value;
  };
  return { browser, context, grant, calls, stages, host, optedIn };
}

test("the browser grant restricts scope and role and fences a page result through finalization", async () => {
  const { browser, context, grant, calls, stages } = fixture();
  const selected = context();
  await assert.rejects(
    browser.run(selected, navigation),
    /DESKTOP_BROWSER_UNAVAILABLE/,
  );
  assert.throws(() => grant(first, origin + "/a"), /DESKTOP_BROWSER_DENIED/);
  grant(first, origin + "/");
  assert.deepEqual(browser.state(), {
    eligible: [first, second],
    grantedAgentId: first,
  });
  await assert.rejects(
    browser.run(context(second), navigation),
    /DESKTOP_BROWSER_UNAVAILABLE/,
  );
  await assert.rejects(
    browser.run(context(first, "qq"), navigation),
    /DESKTOP_BROWSER_UNAVAILABLE/,
  );
  await assert.rejects(
    browser.run(selected, { ...navigation, url: "https://foreign.example/" }),
    /DESKTOP_BROWSER_DENIED/,
  );
  assert.deepEqual(calls, []);
  const result = await browser.run(selected, navigation);
  assert.equal(result.source, "untrusted-public-web");
  assert.equal(result.text, "initial page");
  assert.deepEqual(calls, [
    ["open", origin],
    ["navigate", navigation.url],
  ]);
  assert.equal(stages.get(result).current(), true);
  selected.inputEpoch++;
  assert.equal(stages.get(result).current(), false);
  await browser.clear();
});

test("a new desktop turn must observe again before using an element reference", async () => {
  const { browser, context, grant, calls } = fixture();
  grant();
  const opening = context();
  await browser.run(opening, navigation);
  browser.finish(opening);

  const next = context();
  const click = { action: "click", ref: "fixture-ref" };
  const fill = { action: "fill", ref: "fixture-ref", text: "literal" };
  await assert.rejects(browser.run(next, click), /DESKTOP_BROWSER_STALE/);
  await assert.rejects(browser.run(next, fill), /DESKTOP_BROWSER_STALE/);
  await browser.run(next, { action: "observe" });
  await browser.run(next, click);
  await browser.run(next, fill);
  assert.deepEqual(await browser.run(next, { action: "close" }), {
    closed: true,
  });
  assert.deepEqual(
    calls.map(([name]) => name),
    ["open", "navigate", "observe", "click", "fill", "close"],
  );
  assert.equal(browser.state().grantedAgentId, first);
});

test("revocation fences a pending result and keeps a new grant behind process cleanup", async () => {
  const started = Promise.withResolvers();
  const late = Promise.withResolvers();
  const closing = Promise.withResolvers();
  const mayClose = Promise.withResolvers();
  let activeSignal;
  const { browser, context, grant, calls, stages } = fixture({
    session: {
      async navigate(_, signal) {
        activeSignal = signal;
        started.resolve();
        return late.promise;
      },
      async close() {
        closing.resolve();
        await mayClose.promise;
      },
    },
  });
  const previous = grant();
  const selected = context();
  const pending = browser.run(selected, navigation);
  const rejected = assert.rejects(pending, /DESKTOP_BROWSER_UNAVAILABLE/);
  await started.promise;
  await assert.rejects(
    browser.run(selected, { action: "observe" }),
    /DESKTOP_BROWSER_BUSY/,
  );
  browser.change("browser-revoke", {
    roomEpoch: previous.roomEpoch,
    grantId: previous.grantId,
  });
  assert.equal(activeSignal.aborted, true);
  await closing.promise;
  grant(second);
  const replacement = browser.run(context(second), navigation);
  await Promise.resolve();
  assert.deepEqual(calls, [["open", origin]]);
  late.resolve(observation("old pending page"));
  await rejected;
  assert.equal(selected.desktopPrivateObservation, undefined);
  assert.equal(stages.size, 0);
  mayClose.resolve();
  await replacement;
  assert.deepEqual(calls, [
    ["open", origin],
    ["open", origin],
  ]);
  await browser.clear();
});

test("close cancels a navigation waiting for the previous grant's browser cleanup", async () => {
  const closing = Promise.withResolvers();
  const mayClose = Promise.withResolvers();
  const { browser, context, grant, calls } = fixture({
    session: {
      async close() {
        closing.resolve();
        await mayClose.promise;
      },
    },
  });
  grant(first);
  await browser.run(context(first), navigation);
  grant(second);
  await closing.promise;

  const next = context(second);
  const pending = assert.rejects(
    browser.run(next, navigation),
    /DESKTOP_BROWSER_UNAVAILABLE/,
  );
  const close = browser.run(next, { action: "close" });
  mayClose.resolve();

  assert.deepEqual(await close, { closed: true });
  await pending;
  assert.deepEqual(
    calls.map(([name]) => name),
    ["open", "navigate"],
  );
  assert.equal(browser.state().grantedAgentId, second);

  await browser.run(next, navigation);
  assert.deepEqual(
    calls.map(([name]) => name),
    ["open", "navigate", "open", "navigate"],
  );
  await browser.clear();
});

test("opt-out, visit replacement and turn cancellation close the bound browser", async () => {
  const { browser, context, grant, calls, stages, host, optedIn } = fixture();
  grant();
  const old = await browser.run(context(), navigation);
  optedIn.delete(first);
  assert.deepEqual(browser.state(), {
    eligible: [second],
    grantedAgentId: null,
  });
  assert.equal(stages.get(old).current(), false);
  await browser.clear();
  assert.equal(calls.at(-1)[0], "close");

  optedIn.add(first);
  grant();
  await browser.run(context(), navigation);
  host.live.visits.set(first, {});
  assert.equal(browser.state().grantedAgentId, null);
  await browser.clear();
  assert.equal(calls.at(-1)[0], "close");

  grant();
  await browser.run(context(), navigation);
  const interrupted = context();
  interrupted.controller.abort();
  await browser.finish(interrupted);
  assert.equal(browser.state().grantedAgentId, first);
  assert.equal(calls.at(-1)[0], "close");
});
