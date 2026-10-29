// NapCat's native attachment stream does not depend on PacketBackend. Use only
// an observed attachment ID, never a model-supplied URL or gateway local path.
export async function downloadFileStream(
  bot,
  fileId,
  { maxBytes, signal, sizeHintOnly = false },
) {
  if (typeof fileId !== "string" || !fileId || fileId.length > 1024)
    throw Error("FILE_SOURCE_DENIED");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw Error("FILE_TOO_LARGE");
  const deadline = AbortSignal.timeout(60000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const chunks = [];
  let pending = Buffer.alloc(0),
    bytes = 0,
    wireBytes = 0,
    expected = null,
    completed = false;
  const fail = () => {
    throw Error("FILE_DOWNLOAD_FAILED");
  };
  const frame = (line) => {
    if (line.length > 128 * 1024) fail();
    const text = line.toString("utf8").trim();
    if (!text) return;
    if (completed) fail();
    let packet;
    try {
      packet = JSON.parse(text);
    } catch {
      fail();
    }
    if (packet?.status !== "ok" || packet.retcode !== 0) fail();
    const data = packet.data;
    if (data?.data_type === "file_info" && data.type === "stream") {
      if (
        expected !== null ||
        !Number.isSafeInteger(data.file_size) ||
        data.file_size < 0
      )
        fail();
      if (data.file_size > maxBytes) throw Error("FILE_TOO_LARGE");
      expected = data.file_size;
    } else if (data?.data_type === "file_chunk" && data.type === "stream") {
      if (
        expected === null ||
        data.index !== chunks.length ||
        typeof data.data !== "string" ||
        !data.data.length
      )
        fail();
      const chunk = Buffer.from(data.data, "base64");
      if (bytes + chunk.length > maxBytes) throw Error("FILE_TOO_LARGE");
      if (
        chunk.length > 65536 ||
        chunk.toString("base64") !== data.data ||
        data.size !== chunk.length ||
        (!sizeHintOnly && bytes + chunk.length > expected)
      )
        fail();
      chunks.push(chunk);
      bytes += chunk.length;
    } else if (
      data?.data_type === "file_complete" &&
      data.type === "response"
    ) {
      if (
        expected === null ||
        data.total_chunks !== chunks.length ||
        data.total_bytes !== bytes ||
        (!sizeHintOnly && bytes !== expected)
      )
        fail();
      completed = true;
    } else fail();
  };
  try {
    combined.throwIfAborted();
    const response = await bot.fetch(
      bot.config.httpUrl.replace(/\/$/, "") + "/download_file_stream",
      {
        method: "POST",
        headers: bot.headers(),
        redirect: "error",
        signal: combined,
        body: JSON.stringify({ file_id: fileId, chunk_size: 65536 }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw Error("FILE_DOWNLOAD_HTTP_ERROR");
    }
    for await (const chunk of response.body) {
      combined.throwIfAborted();
      wireBytes += chunk.length;
      if (wireBytes > Math.ceil((maxBytes * 4) / 3) + 1024 * 1024) fail();
      pending = Buffer.concat([pending, chunk]);
      let end;
      while ((end = pending.indexOf(10)) !== -1) {
        frame(pending.subarray(0, end));
        pending = pending.subarray(end + 1);
      }
      if (pending.length > 128 * 1024) fail();
    }
    combined.throwIfAborted();
    frame(pending);
    if (!completed) fail();
    return { buffer: Buffer.concat(chunks, bytes) };
  } catch (error) {
    if (combined.aborted)
      throw Error("FILE_DOWNLOAD_CANCELLED", { cause: error });
    if (["FILE_TOO_LARGE", "FILE_DOWNLOAD_HTTP_ERROR"].includes(error.message))
      throw error;
    throw Error("FILE_DOWNLOAD_FAILED", { cause: error });
  }
}
