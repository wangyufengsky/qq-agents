import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { analyzeMessageTiming } from "../src/core/message-timing-analysis.mjs";
import { runMessageTimingBenchmark } from "./fixtures/message-timing-benchmark.mjs";

const usage = `消息链路时序
  node scripts/message-timing.mjs --synthetic [--repo-root 源码目录]
    [--baseline-root 旧版源码目录] [--samples 100] [--seed 874137] [--out 新文件.json]
  node scripts/message-timing.mjs --analyze 导出的时序快照.json [--out 新文件.json]

合成模式使用临时配置、内存 SQLite、假模型和假 QQ，按同一种子配对运行。
试验时延使用虚拟时间，未确认的试验单独计数。
离线分析只计算快照保留的已完成样本，进行中、过期和超容量的采集另列计数。
`;

try {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean", short: "h" },
      synthetic: { type: "boolean" },
      analyze: { type: "string" },
      "repo-root": { type: "string" },
      "baseline-root": { type: "string" },
      samples: { type: "string" },
      seed: { type: "string" },
      out: { type: "string" },
    },
  });
  if (values.help) {
    process.stdout.write(usage);
  } else {
    let result;
    if (values.synthetic && values.analyze === undefined) {
      const integer = (value) => value === undefined || /^\d+$/.test(value);
      if (!integer(values.samples) || !integer(values.seed))
        throw Error("INVALID_BENCHMARK_OPTIONS");
      result = await runMessageTimingBenchmark({
        repoRoot: path.resolve(
          values["repo-root"] || fileURLToPath(new URL("..", import.meta.url)),
        ),
        baselineRoot:
          values["baseline-root"] && path.resolve(values["baseline-root"]),
        ...(values.samples === undefined
          ? {}
          : { samples: Number(values.samples) }),
        ...(values.seed === undefined ? {} : { seed: Number(values.seed) }),
      });
    } else if (
      values.analyze &&
      !values.synthetic &&
      ["repo-root", "baseline-root", "samples", "seed"].every(
        (option) => values[option] === undefined,
      )
    ) {
      if (path.extname(values.analyze).toLowerCase() !== ".json")
        throw Error("INVALID_MESSAGE_TIMING_SNAPSHOT");
      const file = fs.statSync(values.analyze);
      if (!file.isFile() || file.size > 16 * 1024 * 1024)
        throw Error("INVALID_MESSAGE_TIMING_SNAPSHOT");
      result = analyzeMessageTiming(
        JSON.parse(fs.readFileSync(values.analyze, "utf8")),
      );
    } else {
      throw Error("MESSAGE_TIMING_MODE_REQUIRED");
    }
    const output = JSON.stringify(result, null, 2) + "\n";
    if (values.out)
      fs.writeFileSync(values.out, output, { flag: "wx", mode: 0o600 });
    else process.stdout.write(output);
  }
} catch (error) {
  const code = /^[A-Z][A-Z_]+$/.test(error?.message)
    ? error.message
    : "MESSAGE_TIMING_COMMAND_FAILED";
  process.stderr.write(code + "\n" + usage);
  process.exitCode = 1;
}
