import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createNativeDesktopDriver } from "../desktop/home/native-desktop-driver.mjs";

const claimed = { beforeDispatch: async () => true };

const fixture = String.raw`
  import { appendFileSync, readFileSync } from "node:fs";
  const [state, events, platform, command, ...args] = process.argv.slice(2);
  const opts = JSON.parse(readFileSync(state, "utf8"));
  const base = {
    id: "w-47", pid: 19, process_instance: "instance-1",
    title: "Disposable App Window", app_name: "--Test App", accessible: true,
  };
  let data, error;
  const isAction = ["click", "set-value", "scroll"].includes(command);
  const input = command === "set-value" ? readFileSync(0, "utf8") : undefined;
  appendFileSync(events, JSON.stringify({
    command, args, input, root: process.env.AGENT_DESKTOP_HOME,
    credentialsPresent: Object.hasOwn(process.env, "NATIVE_TEST_SECRET"),
  }) + "\n");
  switch (command) {
    case "version":
      data = { version: opts.version ?? "1.2.0", os: platform };
      break;
    case "permissions":
      data = { accessibility: { state: opts.accessibility ?? "granted" } };
      break;
    case "list-apps":
      data = { apps: [
        { name: base.app_name, pid: base.pid, process_instance: base.process_instance, presentation: "foreground" },
        { name: "Background", pid: 52, process_instance: "background", presentation: "background" },
        { name: "Invalid", pid: 0, presentation: "foreground" },
      ] };
      break;
    case "list-windows":
      data = opts.closed ? [] : [{ ...base, visible: opts.visible,
        minimized: opts.minimized, process_instance: opts.instance ?? base.process_instance }];
      if (opts.duplicate) data.push({ ...base, pid: 22 });
      break;
    case "snapshot":
      data = {
        app: base.app_name, window: { id: opts.snapshotWindow ?? base.id },
        snapshot_id: "s1", complete: opts.complete ?? true,
        identity_unproven: opts.identityUnproven,
        tree: {
          role: "window",
          children: [
            { role: "button", name: "Click", ref_id: "@s1:e1" },
            { role: "textfield", name: "Text", value: "PRIVATE VALUE", ref_id: "@s1:e2" },
            { role: "textfield", name: "PRIVATE LABEL", states: ["secure"], ref_id: "@s1:e3" },
            { role: "scrollarea", name: "Scroll", ref_id: "@s1:e4" },
            ...Array.from({ length: opts.moreElements ?? 0 }, (_, index) => ({
              role: "button", name: "X".repeat(300), ref_id: "@s1:e" + (index + 5),
            })),
          ],
        },
      };
      break;
    case "get":
      data = { ref: args[0], property: "states", value: opts.secureNow ? ["secure"] : [] };
      break;
    default:
      if (!isAction) throw Error("Unexpected command");
      if (opts.block) await new Promise((resolve) => setTimeout(resolve, 5000));
      if (opts.outputFlood) {
        process.stdout.write("x".repeat(1200000));
        break;
      }
      if (opts.actionError) {
        error = {
          code: opts.actionError, message: "PRIVATE PROVIDER ERROR",
          disposition: { delivery: opts.errorDelivery ?? "not_delivered" },
        };
      } else {
        data = { disposition: { delivery: "delivered_unverified" }, post_state: { value: input } };
      }
  }
  process.stdout.write(JSON.stringify({ version: "2.6", command, ok: !error, data, error }));
  if (error) process.exitCode = 1;
`;

