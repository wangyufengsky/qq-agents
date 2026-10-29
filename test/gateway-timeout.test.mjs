import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, context, raw, settle } from "./helpers.mjs";
import { OneBot } from "../src/transport/onebot.mjs";
import { safeToolFailure } from "../src/tools/errors.mjs";

const NAPCAT_TIMEOUT =
  "Timeout: NTEvent serviceAndMethod:NodeIKernelMsgService/sendMsg ListenerName:NodeIKernelMsgListener/onMsgInfoListUpdate EventRet: {}";
const timeout = () =>
  Object.assign(Error("ONEBOT_REJECTED"), { reason: "GATEWAY_TIMEOUT" });

test("NapCat's send-confirmation timeout is reported as a gateway timeout, without its text", async () => {
  const bot = new OneBot(config(1).connections[0], {
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          status: "failed",
          retcode: 200,
          message: NAPCAT_TIMEOUT,
          wording: NAPCAT_TIMEOUT,
        }),
      ),
  });
  const error = await bot
    .send("group:20000", [{ type: "text", data: { text: "x" } }])
    .catch((e) => e);
  assert.equal(error.message, "ONEBOT_REJECTED");
  assert.equal(error.reason, "GATEWAY_TIMEOUT");
  assert(
    !JSON.stringify({ ...error, message: error.message }).includes("NTEvent"),
  );
});

test("a gateway timeout leaves the outcome unknown instead of failed", async (t) => {
  const { runtime, store } = fixture(t);
  const transport = runtime.transports.get("qq-0"),
    mem = store.bind("agent-0");
  transport.send = async () => {
    throw timeout();
  };
  await assert.rejects(
    runtime.send(context(runtime), { requestId: "t-1", text: "改好了" }),
    /^Error: DELIVERY_UNKNOWN$/,
  );
  assert.equal(mem.delivery("t-1").status, "unknown");
  const result = mem
    .search({ kind: "message.send-result" })
    .items.find((x) => x.status === "unknown");
  assert.equal(
    mem.readRecord({ id: result.id }).payload.reason,
    "GATEWAY_TIMEOUT",
  );
  assert.match(
    safeToolFailure(Error("DELIVERY_UNKNOWN")).hint,
    /Do not send it again/,
  );
  // A plain refusal is still a failure.
  transport.send = async () => {
    throw Error("ONEBOT_REJECTED");
  };
  await assert.rejects(
    runtime.send(context(runtime), { requestId: "t-2", text: "被拒绝" }),
    /^Error: DELIVERY_FAILED$/,
  );
  assert.equal(mem.delivery("t-2").status, "failed");
});

async function echo(runtime, id, message) {
  await runtime.ingest(
    "qq-0",
    raw(id, { post_type: "message_sent", user_id: 10000, message }),
  );
  await settle(runtime);
}
const text = (s) => ({ type: "text", data: { text: s } });

test("QQ's own copy of an unconfirmed send marks it sent", async (t) => {
  const { runtime, store } = fixture(t);
  const transport = runtime.transports.get("qq-0"),
    mem = store.bind("agent-0");
  transport.send = async () => {
    throw timeout();
  };
  await assert.rejects(
    runtime.send(context(runtime), {
      requestId: "e-1",
      text: "改好了，大肥猫现在一脸苦闷",
    }),
    /UNKNOWN/,
  );
  // Other text from the account settles nothing.
  await echo(runtime, 501, [text("别的话")]);
  assert.equal(mem.delivery("e-1").status, "unknown");
  // The same text with the image the send carried matches.
  await echo(runtime, 502, [
    text("改好了，大肥猫现在一脸苦闷 "),
    { type: "image", data: { file: "sticker.gif" } },
  ]);
  const settled = mem.delivery("e-1");
  assert.equal(settled.status, "sent");
  assert.equal(settled.message_id, "502");
  assert.equal(mem.unresolvedDeliveryCount(), 0);
  const record = mem
    .search({ kind: "message.send-result" })
    .items.find((x) => x.status === "confirmed");
  const payload = mem.readRecord({ id: record.id }).payload;
  assert.equal(payload.reconciledBy, "gateway-echo");
  assert.equal(payload.messageId, "502");
  // The echo itself is still archived as QQ's record of the message.
  assert(
    mem
      .conversation({ conversation: "group:20000" })
      .items.some((x) => x.messageId === "502" && x.direction === "out"),
  );
});

test("an ambiguous or image-only echo is left for the administrator", async (t) => {
  const { runtime, store } = fixture(t);
  const transport = runtime.transports.get("qq-0"),
    mem = store.bind("agent-0");
  transport.send = async () => {
    throw timeout();
  };
  for (const requestId of ["a-1", "a-2"])
    await assert.rejects(
      runtime.send(context(runtime), { requestId, text: "同一句话" }),
      /UNKNOWN/,
    );
  await echo(runtime, 601, [text("同一句话")]);
  assert.equal(mem.delivery("a-1").status, "unknown");
  assert.equal(mem.delivery("a-2").status, "unknown");
  await echo(runtime, 602, [{ type: "image", data: { file: "only.png" } }]);
  assert.equal(mem.unresolvedDeliveryCount(), 2);
});
