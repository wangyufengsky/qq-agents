import { writeFile } from "node:fs/promises";
import { validateFetchUrl } from "../../vendor/social-reader/safe-fetch.js";
import { parseCards } from "../apps/cards.mjs";
import { publicUrl, requestAppUrl } from "../apps/urls.mjs";
import { downloadFile, validateWithSignal } from "../tools/file-download.mjs";

const hosts = new Set(["www.bilibili.com", "m.bilibili.com", "bilibili.com"]);
const videoId = /^\/(?:video)\/(BV[A-Za-z0-9]{10}|av[1-9]\d{0,17})\/?$/;
const maxBytes = 96 * 1024 * 1024;

function share(value) {
  const url = publicUrl(value);
  const part = url.searchParams.get("p") || "1";
  if (!/^[1-9]\d{0,3}$/.test(part)) throw Error("VIDEO_SOURCE_DENIED");
  const short = url.hostname === "b23.tv";
  const id = hosts.has(url.hostname) && videoId.exec(url.pathname)?.[1];
  if (!id && !(short && /^\/[A-Za-z0-9]{1,24}\/?$/.test(url.pathname)))
    throw Error("VIDEO_SOURCE_DENIED");
  const canonical = new URL(
    id
      ? `https://www.bilibili.com/video/${id}`
      : `https://b23.tv${url.pathname}`,
  );
  if (part !== "1") canonical.searchParams.set("p", part);
  return { url: canonical.href, id, part: Number(part) };
}

export function videoLinks(row) {
  return [
    ...new Set(
      parseCards(JSON.parse(row.payload).segments).flatMap(({ url }) => {
        if (!url) return [];
        try {
          return [share(url).url];
        } catch {
          return [];
        }
      }),
    ),
  ];
}

async function resolveVideo(raw, signal, current) {
  const initial = share(raw);
  let next = initial;
  for (let i = 0; i < 5; i++) {
    current();
    if (next.id)
      return {
        ...next,
        part: initial.part === 1 ? next.part : initial.part,
      };
    const checked = await validateWithSignal(
      next.url,
      validateFetchUrl,
      signal,
    );
    const { redirect } = await requestAppUrl(checked.url, checked.addresses, {
      signal,
    });
    if (!redirect) break;
    next = share(new URL(redirect, next.url).href);
  }
  throw Error("VIDEO_SOURCE_DENIED");
}

const fixedHeaders = {
  "user-agent": "Mozilla/5.0",
  referer: "https://www.bilibili.com/",
};

async function getJson(endpoint, params, signal, current) {
  const url =
    "https://api.bilibili.com" + endpoint + "?" + new URLSearchParams(params);
  const { buffer } = await downloadFile(
    url,
    { signal, maxBytes: 1024 * 1024 },
    {
      validate(raw) {
        current();
        if (raw !== url) throw Error("VIDEO_SOURCE_DENIED");
        return validateFetchUrl(raw);
      },
      headers: fixedHeaders,
    },
  );
  const result = JSON.parse(buffer);
  if (result.code !== 0 || !result.data)
    throw Error("VIDEO_SOURCE_UNAVAILABLE");
  return result.data;
}

export async function fetchBilibiliVideo(raw, file, signal, current) {
  try {
    const { id, part } = await resolveVideo(raw, signal, current);
    const key = id.startsWith("BV") ? { bvid: id } : { aid: id.slice(2) };
    const pages = await getJson("/x/player/pagelist", key, signal, current);
    const page = pages?.find(({ page }) => page === part);
    if (!Number.isSafeInteger(page?.cid))
      throw Error("VIDEO_SOURCE_UNAVAILABLE");
    if (
      !Number.isFinite(page.duration) ||
      page.duration <= 0 ||
      page.duration > 30 * 60
    )
      throw Error("VIDEO_LIMIT");
    const play = await getJson(
      "/x/player/playurl",
      {
        ...key,
        cid: page.cid,
        qn: 32,
        fnval: 16,
      },
      signal,
      current,
    );
    const stream = play.dash?.video
      ?.filter(
        ({ height, codecs }) =>
          height > 0 && height <= 480 && /^avc1\./.test(codecs),
      )
      .sort((a, b) => b.height - a.height)[0];
    if (!stream) throw Error("VIDEO_SOURCE_UNAVAILABLE");
    for (const candidate of [
      stream.baseUrl ?? stream.base_url,
      ...(stream.backupUrl ?? stream.backup_url ?? []),
    ]
      .filter(Boolean)
      .slice(0, 3)) {
      current();
      try {
        const { buffer } = await downloadFile(
          candidate,
          { signal, maxBytes },
          {
            validate(raw) {
              current();
              const url = new URL(raw);
              if (
                url.protocol !== "https:" ||
                url.username ||
                url.password ||
                url.port ||
                (!url.hostname.endsWith(".bilivideo.com") &&
                  !url.hostname.endsWith(".bilivideo.cn"))
              )
                throw Error("VIDEO_SOURCE_DENIED");
              return validateFetchUrl(raw);
            },
            headers: { ...fixedHeaders, range: "bytes=0-" },
            allowFullRange: true,
          },
        );
        current();
        await writeFile(file, buffer, { flag: "wx", mode: 0o600, signal });
        return;
      } catch (error) {
        signal.throwIfAborted();
        if (error.message === "FILE_TOO_LARGE")
          throw Error("VIDEO_LIMIT", { cause: error });
      }
    }
  } catch (error) {
    signal.throwIfAborted();
    if (
      [
        "VIDEO_LIMIT",
        "VIDEO_SOURCE_DENIED",
        "APP_PERMISSION_DISABLED",
        "APP_RESTRICTED_CONTEXT",
        "APP_OUTSIDE_HOURS",
        "PROTECTED_WORK_OUTBOUND_DENIED",
      ].includes(error.message)
    )
      throw error;
  }
  throw Error("VIDEO_SOURCE_UNAVAILABLE");
}