async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "qq-native-test-"));
  const binary = join(directory, "fake.mjs");
  const settings = join(directory, "settings.json");
  const events = join(directory, "events.jsonl");
  const stateParent = join(directory, "states");
  await mkdir(stateParent);
  await writeFile(binary, fixture);
  const configure = (value = {}) => writeFile(settings, JSON.stringify(value));
  await configure();
  const platform = options.platform ?? "darwin";
  const executable = join(directory, "agent-desktop.exe");
  await writeFile(executable, "synthetic pinned executable");
  const driver = createNativeDesktopDriver({
    executable,
    platform,
    timeoutMs: 1100,
    stateParent,
    parentEnv: { ...process.env, NATIVE_TEST_SECRET: "dummy" },
    ...options,
    spawnProcess(executable, args, spawnOptions) {
      assert.equal(executable, join(directory, "agent-desktop.exe"));
      assert.equal(spawnOptions.shell, false);
      return spawn(
        process.execPath,
        [
          binary,
          settings,
          events,
          platform === "win32" ? "windows" : "macos",
          ...args,
        ],
        spawnOptions,
      );
    },
  });
  t.after(async () => {
    await driver.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    driver,
    configure,
    executable,
    stateParent,
    async events() {
      return (await readFile(events, "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
    },
  };
}

test("native observation reads fresh validity and permission without rechecking an unchanged binary", async (t) => {
  const f = await setup(t);
  await f.configure({ visible: true });
  const [target] = await f.driver.observationWindows();
  assert.deepEqual(target, {
    id: "w-47",
    pid: 19,
    processInstance: "instance-1",
    app: "--Test App",
    state: "ready",
  });
  await f.configure({ visible: false, minimized: true });
  assert.deepEqual(await f.driver.observationWindows({ app: target.app }), [
    { ...target, state: "minimized" },
  ]);
  await f.configure({ visible: false });
  assert.deepEqual(await f.driver.observationWindows({ app: target.app }), [
    { ...target, state: "unavailable" },
  ]);
  await f.configure({ closed: true });
  assert.deepEqual(await f.driver.observationWindows({ app: target.app }), []);
  await f.configure({ duplicate: true, visible: true });
  assert.deepEqual(await f.driver.observationWindows({ app: target.app }), []);
  await f.configure({ accessibility: "denied", visible: true });
  await assert.rejects(
    f.driver.observationWindows(),
    /DESKTOP_NATIVE_PERMISSION/,
  );
  const events = await f.events();
  assert.equal(events.filter(({ command }) => command === "version").length, 1);
  assert.equal(
    events.filter(({ command }) => command === "permissions").length,
    6,
  );
  assert.equal(new Set(events.map(({ root }) => root)).size, 1);
  await writeFile(f.executable, "replacement binary");
  await f.configure({ version: "1.1.0", visible: true });
  await assert.rejects(f.driver.observationWindows(), /DESKTOP_NATIVE_VERSION/);
  await f.driver.close();
  assert.deepEqual(await readdir(f.stateParent), []);
});

for (const platform of ["darwin", "win32"]) {
  test(
    platform +
      " binds reads to the selected window and only passes text on stdin",
    async (t) => {
      const f = await setup(t, { platform });
      const [target] = await f.driver.listWindows();
      assert.equal(target.processInstance, "instance-1");
      assert.deepEqual(await readdir(f.stateParent), []);
      const scope = f.driver.open(target);
      const { elements } = await scope.observe();
      const serialized = JSON.stringify(elements);
      assert.doesNotMatch(serialized, /PRIVATE|@s1/);
      const text = "--headed\n你好 $HOME";
      const ref = elements.find((item) => item.label === "Text").ref;
      assert.deepEqual(
        await scope.act({ type: "set-value", ref, text }, claimed),
        {
          ok: true,
          delivery: "delivered_unverified",
        },
      );
      await assert.rejects(
        scope.act({ type: "click", ref }),
        /DESKTOP_NATIVE_STALE/,
      );
      const events = await f.events();
      assert.ok(events.every((event) => !event.credentialsPresent));
      const observation = events.find((event) => event.command === "snapshot");
      assert.deepEqual(observation.args, [
        "--app=--Test App",
        "--window-id",
        "w-47",
        "--surface",
        "window",
      ]);
      const action = events.find((event) => event.command === "set-value");
      assert.deepEqual(action.args, ["@s1:e2", "--stdin"]);
      assert.equal(action.input, text);
      assert.equal(action.root, observation.root);
      assert.notEqual(action.root, events[0].root);
      await scope.close();
      assert.deepEqual(await readdir(f.stateParent), []);
    },
  );
}

test("rejects unsupported versions and ambiguous or changed target observations", async (t) => {
  const f = await setup(t);
  await f.configure({ version: "1.1.0" });
  await assert.rejects(f.driver.listWindows(), /DESKTOP_NATIVE_VERSION/);
  await f.configure({ duplicate: true });
  assert.deepEqual(await f.driver.listWindows(), []);
  await f.configure();
  const [target] = await f.driver.listWindows();
  const scope = f.driver.open(target);
  await f.configure({ complete: false });
  await assert.rejects(scope.observe(), /DESKTOP_NATIVE_AMBIGUOUS/);
  await f.configure({ identityUnproven: true });
  await assert.rejects(scope.observe(), /DESKTOP_NATIVE_AMBIGUOUS/);
  await f.configure({ snapshotWindow: "w-48" });
  await assert.rejects(scope.observe(), /DESKTOP_NATIVE_TARGET_CHANGED/);
  await f.configure();
  const { elements } = await scope.observe();
  const ref = elements.find((item) => item.label === "Click").ref;
  await f.configure({ instance: "instance-2" });
  await assert.rejects(
    scope.act({ type: "click", ref }),
    /DESKTOP_NATIVE_TARGET_CHANGED/,
  );
  assert.ok((await f.events()).every((event) => event.command !== "click"));
});

test("macOS can enumerate only the application selected from a fresh native inventory", async (t) => {
  const f = await setup(t);
  const apps = await f.driver.listApplications();
  assert.deepEqual(apps, [
    { app: "--Test App", pid: 19, processInstance: "instance-1" },
  ]);
  const windows = await f.driver.listWindows({ application: apps[0] });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].title, "Disposable App Window");
  const enumeration = (await f.events()).filter(
    ({ command }) => command === "list-windows",
  );
  assert.deepEqual(enumeration.at(-1).args, ["--app=--Test App"]);
  await f.configure({ instance: "replaced-process" });
  assert.deepEqual(await f.driver.listWindows({ application: apps[0] }), []);
  await f.configure({ accessibility: "denied" });
  await assert.rejects(
    f.driver.listApplications(),
    /DESKTOP_NATIVE_PERMISSION/,
  );
});

