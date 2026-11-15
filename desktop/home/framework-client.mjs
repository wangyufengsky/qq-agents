import { randomUUID } from "node:crypto";
import { createFrameworkConnection } from "./framework-connection.mjs";

const LEGACY_POLL_MS = 650;
const HEARTBEAT_MS = 900;
const CONNECT_TIMEOUT_MS = 2500;
const MAX_EVENT_LENGTH = 4 * 1024 * 1024;

function heartbeatData(data, lastActivity) {
  const { dragged, ownerTouches, bodyResults, bodyPositions, ...state } = data;
  const signature = JSON.stringify(state);
  return {
    signature,
    data:
      signature !== lastActivity ||
      dragged?.length ||
      ownerTouches?.length ||
      bodyResults?.length ||
      bodyPositions
        ? data
        : state.visible,
  };
}

async function readEvents(body, onState) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end < 0) break;
      if (end > MAX_EVENT_LENGTH) throw Error("DESKTOP_CONNECTION_FAILED");
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5))
        .join("\n");
      if (data) onState(JSON.parse(data));
    }
    if (buffer.length > MAX_EVENT_LENGTH)
      throw Error("DESKTOP_CONNECTION_FAILED");
  }
}

export function createFrameworkClient(
  root,
  onState,
  listenPort,
  activityState,
) {
  const connection = createFrameworkConnection(root, listenPort);
  let client = randomUUID();
  let queue = Promise.resolve();
  let syncing = false;
  let syncAgain = false;
  let stopped = false;
  let timer;
  let stream;

  async function fetchLocal(endpoint, options) {
    const credentials = await connection.get();
    const { port, token } = credentials;
    const response = await fetch(
      `http://127.0.0.1:${port}/api/desktop-home/${endpoint}`,
      {
        ...options,
        headers: { ...options.headers, "x-desktop-home-token": token },
        redirect: "error",
      },
    );
    if (!response.ok) {
      if (response.status === 401) connection.invalidate(credentials);
      await response.body?.cancel();
      throw Error("DESKTOP_CONNECTION_FAILED");
    }
    return response;
  }

  const request = async (
    action,
    data,
    endpoint = "client",
    upload,
    clientId = client,
  ) => {
    const response = await fetchLocal(endpoint, {
      method: "POST",
      headers: {
        "content-type": upload
          ? "application/octet-stream"
          : "application/json",
        ...(endpoint === "heartbeat" && {
          "x-desktop-room-epoch": stream.roomEpoch,
        }),
        ...(upload && {
          "content-length": String(upload.bytes),
          "x-video-name": encodeURIComponent(data.name),
          "x-desktop-client": clientId,
          "x-desktop-room-epoch": data.roomEpoch,
        }),
      },
      ...(upload && { duplex: "half" }),
      body:
        upload?.stream ??
        JSON.stringify(
          endpoint === "client" || endpoint === "heartbeat"
            ? { client: clientId, action, data }
            : { ...data, client: clientId },
        ),
      signal: AbortSignal.timeout(
        upload
          ? 120_000
          : endpoint === "client" ||
              endpoint === "heartbeat" ||
              endpoint.startsWith("body-")
            ? CONNECT_TIMEOUT_MS
            : 8000,
      ),
    });
    return response.json();
  };

  const enqueue = (run) => {
    const clientId = client;
    const result = queue.then(() => {
      // Mutations queued for the former room must not reach a new visit.
      if (stopped || clientId !== client)
        throw Error("DESKTOP_CONNECTION_FAILED");
      return run(clientId);
    });
    queue = result.catch(() => {});
    return result;
  };

  function schedule(interval) {
    clearInterval(timer);
    timer = setInterval(sync, interval);
  }

  function endStream(link) {
    if (stream !== link) return;
    stream = undefined;
    link.controller.abort();
    if (stopped) return;
    client = randomUUID();
    onState({ offline: true }, "sync");
    schedule(LEGACY_POLL_MS);
    // A failed handshake may have opened the old room without a live stream.
    void request(
      "disconnect",
      undefined,
      "client",
      undefined,
      link.client,
    ).catch(() => {});
  }

  function startStream(roomEpoch) {
    const link = {
      client,
      roomEpoch,
      controller: new AbortController(),
      sequence: -1,
      ready: false,
      lastActivity: undefined,
    };
    stream = link;
    const timeout = setTimeout(() => endStream(link), CONNECT_TIMEOUT_MS);
    void (async () => {
      try {
        const query = new URLSearchParams({ client: link.client, roomEpoch });
        const response = await fetchLocal(`events?${query}`, {
          headers: { accept: "text/event-stream" },
          signal: link.controller.signal,
        });
        if (
          !response.body ||
          !response.headers.get("content-type")?.startsWith("text/event-stream")
        )
          throw Error("DESKTOP_CONNECTION_FAILED");
        await readEvents(response.body, (value) => {
          if (stream !== link || stopped) return;
          if (
            !Number.isSafeInteger(value.sequence) ||
            value.sequence <= link.sequence
          )
            return;
          link.sequence = value.sequence;
          if (value.reconnect) return endStream(link);
          if (!link.ready) {
            link.ready = true;
            clearTimeout(timeout);
            schedule(HEARTBEAT_MS);
          }
          onState(value, "sync");
        });
      } finally {
        clearTimeout(timeout);
      }
    })().then(
      () => endStream(link),
      () => endStream(link),
    );
  }

  function sync() {
    if (stopped || (stream && !stream.ready)) return;
    if (syncing) {
      syncAgain = true;
      return;
    }
    syncing = true;
    const activeStream = stream;
    const activeClient = client;
    void enqueue(async () => {
      const data = activityState();
      if (activeStream) {
        const heartbeat = heartbeatData(data, activeStream.lastActivity);
        const value = await request("sync", heartbeat.data, "heartbeat");
        if (stopped || stream !== activeStream) return;
        if (value.closed) return onState(value, "sync");
        if (value.enabled !== true || value.busy || value.reconnect)
          return endStream(activeStream);
        activeStream.lastActivity = heartbeat.signature;
        if (value.bodyRequests?.length || value.bodyResultAcks?.length)
          onState(value, "heartbeat");
        return;
      }
      const value = await request("sync", data);
      if (stopped || activeClient !== client) return;
      if (value.desktopPush === true && value.room)
        startStream(value.room.roomEpoch);
      else onState(value, "sync");
    })
      .catch(() => {
        if (stopped || activeClient !== client) return;
        if (activeStream) endStream(activeStream);
        else onState({ offline: true }, "sync");
      })
      .finally(() => {
        syncing = false;
        if (syncAgain) {
          syncAgain = false;
          sync();
        }
      });
  }

  function displayResponse(value, action, clientId) {
    if (!stopped && client === clientId && !stream) onState(value, action);
  }

  schedule(LEGACY_POLL_MS);
  sync();
  return {
    act(action, data) {
      const issuedClient = client;
      void enqueue(async (clientId) => {
        displayResponse(await request(action, data), action, clientId);
      }).catch(() => {
        if (!stopped && !stream && client === issuedClient)
          onState({ offline: true }, action);
      });
    },
    sync,
    attach(data) {
      return enqueue(async (clientId) => {
        displayResponse(
          await request(undefined, data, "attachment"),
          undefined,
          clientId,
        );
      });
    },
    async attachVideo(data, upload) {
      if (stopped) throw Error("DESKTOP_CONNECTION_FAILED");
      await request(undefined, data, "video", upload);
      sync();
    },
    command(action, data) {
      return enqueue(async (clientId) => {
        const value = await request(action, data);
        if (stopped || client !== clientId)
          throw Error("DESKTOP_CONNECTION_FAILED");
        displayResponse(value, action, clientId);
        return value.room;
      });
    },
    result(endpoint, data, isCurrent) {
      return enqueue(() => {
        // A revoke may happen while this result waits behind another request.
        if (isCurrent()) return request(undefined, data, endpoint);
      });
    },
    async close() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (stream) endStream(stream);
      await queue;
      try {
        await request("disconnect");
      } catch {
        // A dead transport cannot close its room explicitly.
      } finally {
        connection.close();
      }
    },
  };
}
