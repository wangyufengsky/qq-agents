import { spawn } from "node:child_process";
import { withBrowserLock } from "../../vendor/social-reader/browser-lock.mjs";
import { appInfo } from "./urls.mjs";
export const APP_CAPABILITIES = {
  bilibili: {
    browse: {
      following: { semantic: "following-timeline", pagination: true },
      hot: { semantic: "popular-list", pagination: true },
      ranking: { semantic: "ranking", pagination: false },
    },
    search: "page",
    read: true,
    comments: "sample",
    recommendations: false,
  },
  zhihu: {
    browse: {
      recommend: { semantic: "personalized-recommendations", pagination: true },
      hot: { semantic: "hot-list", pagination: false },
    },
    search: "cursor",
    read: true,
    comments: "sample",
  },
  xiaohongshu: {
    browse: {
      recommend: {
        semantic: "personalized-recommendations",
        pagination: "scroll",
      },
    },
    search: "first-page",
    read: true,
    comments: "sample",
  },
  tieba: {
    browse: {
      hot: { semantic: "hot-topics", pagination: false },
      board: { semantic: "forum-posts", pagination: true },
    },
    search: "first-page",
    read: true,
    comments: "page",
  },
  heybox: {
    browse: {
      recommend: {
        semantic: "recommendations-account-dependent",
        pagination: true,
      },
      board: { semantic: "forum-posts", pagination: true },
    },
    search: "scroll",
    read: true,
    comments: "offset",
  },
};
export class AppAdapter {
  constructor({ run, lockOptions = {} } = {}) {
    this.run = run || this.child;
    this.lockOptions = lockOptions;
    this.probes = new Map();
  }
  async child(job, signal) {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [new URL("./opencli-runner.mjs", import.meta.url).pathname],
        {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, NO_COLOR: "1" },
          signal,
        },
      );
      let output = "",
        bytes = 0;
      const timeout = setTimeout(() => child.kill("SIGTERM"), 60000);
      child.stdout.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) {
          child.kill();
          reject(Error("APP_OUTPUT_LIMIT"));
        } else output += chunk;
      });
      child.stderr.on("data", () => {});
      child.on("error", () => {
        clearTimeout(timeout);
        reject(Error("APP_BACKEND_FAILED"));
      });
      child.on("close", () => {
        clearTimeout(timeout);
        try {
          const v = JSON.parse(output);
          if (!v.ok) throw Error(v.error);
          resolve(v.result);
        } catch (e) {
          reject(
            Error(
              /^APP_[A-Z_]+$/.test(e.message)
                ? e.message
                : "APP_BACKEND_FAILED",
            ),
          );
        }
      });
      child.stdin.end(JSON.stringify(job));
    });
  }
  async perform(job, { signal } = {}) {
    appInfo(job.platform);
    if (
      job.operation === "browse" &&
      !APP_CAPABILITIES[job.platform].browse[job.entry]
    )
      throw Error("APP_ENTRY_UNSUPPORTED");
    try {
      const result = await withBrowserLock(() => this.run(job, signal), {
        ...this.lockOptions,
        signal,
      });
      this.probes.set(job.platform, {
        at: new Date().toISOString(),
        operation: job.operation,
        status: job.operation === "status" ? result.status || "checked" : "ok",
        ...(job.operation === "status" ? { loggedIn: result.loggedIn } : {}),
      });
      return result;
    } catch (error) {
      const code = /^APP_[A-Z_]+$/.test(error.message)
        ? error.message
        : "APP_BACKEND_FAILED";
      this.probes.set(job.platform, {
        at: new Date().toISOString(),
        operation: job.operation,
        status: code,
      });
      throw Error(code);
    }
  }
  capabilities() {
    return Object.entries(APP_CAPABILITIES).map(([platform, value]) => ({
      ...appInfo(platform),
      ...value,
      lastProbe: this.probes.get(platform) || { status: "not-tested" },
      sharedAccountNotice:
        "同一平台账号的推荐可能受两个 AI 的浏览共同影响；本程序按主体隔离记录和意图。",
      videoUnderstanding: false,
      platformWrites: false,
    }));
  }
}