test("rejects foreign references and a control that becomes secure before dispatch", async (t) => {
  const f = await setup(t);
  const [target] = await f.driver.listWindows();
  const a = f.driver.open(target);
  const b = f.driver.open(target);
  const first = (await a.observe()).elements.find(
    (item) => item.label === "Text",
  ).ref;
  const second = (await b.observe()).elements.find(
    (item) => item.label === "Text",
  ).ref;
  await assert.rejects(
    b.act({ type: "click", ref: first }),
    /DESKTOP_NATIVE_STALE/,
  );
  await f.configure({ secureNow: true });
  await assert.rejects(
    b.act({ type: "set-value", ref: second, text: "hello" }),
    /DESKTOP_NATIVE_UNSUPPORTED/,
  );
  assert.ok(
    (await f.events()).every(
      (event) => event.command !== "set-value" && event.command !== "click",
    ),
  );
});

test("reports only a safe receipt after ambiguous or uncertain native responses", async (t) => {
  const f = await setup(t);
  const [target] = await f.driver.listWindows();
  const scope = f.driver.open(target);
  async function click() {
    const { elements } = await scope.observe();
    const ref = elements.find((item) => item.label === "Click").ref;
    return scope.act({ type: "click", ref }, claimed);
  }
  await f.configure({ actionError: "AMBIGUOUS_TARGET" });
  assert.deepEqual(await click(), {
    ok: false,
    delivery: "not_delivered",
    code: "DESKTOP_NATIVE_AMBIGUOUS",
  });
  await f.configure({
    actionError: "PRIVATE_CODE",
    errorDelivery: "delivery_uncertain",
  });
  assert.deepEqual(await click(), {
    ok: false,
    delivery: "delivery_uncertain",
    code: "DESKTOP_NATIVE_FAILED",
  });
  await f.configure({ outputFlood: true });
  assert.deepEqual(await click(), {
    ok: false,
    delivery: "unknown",
    code: "DESKTOP_NATIVE_OUTPUT_LIMIT",
  });
  assert.equal(
    (await f.events()).filter((event) => event.command === "click").length,
    3,
  );
});

