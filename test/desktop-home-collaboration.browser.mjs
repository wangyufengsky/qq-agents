import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";
import { desktopToken } from "../src/home/desktop-auth.mjs";
import { createServer } from "../src/server.mjs";
import { config, fixture } from "./helpers.mjs";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
async function waitFor(read, problem) {
  const deadline = Date.now() + 12_000;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() >= deadline) throw Error(problem);
    await delay(25);
  }
}

test("desktop collaboration opens the current note and clears superseded content", async (t) => {
  const executablePath = process.env.QQ_TEST_ELECTRON;
  if (!executablePath) {
    t.skip("Set QQ_TEST_ELECTRON to the native Electron executable");
    return;
  }
  const cfg = config(2);
  cfg.desktopHome.enabled = true;
  cfg.desktopHome.publicPerception.enabled = true;
  cfg.desktopHome.activityRoles = cfg.agents.map(({ id }) => id);
  cfg.agents[0].subject.enabled = true;
  cfg.agents[0].tools = [...new Set([...cfg.agents[0].tools, "work_note"])];
  const { runtime, store, root } = fixture(t, { cfg });
  const admin = randomBytes(32).toString("hex");
  const profile = join(root, "electron");
  await mkdir(profile);
  await writeFile(join(root, "desktop-home-token"), desktopToken(admin));
  const server = createServer({ runtime, token: admin, allowLive: true });
  const port = await server.listen();
  let electron;
  try {
    electron = await _electron.launch({
      executablePath,
      args: [join(repo, "desktop/home")],
      env: {
        ...process.env,
        DESKTOP_HOME_TRIAL_PROFILE: profile,
        DESKTOP_HOME_DATA_ROOT: root,
        DESKTOP_HOME_LIVE_ROOT: "",
        DESKTOP_HOME_PORT: String(port),
      },
    });
    const door = await electron.firstWindow();
    await door.locator(".door-button").waitFor();
    const host = runtime.desktopVisits;
    await waitFor(() => host.live, "Desktop host did not connect");
    const role = host.live.room.roles[0];
    host.live.room.members[role.id] = "invited";
    host.live.admit(role);
    const visit = host.live.visits.get(role.id);
    const memory = store.bind(role.id);
    const source = memory.append({
      conversation: "@subject",
      dedupe: "synthetic-source",
      kind: "message.received",
      body: "公开测试来源",
    });
    const note = memory.identity.saveNote(
      {
        body: "M3_SYNTHETIC_NOTE",
        evidence: [source.id],
        uncertainty: "待核实",
        status: "open",
      },
      "@subject",
      runtime.now(),
    );
    host.captureStatusCard(
      runtime.makeContext(role.id, "@subject"),
      "work_note",
    )(note);
    assert.equal(host.statusCards.snapshot(role.id, visit)?.kind, "work-note");
    await waitFor(
      () => host.client?.bodyPublic && host.activityCurrent(role.id),
      "Role did not become active",
    );
    host.live.publishBubble(role.id, visit, { text: "合成协作动态" });
    host.notify();
    const sprite = await waitFor(
      () =>
        electron
          .windows()
          .find((page) => page.url().includes(`type=sprite&id=${role.id}`)),
      "Role window did not open",
    );
    const floatingShortcut = sprite.getByRole("button", {
      name: "查看当前协作内容",
    });
    await floatingShortcut.waitFor({ state: "visible" });
    const findPanel = () =>
      electron.windows().find((page) => page.url().includes("type=panel"));
    await floatingShortcut.evaluate((button) => button.click());
    await delay(200);
    assert.equal(findPanel(), undefined);
    await floatingShortcut.click();
    const panel = await waitFor(
      findPanel,
      "Trusted collaboration click did not open the panel",
    );
    const noteText = panel.getByText("M3_SYNTHETIC_NOTE");
    await noteText.waitFor({ state: "visible" });
    await panel
      .locator(".status-dialog")
      .getByRole("button", { name: "关闭" })
      .click();
    await panel.getByRole("button", { name: "来访", exact: true }).click();
    await panel
      .getByRole("button", { name: "查看当前协作内容" })
      .click({ timeout: 5_000 });
    await noteText.waitFor({ state: "visible" });
    const card = host.statusCards.snapshot(role.id, visit);
    const identity = {
      client: host.client.id,
      roomEpoch: host.live.room.epoch,
      agentId: role.id,
      visitId: host.body.visitId(visit),
      ref: card.ref,
    };
    assert.throws(
      () => host.statusCards.open({ ...identity, visitId: randomUUID() }),
      /DESKTOP_VISIT_UNAVAILABLE/,
    );
    memory.identity.saveNote(
      {
        id: note.id,
        body: "changed",
        evidence: [source.id],
        uncertainty: "待核实",
        status: "open",
      },
      "@subject",
      runtime.now(),
    );
    assert.throws(
      () => host.statusCards.open(identity),
      /DESKTOP_VISIT_UNAVAILABLE/,
    );
    host.notify();
    await panel
      .getByText("M3_SYNTHETIC_NOTE")
      .waitFor({ state: "hidden", timeout: 10000 });
    assert.equal(await panel.getByText("M3_SYNTHETIC_NOTE").count(), 0);
  } finally {
    try {
      await electron?.close();
    } finally {
      await server.close();
    }
  }
});
