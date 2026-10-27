import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ConfigStore, validateConfig, inSilence } from "../src/core/config.mjs";
import { config, temp, fixture } from "./helpers.mjs";

test("new equal-time silence requires an explicit all-day choice", () => {
  const cfg = config(1),
    a = cfg.agents[0];
  a.silence = [{ start: "08:00", end: "08:00", days: [1], timezone: "UTC" }];
  assert.throws(() => validateConfig(cfg));
  a.silence[0].allDay = true;
  const parsed = validateConfig(cfg).agents[0];
  assert.equal(inSilence(parsed, new Date("2026-10-26T07:59:59Z")), false);
  assert.equal(inSilence(parsed, new Date("2026-10-26T08:00:00Z")), true);
  assert.equal(inSilence(parsed, new Date("2026-10-27T07:59:59Z")), true);
  assert.equal(inSilence(parsed, new Date("2026-10-27T08:00:00Z")), false);
});

test("loading old equal-time windows preserves their former effect and persists explicit choices only on save", (t) => {
  const cfg = config(1),
    file = path.join(temp(t), "config.json");
  cfg.agents[0].silence = [
    { start: "08:00", end: "08:00", days: [1], timezone: "UTC" },
  ];
  Object.assign(cfg.agents[0].scheduler, {
    quietEnabled: true,
    quietStart: "08:00",
    quietEnd: "08:00",
  });
  const original = JSON.stringify(cfg);
  fs.writeFileSync(file, original);
  const store = new ConfigStore(file);
  assert.equal(store.value.agents[0].silence[0].allDay, true);
  assert.equal(store.value.agents[0].scheduler.quietEnabled, false);
  assert.deepEqual(store.migrationWarnings, [
    "SILENCE_EQUAL_TIME_MIGRATED",
    "SCHEDULER_EQUAL_TIME_MIGRATED",
  ]);
  for (const at of [
    "2026-10-26T07:59:00Z",
    "2026-10-26T08:00:00Z",
    "2026-10-27T07:59:00Z",
    "2026-10-27T08:00:00Z",
  ])
    assert.equal(
      inSilence(store.value.agents[0], new Date(at)),
      inSilence(cfg.agents[0], new Date(at)),
    );
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.equal(new ConfigStore(file).revision, store.revision);
  store.save(store.value, store.revision);
  assert.equal(new ConfigStore(file).value.agents[0].silence[0].allDay, true);
  assert.deepEqual(new ConfigStore(file).migrationWarnings, []);
});

test("scheduler all-day quiet is explicit and affects groups while a disabled equal window stays disabled", (t) => {
  const cfg = config(1),
    a = cfg.agents[0];
  Object.assign(a.scheduler, {
    quietStart: "08:00",
    quietEnd: "08:00",
    quietEnabled: true,
  });
  assert.throws(() => validateConfig(cfg));
  a.scheduler.quietAllDay = true;
  const f = fixture(t, { cfg });
  for (const hour of [0, 7, 8, 16, 23]) {
    const at = Date.UTC(2026, 9, 26, hour);
    assert.equal(
      f.runtime.scheduler.quiet(f.runtime.agent(a.id), "group:20000", at),
      true,
    );
    assert.equal(
      f.runtime.scheduler.quiet(f.runtime.agent(a.id), "private:30000", at),
      false,
    );
  }
  a.scheduler.quietEnabled = false;
  a.scheduler.quietAllDay = false;
  assert.doesNotThrow(() => validateConfig(cfg));
});

test("all-day windows respect empty days, week rollover, timezone and the 25-hour DST day", () => {
  const a = config(1).agents[0];
  a.silence = [
    {
      start: "00:00",
      end: "00:00",
      allDay: true,
      days: [0],
      timezone: "America/New_York",
    },
  ];
  for (const [at, expected] of [
    ["2026-11-01T03:59:59Z", false],
    ["2026-11-01T04:00:00Z", true],
    ["2026-11-02T04:59:59Z", true],
    ["2026-11-02T05:00:00Z", false],
  ])
    assert.equal(inSilence(a, new Date(at)), expected);
  a.silence[0].days = [];
  assert.equal(inSilence(a, new Date("2026-11-01T12:00:00Z")), false);
  a.silence = [{ start: "23:00", end: "02:00", days: [6], timezone: "UTC" }];
  assert.equal(inSilence(a, new Date("2026-11-01T01:59:00Z")), true);
  assert.equal(inSilence(a, new Date("2026-11-01T02:00:00Z")), false);
});
