import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createFrameworkConnection } from "../desktop/home/framework-connection.mjs";

const initialToken = "a".repeat(64);
const replacementToken = "b".repeat(64);

async function setup(t, listenPort) {
  const root = await mkdtemp(join(tmpdir(), "desktop-connection-"));
  const connection = createFrameworkConnection(root, listenPort);
  t.after(async () => {
    connection.close();
    await rm(root, { recursive: true, force: true });
  });
  const replace = async (name, data) => {
    const path = join(root, name);
    await writeFile(path + ".next", data);
    await rename(path + ".next", path);
  };
  return { connection, replace };
}

async function waitForConnection(connection, predicate) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const credentials = await connection.get();
    if (predicate(credentials)) return credentials;
    if (Date.now() >= deadline) throw Error("DESKTOP_TEST_WATCH_TIMEOUT");
    await delay(20);
  }
}

test("desktop connection shares asynchronous reads and reloads atomic replacements", async (t) => {
  const { connection, replace } = await setup(t);
  await replace("config.json", JSON.stringify({ port: 4123 }));
  await replace("desktop-home-token", initialToken);
  const [first, concurrent] = await Promise.all([
    connection.get(),
    connection.get(),
  ]);
  assert.deepEqual(first, { port: 4123, token: initialToken });
  assert.equal(concurrent, first);
  assert.equal(await connection.get(), first);

  await replace("desktop-home-token", replacementToken + "\n");
  const rotated = await waitForConnection(
    connection,
    (value) => value.token === replacementToken,
  );
  assert.equal(rotated.port, 4123);
  await replace("config.json", JSON.stringify({ port: 4321 }));
  const moved = await waitForConnection(
    connection,
    (value) => value.port === 4321,
  );
  assert.equal(moved.token, replacementToken);

  connection.invalidate(first);
  assert.equal(await connection.get(), moved);
  connection.invalidate(moved);
  const reloaded = await connection.get();
  assert.deepEqual(reloaded, moved);
  assert.notEqual(reloaded, moved);
});

test("desktop connection recovers from missing credentials with an explicit port", async (t) => {
  const { connection, replace } = await setup(t, 4123);
  await assert.rejects(connection.get(), {
    message: "DESKTOP_CONNECTION_INVALID",
  });
  await replace("desktop-home-token", initialToken);
  assert.deepEqual(await connection.get(), {
    port: 4123,
    token: initialToken,
  });
  connection.close();
  await assert.rejects(connection.get(), {
    message: "DESKTOP_CONNECTION_FAILED",
  });
});
