import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Cause, Effect, Exit, ManagedRuntime, Result, Schema } from "effect";
import { readServerOptions, ServerStartupFailed } from "../src/server/server-options";
import { ServerRuntime } from "../src/server/server-runtime";
import { ServerStorage } from "../src/server/server-storage";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".openbot-build/server-storage");
const Mode = Schema.Literals(["seed", "inspect", "retry"]);
type Mode = typeof Mode.Type;
const Report = Schema.Struct({
  type: Schema.Literal("storage-report"),
  node: Schema.String,
  agentId: Schema.String,
  threadId: Schema.String,
  workspacePath: Schema.String,
  sharedRoot: Schema.String,
  downloadsRoot: Schema.String,
  schemaVersion: Schema.Int,
  fileText: Schema.String,
  integrity: Schema.Boolean,
  queue: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      messageId: Schema.String,
      text: Schema.String,
      status: Schema.String,
      position: Schema.NullOr(Schema.Int),
      turnId: Schema.NullOr(Schema.String),
    }),
  ),
  retriedMessageId: Schema.NullOr(Schema.String),
});
const Failure = Schema.Struct({ type: Schema.Literal("failure"), code: Schema.String });
const FIRST_KEY = "server-storage-e2e:first";
const FIRST_TEXT = "Keep this first queued request.";
const SECOND_TEXT = "Keep this second queued request.";
const FILE_TEXT = "Preserve this workspace file across service restarts.";

