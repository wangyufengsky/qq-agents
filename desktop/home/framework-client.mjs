import { randomUUID } from "node:crypto";
import { createFrameworkConnection } from "./framework-connection.mjs";

const LEGACY_POLL_MS = 650;
const HEARTBEAT_MS = 900;
const CONNECT_TIMEOUT_MS = 2500;
const MAX_EVENT_LENGTH = 4 * 1024 * 1024;

function heartbeatData(data, lastActivity) {
  const {
    dragged,
    ownerTouches,
    desktopOwnerEvents,
    bodyResults,
    bodyPositions,
    ...state
  } = data;
  const signature = JSON.stringify(state);
  return {
    signature,
    data:
      signature !== lastActivity ||
      dragged?.length ||
      ownerTouches?.length ||
      desktopOwnerEvents?.length ||
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
  let authorizationQueue = Promise.resolve();
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
    const heartbeat = endpoint === "heartbeat" ? stream : undefined;
    const timeout = AbortSignal.timeout(
      endpoint === "personal-drop"
        ? 7_260_000
        : upload
          ? 120_000
          : endpoint === "client" ||
              endpoint === "heartbeat" ||
              endpoint.startsWith("body-")
            ? CONNECT_TIMEOUT_MS
            : 8000,
    );
    const response = await fetchLocal(endpoint, {
      method: "POST",
      headers: {
        "content-type": upload
          ? "application/octet-stream"
          : "application/json",
        ...(heartbeat && { "x-desktop-room-epoch": heartbeat.roomEpoch }),
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
      signal: heartbeat
        ? AbortSignal.any([timeout, heartbeat.controller.signal])
        : timeout,
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

  function endStream(link, recover = false) {
    if (stream !== link) return;
    stream = undefined;
    link.controller.abort();
    if (stopped) return;
    if (recover && link.ready && link.unified) {
      // The host retains this visit while its lease is live. Prove the same epoch
      // again before falling back to a new room after a transport interruption.
      onState({ offline: true }, "sync");
      startStream(link.roomEpoch);
      return;
    }
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
      missedHeartbeats: 0,
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
          link.unified = value.room?.desktopUnified === true;
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
      () => endStream(link, true),
      () => endStream(link, true),
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
    const synchronize = async () => {
      const data = activityState();
      if (activeStream) {
        const heartbeat = heartbeatData(data, activeStream.lastActivity);
        const value = await request("sync", heartbeat.data, "heartbeat");
        if (stopped || stream !== activeStream) return;
        if (value.closed) return onState(value, "sync");
        if (value.enabled !== true || value.busy || value.reconnect)
          return endStream(activeStream);
        activeStream.missedHeartbeats = 0;
        if (value.refreshActivity) {
          activeStream.lastActivity = undefined;
          syncAgain = true;
        } else activeStream.lastActivity = heartbeat.signature;
        if (
          value.bodyRequests?.length ||
          value.bodyResultAcks?.length ||
          value.desktopOwnerInput
        )
          onState(value, "heartbeat");
        return;
      }
      const value = await request("sync", data);
      if (stopped || activeClient !== client) return;
      if (value.desktopPush === true && value.room)
        startStream(value.room.roomEpoch);
      else onState(value, "sync");
    };
    // A slow upload or command receipt must not expire an otherwise live room.
    void (activeStream ? synchronize() : enqueue(synchronize))
      .catch(() => {
        if (stopped || activeClient !== client) return;
        if (activeStream) {
          if (stream !== activeStream) return;
          // A local heartbeat can time out while the invitation turn prepares.
          // Retry on the existing stream before discarding a live visit.
          if (!activeStream.unified || ++activeStream.missedHeartbeats >= 2)
            endStream(activeStream, true);
        } else onState({ offline: true }, "sync");
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
    sharedImage(data) {
      return request(undefined, data, "shared-image");
    },
    attach(data) {
      return enqueue(async (clientId) => {
        displayResponse(
          await request(undefined, data, "attachment"),
          undefined,
          clientId,
        );
      });
    },
    async personal(endpoint, data) {
      // A model turn can outlast a lease; keep sync independent of this request.
      const issuedClient = client;
      if (stopped) throw Error("DESKTOP_CONNECTION_FAILED");
      const result = await request(
        undefined,
        data,
        endpoint,
        undefined,
        issuedClient,
      );
      if (stopped || client !== issuedClient)
        throw Error("DESKTOP_CONNECTION_FAILED");
      return result;
    },
    async attachVideo(data, upload) {
      if (stopped) throw Error("DESKTOP_CONNECTION_FAILED");
      await request(undefined, data, "video", upload);
      sync();
    },
    authorization(action, data) {
      const issuedClient = client;
      const update = authorizationQueue.then(async () => {
        if (stopped || client !== issuedClient)
          throw Error("DESKTOP_CONNECTION_FAILED");
        const value = await request(
          action,
          data,
          "client",
          undefined,
          issuedClient,
        );
        if (stopped || client !== issuedClient)
          throw Error("DESKTOP_CONNECTION_FAILED");
        displayResponse(value, action, issuedClient);
        return value.room;
      });
      // Revocation must not wait behind file uploads or tool receipts.
      authorizationQueue = update.catch(() => {});
      return update;
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
    result(endpoint, data, isCurrent, verify) {
      return enqueue(async () => {
        // The source must still be safe when this result leaves the local queue.
        if (!isCurrent() || (verify && !(await verify())) || !isCurrent())
          return;
        return request(undefined, data, endpoint);
      });
    },
    async close() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (stream) endStream(stream);
      await Promise.all([queue, authorizationQueue]);
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