test("revocation waits for the child to exit and never retries a dispatched action", async (t) => {
  const f = await setup(t, { timeoutMs: 3000 });
  const [target] = await f.driver.listWindows();
  const scope = f.driver.open(target);
  const { elements } = await scope.observe();
  const ref = elements.find((item) => item.label === "Scroll").ref;
  await f.configure({ block: true });
  const action = scope.act(
    {
      type: "scroll",
      ref,
      direction: "down",
      amount: 3,
    },
    claimed,
  );
  for (let attempt = 0; attempt < 80; attempt++) {
    if ((await f.events()).some((event) => event.command === "scroll")) break;
    await delay(15);
  }
  await assert.rejects(f.driver.listWindows(), /DESKTOP_NATIVE_BUSY/);
  await scope.close();
  assert.deepEqual(await action, {
    ok: false,
    delivery: "unknown",
    code: "DESKTOP_NATIVE_CANCELLED",
  });
  const events = (await f.events()).filter(
    (event) => event.command === "scroll",
  );
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].args, [
    "@s1:e4",
    "--direction",
    "down",
    "--amount",
    "3",
  ]);
  assert.deepEqual(await readdir(f.stateParent), []);
  await assert.rejects(scope.observe(), /DESKTOP_NATIVE_CANCELLED/);
});

test("a timeout after spawning reports unknown and invalidates the reference", async (t) => {
  const f = await setup(t, { timeoutMs: 700 });
  const [target] = await f.driver.listWindows();
  const scope = f.driver.open(target);
  const { elements } = await scope.observe();
  const ref = elements.find((item) => item.label === "Click").ref;
  await f.configure({ block: true });
  assert.deepEqual(await scope.act({ type: "click", ref }, claimed), {
    ok: false,
    delivery: "unknown",
    code: "DESKTOP_NATIVE_TIMEOUT",
  });
  await assert.rejects(
    scope.act({ type: "click", ref }),
    /DESKTOP_NATIVE_STALE/,
  );
  assert.equal(
    (await f.events()).filter((event) => event.command === "click").length,
    1,
  );
});

test("caps the returned element count and label length and reports truncation", async (t) => {
  const f = await setup(t);
  const [target] = await f.driver.listWindows();
  const scope = f.driver.open(target);
  await f.configure({ moreElements: 57 });
  const atLimit = await scope.observe();
  assert.equal(atLimit.elements.length, 60);
  assert.equal(atLimit.truncated, false);
  assert.equal(atLimit.elements.at(-1).label.length, 240);
  await f.configure({ moreElements: 58 });
  const overLimit = await scope.observe();
  assert.equal(overLimit.elements.length, 60);
  assert.equal(overLimit.truncated, true);
});

test("a denied last-moment claim never starts the mutating command", async (t) => {
  const f = await setup(t);
  const [target] = await f.driver.listWindows();
  const scope = f.driver.open(target);
  const { elements } = await scope.observe();
  const ref = elements.find((item) => item.label === "Click").ref;
  let checked = false;
  const result = await scope.act(
    { type: "click", ref },
    {
      async beforeDispatch() {
        checked = (await f.events()).at(-1).command === "get";
        return false;
      },
    },
  );
  assert(checked);
  assert.deepEqual(result, {
    ok: false,
    delivery: "not_delivered",
    code: "DESKTOP_NATIVE_CANCELLED",
  });
  assert(!(await f.events()).some(({ command }) => command === "click"));
  await scope.close();
});