/** Runs the actual server layer, including its HTTP listener, with no provider or browser stand-ins. */
async function child(): Promise<void> {
  const mode = Schema.decodeUnknownSync(Mode)(process.argv[3]);
  const options = readServerOptions(process.argv.slice(4));
  const runtime = ManagedRuntime.make(ServerRuntime.layer(options));
  const result = await runtime.runPromiseExit(
    Effect.gen(function* () {
      const server = yield* ServerRuntime;
      const storage = yield* ServerStorage;
      assert.equal(process.versions.electron, undefined);
      assert.equal(storage.agents.database, storage.database);
      const health = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}/health/ready`));
      assert.equal(health.status, 200);
      const healthText = yield* Effect.tryPromise(() => health.text());
      assert.equal(healthText.includes(options.dataDirectory), false);

      if (mode === "seed") {
        assert.equal(storage.agents.list().length, 0);
        const agent = yield* storage.agents.createAgent({
          name: "Storage fixture",
          description: "Persistence without execution",
          avatarSeed: "server-storage",
          avatarHue: null,
        });
        assert.equal(agent.threadId, null);
        assert.equal(dirname(agent.workspacePath), join(options.dataDirectory, "files", "Agents"));
        yield* storage.agents.ensureThreadId(agent.id);
        yield* Effect.tryPromise(() => writeFile(join(agent.workspacePath, "retained.txt"), FILE_TEXT));
        yield* storage.mailbox.enqueue({
          sender: { kind: "user" },
          recipientAgentIds: [agent.id],
          text: FIRST_TEXT,
          idempotencyKey: FIRST_KEY,
        });
        yield* storage.mailbox.enqueue({
          sender: { kind: "user" },
          recipientAgentIds: [agent.id],
          text: SECOND_TEXT,
          idempotencyKey: "server-storage-e2e:second",
        });
      }
      const agents = storage.agents.list();
      assert.equal(agents.length, 1);
      const agent = agents[0];
      assert.ok(agent?.threadId);
      let retriedMessageId: string | null = null;
      if (mode === "retry") {
        const receipt = yield* storage.mailbox.enqueue({
          sender: { kind: "user" },
          recipientAgentIds: [agent.id],
          text: FIRST_TEXT,
          idempotencyKey: FIRST_KEY,
        });
        retriedMessageId = receipt.messageId;
      }
      const fileText = yield* Effect.tryPromise(() => readFile(join(agent.workspacePath, "retained.txt"), "utf8"));
      const queue = storage.mailbox.listQueue(agent.id).deliveries.map((delivery) => ({
        id: delivery.id,
        messageId: delivery.messageId,
        text: delivery.text,
        status: delivery.status,
        position: delivery.position,
        turnId: delivery.turnId,
      }));
      return {
        type: "storage-report",
        node: process.versions.node,
        agentId: agent.id,
        threadId: agent.threadId,
        workspacePath: agent.workspacePath,
        sharedRoot: storage.agents.sharedRoot,
        downloadsRoot: storage.agents.downloadsRoot,
        schemaVersion: storage.schemaVersion,
        fileText,
        integrity: storage.database.connection.prepare("PRAGMA integrity_check").get()?.integrity_check === "ok",
        queue,
        retriedMessageId,
      };
    }),
  );
  await runtime.dispose();
  let reply: typeof Report.Type | typeof Failure.Type;
  if (Exit.isFailure(result)) {
    const error = Cause.findError(result.cause);
    const code =
      Result.isSuccess(error) && error.success instanceof ServerStartupFailed ? error.success.code : "storage-action";
    reply = { type: "failure", code };
    process.exitCode = 1;
  } else {
    reply = Schema.decodeUnknownSync(Report)(result.value);
  }
  const send = process.send?.bind(process);
  assert.ok(send);
  await new Promise<void>((resolve, reject) => send(reply, (error) => (error ? reject(error) : resolve())));
  process.disconnect?.();
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const work = await mkdtemp(join(OUT, "run-"));
  const directory = join(work, "data");
  const unrelatedHome = join(work, "unrelated-home");
  const checks: string[] = [];

  async function run(mode: Mode, expectedFailure?: string) {
    const processChild = fork(import.meta.filename, ["--child", mode, "--data-dir", directory], {
      cwd: ROOT,
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        PATHEXT: process.env.PATHEXT,
        HOME: unrelatedHome,
        USERPROFILE: unrelatedHome,
        TEMP: work,
        TMP: work,
        TMPDIR: work,
        TSX_DISABLE_CACHE: "1",
      },
    });
    let message: unknown;
    let output = "";
    processChild.on("message", (value) => (message = value));
    processChild.stdout?.on("data", (value: Buffer) => (output += value.toString()));
    processChild.stderr?.on("data", (value: Buffer) => (output += value.toString()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("The storage process did not exit.")), 30_000);
        timer.unref();
        processChild.once("error", reject);
        processChild.once("close", (code) => resolve(code));
      });
      assert.equal(code, expectedFailure ? 1 : 0, output);
      assert.equal(existsSync(join(directory, ".opskar-server.lock")), false);
      assert.equal(existsSync(unrelatedHome), false);
      if (expectedFailure) {
        assert.equal(Schema.decodeUnknownSync(Failure)(message).code, expectedFailure);
        return null;
      }
      return Schema.decodeUnknownSync(Report)(message);
    } finally {
      clearTimeout(timer);
      if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill();
    }
  }

  let failure: string | null = null;
  try {
    const seeded = await run("seed");
    assert.ok(seeded);
    assert.equal(seeded.fileText, FILE_TEXT);
    assert.equal(seeded.sharedRoot, join(directory, "files", "Shared"));
    assert.equal(seeded.downloadsRoot, join(directory, "files", "Downloads"));
    for (const folder of ["attachment-drafts", "avatars/agents", "files/Shared/Transfers"]) {
      assert.equal(existsSync(join(directory, folder)), true);
    }
    assert.deepEqual(
      seeded.queue.map((delivery) => delivery.text),
      [FIRST_TEXT, SECOND_TEXT],
    );
    assert.ok(seeded.queue.every((delivery) => delivery.status === "queued" && delivery.turnId === null));
    assert.equal(seeded.integrity, true);
    checks.push("One database backs both stores; all new files remain inside the dedicated server directory.");

    const restarted = await run("inspect");
    assert.deepEqual(restarted, seeded);
    checks.push("A new Node process preserves agent ID, thread ID, workspace contents and pending queue order.");

    const retried = await run("retry");
    assert.ok(retried);
    assert.equal(retried.retriedMessageId, seeded.queue[0]?.messageId);
    assert.deepEqual(retried.queue, seeded.queue);
    checks.push("Retrying the persisted message key does not duplicate the queued message.");

    for (const [folder, code] of [
      ["files/Shared", "agent-store"],
      ["attachment-drafts", "mailbox-store"],
    ] as const) {
      const target = join(directory, folder);
      const saved = `${target}.saved`;
      await rename(target, saved);
      await writeFile(target, "A file blocks this fixture directory.");
      try {
        await run("inspect", code);
      } finally {
        await rename(target, `${target}.blocked-fixture`);
        await rename(saved, target);
      }
      const recovered = await run("inspect");
      assert.deepEqual(recovered, seeded);
      checks.push(`${code} initialization failure releases storage; the next process retains all records.`);
    }
    checks.push("Repeated service starts leave both deliveries queued with no turn or execution service.");
  } catch (error) {
    failure = error instanceof Error ? error.message : "Unexpected storage E2E failure.";
    process.exitCode = 1;
  }
  const report = {
    passed: failure === null,
    node: process.versions.node,
    platform: process.platform,
    checks,
    failure,
    work,
  };
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  // Machine-readable: the E2E result and its retained data directory.
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[2] === "--child") await child();
else await main();
