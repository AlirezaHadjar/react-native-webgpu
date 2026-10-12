#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const PACKAGE = "dev.webgpu.serializercollision";
const IOS_PROCESS = "Serializercollisionrepro";
const TAG = "SERIALIZER_REPRO ";
const MISSING_CLASS = "No native class registered for brand:";
const EXIT_GRACE_MS = 5000;

const { values: args } = parseArgs({
  options: {
    serial: { type: "string" },
    simulator: { type: "string" },
    repetitions: { type: "string", default: "5" },
    expect: { type: "string", default: "baseline" },
    kinds: { type: "string" },
    tests: { type: "string" },
    output: { type: "string", default: join(import.meta.dirname, "results") },
  },
});
if (!args.serial === !args.simulator) {
  throw new Error("Pass exactly one of --serial or --simulator");
}
if (!["baseline", "fixed"].includes(args.expect)) {
  throw new Error("--expect must be baseline or fixed");
}
const output = resolve(args.output);
mkdirSync(output, { recursive: true });

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const run = (command, ...rest) => {
  const result = spawnSync(command, rest, { encoding: "utf8" });
  return (result.stdout ?? "") + (result.stderr ?? "");
};
const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;

let platform;
if (args.serial) {
  const shell = (...parts) =>
    run("adb", "-s", args.serial, "shell", parts.map(quote).join(" "));
  platform = {
    stop: () => shell("am", "force-stop", PACKAGE),
    launch: (uri) =>
      shell(
        "am",
        "start",
        "-W",
        "-a",
        "android.intent.action.VIEW",
        "-d",
        uri,
        PACKAGE,
      ),
    logger: () => [
      "adb",
      [
        "-s",
        args.serial,
        "logcat",
        "-v",
        "threadtime",
        "-T",
        "1",
        "ReactNativeJS:I",
        "AndroidRuntime:E",
        "*:S",
      ],
    ],
    // threadtime: "MM-DD HH:MM:SS.mmm  PID  TID L Tag: message"
    linePid: (line) => line.trim().split(/\s+/)[2] ?? null,
    alive: (pid) => shell("pidof", PACKAGE).trim().split(/\s+/).includes(pid),
    fatal: (lines, pid) => {
      const text = lines.join("\n");
      if (
        !text.includes("FATAL EXCEPTION") ||
        !text.includes(`Process: ${PACKAGE}, PID: ${pid}`)
      ) {
        return null;
      }
      return text.match(new RegExp(`${MISSING_CLASS} (\\S+)`))?.[1] ?? "other";
    },
  };
} else {
  const simctl = (...parts) => run("xcrun", "simctl", ...parts);
  const alive = (pid) => {
    // Simulator apps are host processes.
    try {
      process.kill(Number(pid), 0);
      return true;
    } catch (error) {
      return error.code === "EPERM";
    }
  };
  platform = {
    stop: () => simctl("terminate", args.simulator, PACKAGE),
    // openurl shows an "Open in ...?" prompt unless the app is already in front.
    launch: async (uri, stderrPath) => {
      const launched = simctl(
        "launch",
        `--stderr=${stderrPath}`,
        args.simulator,
        PACKAGE,
      );
      await sleep(3000);
      return launched + simctl("openurl", args.simulator, uri);
    },
    logger: () => [
      "xcrun",
      [
        "simctl",
        "spawn",
        args.simulator,
        "log",
        "stream",
        "--style",
        "compact",
        "--level",
        "info",
        "--predicate",
        `process == "${IOS_PROCESS}"`,
      ],
    ],
    linePid: (line) =>
      line.match(new RegExp(`${IOS_PROCESS}\\[(\\d+):`))?.[1] ?? null,
    alive,
    fatal: (lines, pid, stderrPath) => {
      if (alive(pid)) {
        return null;
      }
      // libc++abi prints the uncaught exception to stderr; the crash report omits it.
      const text =
        lines.join("\n") +
        (existsSync(stderrPath) ? readFileSync(stderrPath, "utf8") : "");
      return text.match(new RegExp(`${MISSING_CLASS} (\\S+)`))?.[1] ?? "other";
    },
  };
}

const events = (lines) =>
  lines.flatMap((line) => {
    if (!line.includes(TAG)) {
      return [];
    }
    try {
      return [JSON.parse(line.split(TAG)[1])];
    } catch {
      return [];
    }
  });
const pidLines = (text, pid) =>
  text.split("\n").filter((line) => platform.linePid(line) === pid);
const runPid = (text, order, test, kind) => {
  for (const line of text.split("\n")) {
    const [row] = events([line]);
    if (
      row?.event === "start" &&
      row.order === order &&
      row.test === test &&
      row.kind === kind
    ) {
      return platform.linePid(line);
    }
  }
  return null;
};
const last = (data, event) => data.filter((row) => row.event === event).at(-1);
const directOutcome = (data) => {
  const box = last(data, "direct-webgpu-box");
  const wrong = last(data, "direct-webgpu-unbox");
  const right = last(data, "direct-skia-unbox");
  if (right?.success !== true || !box) {
    return "direct-invalid";
  }
  if (box.success === false) {
    return "direct-rejected";
  }
  if (last(data, "classify")?.webgpuAccepts === false) {
    return "direct-not-claimed";
  }
  if (wrong?.success === false && wrong.error?.includes(MISSING_CLASS)) {
    return "direct-wrong-decoder";
  }
  return "direct-invalid";
};

