import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import test from "node:test";
import { attachDesktopBrowserNetwork } from "../src/home/desktop-browser-network.mjs";

test("managed requests revalidate policy and public DNS, including exact POST bytes", async (t) => {
  const cdp = new EventEmitter();
  cdp.send = async (name, data) => cdp.emit(name, data);
  const attempts = [];
  const checked = [];
  const auth = [];
  let denyBody = false;
  const network = attachDesktopBrowserNetwork(cdp, {
    async validate(raw) {
      checked.push(raw);
      return {
        addresses: raw.includes("mixed.example")
          ? ["93.184.216.34", "127.0.0.1"]
          : ["93.184.216.34"],
      };
    },
    async request(url, options) {
      const pin = await new Promise((resolve) =>
        options.lookup(url.hostname, { all: true }, (_error, result) =>
          resolve(result),
        ),
      );
      attempts.push({
        url: url.href,
        method: options.method,
        body: options.body?.toString(),
        pin,
      });
      return { status: 200, headers: {}, body: Buffer.from("Fixture") };
    },
  });
  await network.ready;
  t.after(() => network.close());
  const authorize = (url) => auth.push({ url });
  authorize.post = (request) => {
    auth.push(request);
    if (denyBody) throw Error("HOME_SOURCE_DENIED");
  };
  let id = 0;
  async function send(expected, request) {
    const result = once(cdp, `Fetch.${expected}Request`);
    cdp.emit("Fetch.requestPaused", {
      requestId: String(++id),
      request: { headers: {}, method: "GET", ...request },
    });
    return (await result)[0];
  }
  const url = "https://public.example/example";
  await send("fail", { url });
  assert.equal(checked.length, 0);
  network.authorize(authorize);
  await send("fail", { url: "https://mixed.example/example" });
  assert.equal(attempts.length, 0);
  await send("fulfill", { url });
  const post = {
    url,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    postData: "message=local+fixture",
    hasPostData: true,
  };
  await send("fulfill", post);
  assert.deepEqual(
    auth.filter(({ method }) => method === "POST"),
    Array.from({ length: 2 }, () => ({
      url,
      method: "POST",
      body: post.postData,
    })),
  );
  assert.deepEqual(attempts.at(-1), {
    url,
    method: "POST",
    body: post.postData,
    pin: [{ address: "93.184.216.34", family: 4 }],
  });
  denyBody = true;
  await send("fail", post);
  assert.equal(attempts.length, 2);
  const checks = checked.length;
  await send("fail", {
    ...post,
    headers: { "Content-Type": "application/octet-stream" },
  });
  assert.equal(checked.length, checks);
});
