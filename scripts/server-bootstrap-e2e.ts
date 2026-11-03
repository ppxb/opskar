import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".openbot-build/server-bootstrap");
const Ready = Schema.Struct({
  type: Schema.Literal("ready"),
  host: Schema.Literal("127.0.0.1"),
  port: Schema.Int,
  schemaVersion: Schema.Int,
});

interface RunningServer {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output(): string;
}

async function bounded<A>(promise: Promise<A>, label: string): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 30_000);
    timer.unref();
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

await mkdir(OUT, { recursive: true });
const work = await mkdtemp(join(OUT, "run-"));
const children: RunningServer[] = [];
const checks: string[] = [];

function launch(args: string[]): RunningServer {
  let output = "";
  const child = fork(join(ROOT, "src/server/index.ts"), args, {
    cwd: ROOT,
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      PATHEXT: process.env.PATHEXT,
      TEMP: work,
      TMP: work,
      TMPDIR: work,
      TSX_DISABLE_CACHE: "1",
    },
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => (output += chunk));
  child.stderr?.on("data", (chunk: string) => (output += chunk));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const running = { child, exited, output: () => output };
  children.push(running);
  return running;
}

async function start(directory: string, port = 0) {
  const running = launch(["--data-dir", directory, "--port", String(port)]);
  const ready = new Promise<typeof Ready.Type>((resolve, reject) => {
    running.child.once("message", (message) => {
      try {
        resolve(Schema.decodeUnknownSync(Ready)(message));
      } catch (error) {
        reject(error);
      }
    });
  });
  const state = await bounded(
    Promise.race([
      ready,
      running.exited.then(() => {
        throw new Error(`Server exited before readiness: ${running.output()}`);
      }),
    ]),
    "server readiness",
  );
  return { running, state, url: `http://${state.host}:${state.port}` };
}

async function stop(running: RunningServer): Promise<void> {
  if (process.platform === "win32") running.child.send("shutdown");
  else running.child.kill("SIGTERM");
  const result = await bounded(running.exited, "server shutdown");
  assert.equal(result.code, 0, running.output());
  assert.equal(result.signal, null);
}

function storedValue(directory: string): string {
  const database = new DatabaseSync(join(directory, "openbot.db"), { readOnly: true });
  try {
    assert.equal(database.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    const value = database.prepare("SELECT value FROM bootstrap_e2e").get()?.value;
    assert.ok(typeof value === "string");
    return value;
  } finally {
    database.close();
  }
}

let failure: string | null = null;
try {
  const directory = join(work, "data");
  const first = await start(directory);
  const health = await fetch(`${first.url}/health/ready`, { signal: AbortSignal.timeout(5000) });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    status: "ready",
    stage: "storage",
    schemaVersion: first.state.schemaVersion,
    credentialStorage: "unconfigured",
  });
  assert.ok(first.state.schemaVersion > 0);
  assert.equal((await fetch(`${first.url}/v1/agents`, { signal: AbortSignal.timeout(5000) })).status, 404);
  checks.push("Real Node process opens the existing database schema and reports storage readiness only.");

  const duplicate = launch(["--data-dir", directory]);
  assert.equal((await bounded(duplicate.exited, "duplicate refusal")).code, 1);
  assert.ok(duplicate.output().includes("directory-in-use"));
  assert.equal((await fetch(`${first.url}/health/ready`, { signal: AbortSignal.timeout(5000) })).status, 200);
  checks.push("A second process cannot open the same server data directory.");

  const failedDirectory = join(work, "occupied-port");
  const occupied = launch(["--data-dir", failedDirectory, "--port", String(first.state.port)]);
  assert.equal((await bounded(occupied.exited, "listener refusal")).code, 1);
  assert.ok(occupied.output().includes("listener"));
  assert.equal(existsSync(join(failedDirectory, ".opskar-server.lock")), false);
  const recovered = await start(failedDirectory);
  await stop(recovered.running);
  checks.push("A listener failure closes the database and releases the directory for the next start.");

  await stop(first.running);
  assert.equal(existsSync(join(directory, ".opskar-server.lock")), false);
  const database = new DatabaseSync(join(directory, "openbot.db"));
  try {
    database.exec("CREATE TABLE bootstrap_e2e (value TEXT NOT NULL)");
    database.prepare("INSERT INTO bootstrap_e2e (value) VALUES (?)").run("kept-across-restart");
  } finally {
    database.close();
  }
  const restarted = await start(directory);
  assert.equal(restarted.state.schemaVersion, first.state.schemaVersion);
  await stop(restarted.running);
  assert.equal(storedValue(directory), "kept-across-restart");
  checks.push("Clean shutdown and restart preserve stored data and database integrity.");

  const desktop = join(work, "desktop-profile");
  await mkdir(desktop);
  await writeFile(join(desktop, "openbot.db"), "existing-profile-must-not-be-opened");
  const before = createHash("sha256")
    .update(await readFile(join(desktop, "openbot.db")))
    .digest("hex");
  const legacy = launch(["--data-dir", desktop]);
  assert.equal((await bounded(legacy.exited, "desktop profile refusal")).code, 1);
  assert.ok(legacy.output().includes("directory-not-owned"));
  assert.equal(
    createHash("sha256")
      .update(await readFile(join(desktop, "openbot.db")))
      .digest("hex"),
    before,
  );
  assert.equal(existsSync(join(desktop, ".opskar-server")), false);
  assert.equal(existsSync(join(desktop, ".opskar-server.lock")), false);
  checks.push("An existing desktop profile is refused before database access and remains unchanged.");

  const invalidDirectory = join(work, "invalid-options");
  const invalid = launch(["--data-dir", invalidDirectory, "--port", "-1"]);
  assert.equal((await bounded(invalid.exited, "invalid option refusal")).code, 1);
  assert.equal(existsSync(invalidDirectory), false);
  checks.push("Invalid options fail before any data directory is created.");

  const outputDirectory = join(work, "closed-output");
  const closedOutput = launch(["--data-dir", outputDirectory]);
  closedOutput.child.stdout?.destroy();
  assert.equal((await bounded(closedOutput.exited, "closed output cleanup")).code, 1);
  assert.equal(existsSync(join(outputDirectory, "openbot.db")), true);
  assert.equal(existsSync(join(outputDirectory, ".opskar-server.lock")), false);
  const outputRecovered = await start(outputDirectory);
  await stop(outputRecovered.running);
  checks.push("A closed supervisor output releases the listener, database and directory lock.");
} catch (error) {
  failure = error instanceof Error ? error.message : "Unexpected E2E failure.";
  process.exitCode = 1;
} finally {
  for (const running of children) {
    if (running.child.exitCode !== null || running.child.signalCode !== null) continue;
    if (running.child.connected) running.child.send("shutdown");
    else running.child.kill();
    await bounded(running.exited, "test child cleanup").catch(() => running.child.kill());
  }
  const report = {
    passed: failure === null,
    runtime: process.versions.node,
    platform: process.platform,
    shutdown: process.platform === "win32" ? "parent IPC" : "SIGTERM",
    checks,
    failure,
    work,
  };
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  // Machine-readable: the E2E runner reports the result and the retained artifact directory.
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