const baseline = [
  ["webgpu-first", "direct", "rect", "direct-wrong-decoder"],
  ["skia-first", "direct", "rect", "direct-wrong-decoder"],
  ["webgpu-first", "transfer", "rect", "crash"],
  ["skia-first", "transfer", "rect", "success"],
  ["webgpu-first", "transfer", "plain", "success"],
  ["webgpu-first", "transfer", "buffer", "success"],
  ["skia-first", "transfer", "buffer", "success"],
  ["webgpu-first", "transfer", "paint", "crash"],
  ["skia-first", "transfer", "paint", "success"],
  ["webgpu-first", "roundtrip", "rect", "crash"],
  ["skia-first", "roundtrip", "rect", "success"],
  ["webgpu-first", "roundtrip", "buffer", "success"],
  ["skia-first", "roundtrip", "buffer", "success"],
  ["webgpu-first", "roundtrip", "proto", "success"],
  ["skia-first", "roundtrip", "proto", "success"],
];
const kinds = args.kinds?.split(",");
const tests = args.tests?.split(",");
const cases = baseline
  .map(([order, test, kind, stock]) => [
    order,
    test,
    kind,
    args.expect === "baseline"
      ? stock
      : test === "direct"
        ? "direct-not-claimed"
        : "success",
  ])
  .filter(
    ([, test, kind]) =>
      (!kinds || kinds.includes(kind)) && (!tests || tests.includes(test)),
  );

const results = [];
for (const [order, test, kind, expected] of cases) {
  for (let trial = 1; trial <= Number(args.repetitions); trial++) {
    const key = `${order}-${test}-${kind}-${trial}`;
    const logPath = join(output, `${key}.log`);
    const stderrPath = join(output, `${key}-stderr.txt`);
    const uri = `serializer-repro://run?order=${order}&test=${test}&kind=${kind}`;
    platform.stop();
    let actual = "timeout";
    let pid = null;
    let crashBrand = null;
    let exitMs = null;

    const fd = openSync(logPath, "w");
    const [command, loggerArgs] = platform.logger();
    const logger = spawn(command, loggerArgs, { stdio: ["ignore", fd, fd] });
    const loggerExited = new Promise((done) => logger.on("exit", done));
    try {
      if (args.simulator) {
        await sleep(1000); // log stream attaches asynchronously
      }
      writeFileSync(
        join(output, `${key}-launch.txt`),
        await platform.launch(uri, stderrPath),
      );
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        await sleep(300);
        const text = readFileSync(logPath, "utf8");
        pid ??= runPid(text, order, test, kind);
        if (!pid) {
          continue;
        }
        const lines = pidLines(text, pid);
        const data = events(lines);
        if (last(data, "setup-error")) {
          actual = "setup-error";
          break;
        }
        if (last(data, "worklet-error")) {
          actual = "worklet-error";
          break;
        }
        crashBrand = platform.fatal(lines, pid, stderrPath);
        if (crashBrand) {
          actual = crashBrand === "other" ? "crash-other" : "crash";
          break;
        }
        if (last(data, "done")) {
          actual = test === "direct" ? directOutcome(data) : "success";
          break;
        }
      }
      if (actual.startsWith("crash")) {
        const start = Date.now();
        while (Date.now() - start < EXIT_GRACE_MS) {
          if (!platform.alive(pid)) {
            exitMs = Date.now() - start;
            break;
          }
          await sleep(200);
        }
      } else if (
        !["timeout", "setup-error", "worklet-error"].includes(actual)
      ) {
        await sleep(500);
        if (!platform.alive(pid)) {
          actual = "exited";
        }
      }
    } finally {
      logger.kill("SIGTERM");
      await loggerExited;
      closeSync(fd);
    }

    const result = {
      order,
      test,
      kind,
      trial,
      expected,
      actual,
      matches: actual === expected,
      pid,
      crashBrand,
      processExitedWithinGrace: actual.startsWith("crash")
        ? exitMs !== null
        : null,
      exitSeconds: exitMs === null ? null : exitMs / 1000,
      events: pid ? events(pidLines(readFileSync(logPath, "utf8"), pid)) : [],
      log: logPath,
    };
    results.push(result);
    writeFileSync(
      join(output, "results.json"),
      JSON.stringify(results, null, 2) + "\n",
    );
    const { events: _, log: __, ...row } = result;
    console.log(JSON.stringify(row));
  }
}

const summary = cases.map(([order, test, kind, expected]) => {
  const rows = results.filter(
    (row) => row.order === order && row.test === test && row.kind === kind,
  );
  const outcomes = {};
  for (const row of rows) {
    outcomes[row.actual] = (outcomes[row.actual] ?? 0) + 1;
  }
  return {
    order,
    test,
    kind,
    expected,
    trials: rows.length,
    matching: rows.filter((row) => row.matches).length,
    outcomes,
  };
});
writeFileSync(
  join(output, "summary.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
console.log(JSON.stringify(summary, null, 2));
if (!results.every((row) => row.matches)) {
  console.error("At least one result differed from the expected behavior.");
  process.exitCode = 1;
}
