// @ts-check
import path from "node:path";
import { spawn } from "node:child_process";
import { buildChildEnv } from "../src/core/child-env.mjs";
if (process.platform !== "win32") process.exit(0);
const system = process.env.SystemRoot || "C:\\Windows";
const executable = path.join(
  system,
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const filtered = buildChildEnv("browser");
console.log(
  JSON.stringify({
    envPresence: Object.fromEntries(
      [
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "TEMP",
        "USERPROFILE",
        "PSMODULEPATH",
      ].map((name) => [name, Boolean(filtered[name])]),
    ),
  }),
);
/** Fixed, credential-free probes isolate host startup from module discovery.
 * @param {string} name @param {NodeJS.ProcessEnv} env @param {boolean} directImport */
async function probe(name, env, directImport) {
  const started = Date.now();
  const command = `$ErrorActionPreference='Stop';[Console]::WriteLine('entered');try {${directImport ? "Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1');[Console]::WriteLine('utility-imported');" : ""}$null=@{safe=$true}|ConvertTo-Json -Compress;[Console]::WriteLine('json-ready');$null=Get-CimInstance Win32_Process -Filter "ProcessId = $PID";[Console]::WriteLine('cim-ready')}catch{[Console]::WriteLine('failed:'+$_.Exception.HResult);exit 1}`;
  await new Promise((resolve) => {
    const child = spawn(
      path.join(system, "System32", "conhost.exe"),
      [
        "--headless",
        executable,
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        command,
      ],
      {
        env,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      stderrBytes = 0,
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 12000);
    child.stdout.on("data", (data) => {
      output += data;
      const lines = output.split(/\r?\n/);
      output = lines.pop() || "";
      for (const phase of lines)
        if (
          /^(entered|utility-imported|json-ready|cim-ready|failed:-?\d+)$/.test(
            phase,
          )
        )
          console.log(
            JSON.stringify({ name, phase, elapsedMs: Date.now() - started }),
          );
    });
    child.stderr.on("data", (data) => {
      stderrBytes += data.length;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      console.log(
        JSON.stringify({
          name,
          spawnCode: /** @type {NodeJS.ErrnoException} */ (error).code,
        }),
      );
      resolve(undefined);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      console.log(
        JSON.stringify({
          name,
          code,
          signal,
          timedOut,
          stderrBytes,
          elapsedMs: Date.now() - started,
        }),
      );
      resolve(undefined);
    });
  });
}
await probe("filtered-auto-discovery", filtered, false);
await probe("filtered-fixed-utility-import", filtered, true);
await probe(
  "filtered-fixed-system-module-path",
  {
    ...filtered,
    PSModulePath: path.join(
      system,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "Modules",
    ),
  },
  false,
);
