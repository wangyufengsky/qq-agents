import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../src/core/config.mjs";
import {
  backendSessionConfig,
  backendRequestConfig,
} from "../src/backends/session-contract.mjs";
import { configImpact } from "../src/core/config-impact.mjs";
import { config } from "./helpers.mjs";

function configuration(cliReuse) {
  const cfg = config(1);
  return validateConfig({
    ...cfg,
    backends: [
      {
        ...cfg.backends[0],
        type: "antigravity",
        command: "agy",
        effort: "low",
        ...(cliReuse === undefined ? {} : { cliReuse }),
      },
    ],
  });
}

test("CLI reuse remains opt-in and validates bounded Antigravity-only resource settings", () => {
  const old = configuration(),
    disabled = configuration({});
  assert.equal(old.backends[0].cliReuse, undefined);
  assert.deepEqual(disabled.backends[0].cliReuse, {
    enabled: false,
    idleTimeoutMs: 600000,
    maxIdleProcesses: 2,
  });
  assert.deepEqual(
    backendSessionConfig(old.backends[0]),
    backendSessionConfig(disabled.backends[0]),
  );
  for (const bad of [
    { idleTimeoutMs: 0 },
    { maxIdleProcesses: 0 },
    { maxIdleProcesses: 17 },
    { idleTimeoutMs: 3600001 },
    { enabled: "yes" },
  ])
    assert.throws(() => configuration(bad));
  assert.throws(() =>
    validateConfig({
      ...config(1),
      backends: [{ ...config(1).backends[0], cliReuse: { enabled: true } }],
    }),
  );
});

test("enabling routing changes the session contract while idle limits only affect future requests", () => {
  const old = configuration(),
    enabled = configuration({ enabled: true }),
    limits = configuration({
      enabled: true,
      idleTimeoutMs: 2000,
      maxIdleProcesses: 1,
    });
  assert.notDeepEqual(
    backendSessionConfig(old.backends[0]),
    backendSessionConfig(enabled.backends[0]),
  );
  assert.deepEqual(
    backendSessionConfig(enabled.backends[0]),
    backendSessionConfig(limits.backends[0]),
  );
  assert(configImpact(old, enabled).backendIds.has("fixture"));
  assert.equal(configImpact(enabled, limits).backendIds.size, 0);
  assert.equal(
    backendRequestConfig(limits.backends[0]).cliReuse.idleTimeoutMs,
    2000,
  );
});
