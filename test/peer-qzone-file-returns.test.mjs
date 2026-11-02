import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { config, fixture, context, temp } from "./helpers.mjs";
import { FileStore } from "../src/tools/files.mjs";

for (const tool of ["file_create", "file_import", "file_download"])
  test(`${tool} checks retained metadata before returning and restores permitted owner taint`, async (t) => {
    const sourceRoot = temp(t),
      buffer = Buffer.from("ordinary shared bytes");
    fs.writeFileSync(path.join(sourceRoot, "ordinary.txt"), buffer);
    const cfg = config(1),
      a = cfg.agents[0];
    Object.assign(a.files, {
      enabled: true,
      create: true,
      download: true,
      localRoots: [sourceRoot],
    });
    a.tools.push(tool);
    const f = fixture(t, { cfg });
    f.runtime.files = new FileStore(path.join(f.root, "files"));
    const file = f.runtime.files.put(
      "agent-0",
      buffer,
      "private.txt",
      f.runtime.agent("agent-0").files,
      {
        kind: "web",
        url: "https://example.invalid/?private=PEER_FILE_SOURCE_SECRET",
      },
      false,
      [],
      ["30000"],
    );
    f.runtime.files.download = async () => ({
      buffer,
      origin: "https://example.invalid",
    });
    const args =
      tool === "file_create"
        ? { name: "ordinary.txt", text: buffer.toString() }
        : tool === "file_import"
          ? { rootIndex: 0, relativePath: "ordinary.txt" }
          : { url: "https://example.invalid/ordinary.txt" };
    const before = f.runtime.files.metadata("agent-0", file.fileId);
    const group = context(f.runtime);
    await assert.rejects(
      f.runtime.callTool(group, tool, args),
      /RECALL_SOURCE_NOT_ALLOWED/,
    );
    assert(!group.privateRead.has("peer-qzone:30000"));
    const retained = f.runtime.files.metadata("agent-0", file.fileId);
    assert.deepEqual(retained.protectedPeerQzoneTargets, ["30000"]);
    assert.match(JSON.stringify(retained.sources), /PEER_FILE_SOURCE_SECRET/);
    if (tool === "file_create") assert.deepEqual(retained, before);
    const owner = context(f.runtime, "agent-0", "private:30000");
    const result = await f.runtime.callTool(owner, tool, args);
    assert.equal(result.fileId, file.fileId);
    assert.match(JSON.stringify(result.sources), /PEER_FILE_SOURCE_SECRET/);
    assert(owner.privateRead.has("peer-qzone:30000"));
    assert(
      f.store
        .bind("agent-0")
        .state("private:30000")
        .disclosureTaint.includes("peer-qzone:30000"),
    );
  });
