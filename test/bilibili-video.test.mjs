import assert from "node:assert/strict";
import dns from "node:dns";
import https from "node:https";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Bilibili accepts a one-hour part and tries a smaller video track within its byte budget", async (t) => {
  t.mock.method(dns.promises, "lookup", async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
  const { fetchBilibiliVideo } = await import("../src/video/bilibili.mjs");
  const MiB = 1024 * 1024;
  const calls = [];
  let smallBytes = 160 * MiB;
  t.mock.method(https, "get", (url, options, onResponse) => {
    calls.push(url.pathname);
    const response = new PassThrough();
    response.statusCode = 200;
    response.headers = {};
    let data = "synthetic dash track";
    switch (url.pathname) {
      case "/x/player/pagelist":
        data = JSON.stringify({
          code: 0,
          data: [
            { page: 1, cid: 10000, duration: 3600 },
            { page: 2, cid: 10001, duration: 3601 },
          ],
        });
        break;
      case "/x/player/playurl":
        assert.equal(url.searchParams.get("cid"), "10000");
        data = JSON.stringify({
          code: 0,
          data: {
            dash: {
              video: [
                {
                  height: 360,
                  codecs: "avc1.64001f",
                  baseUrl: "https://fixture.bilivideo.com/small",
                },
                {
                  height: 480,
                  codecs: "avc1.64001f",
                  baseUrl: "https://fixture.bilivideo.com/large",
                },
              ],
            },
          },
        });
        break;
      case "/large":
        response.headers["content-length"] = String(192 * MiB + 1);
        break;
      case "/small":
        response.headers["content-length"] = String(smallBytes);
        break;
      default:
        assert.fail("Unexpected request: " + url.pathname);
    }
    queueMicrotask(() => {
      onResponse(response);
      if (!response.destroyed) response.end(data);
    });
    return new EventEmitter();
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), "qq-bilibili-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const video = "https://www.bilibili.com/video/BV1xx411x7mD";
  const file = path.join(dir, "video.mp4");
  const signal = new AbortController().signal;
  const fetch = (url) => fetchBilibiliVideo(url, file, signal, () => {});
  assert.deepEqual((await fetch(video)).part, {
    bvid: "BV1xx411x7mD",
    cid: 10000,
  });
  assert.equal(await readFile(file, "utf8"), "synthetic dash track");
  assert.deepEqual(calls.splice(0), [
    "/x/player/pagelist",
    "/x/player/playurl",
    "/large",
    "/small",
  ]);
  await assert.rejects(fetch(video + "?p=2"), { message: "VIDEO_LIMIT" });
  assert.deepEqual(calls.splice(0), ["/x/player/pagelist"]);
  smallBytes = 192 * MiB + 1;
  await assert.rejects(fetch(video), { message: "VIDEO_LIMIT" });
  assert.deepEqual(calls, [
    "/x/player/pagelist",
    "/x/player/playurl",
    "/large",
    "/small",
  ]);
});
