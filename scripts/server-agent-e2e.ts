import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  LocalAgentCreateResult,
  LocalConversationPage,
  LocalMessageInput,
  LocalMessageReceipt,
  LocalWorkspaceSnapshot,
} from "@openbot/contracts/server-workspace";
import { redactText, registerSecretValue } from "@openbot/logging";
import { Effect, ManagedRuntime, Schema } from "effect";
import { type Browser, chromium, type Page } from "playwright-core";
import { readServerOptions } from "../src/server/server-options";
import { ServerStorage } from "../src/server/server-storage";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".openbot-build/server-agent");
const MODEL = "opskar-fixture-coder";
const AGENT_NAME = "Execution fixture";
const FILE_NAME = "server-agent-proof.txt";
const FILE_TEXT = "This file was written by the real OpenCode tool.\n";
const WRITE_MARKER = "OPSKAR_E2E_WRITE";
const RECONNECT_MARKER = "OPSKAR_E2E_RECONNECT";
const RESTART_MARKER = "OPSKAR_E2E_RESTART";
const RECOVERY_MARKER = "OPSKAR_E2E_RECOVERY";
const HOLD_MARKER = "OPSKAR_E2E_HOLD";
const WRITE_PROMPT = `${WRITE_MARKER}: Create ${FILE_NAME} in your workspace with this exact content: ${FILE_TEXT.trim()}`;
const RECONNECT_PROMPT = `${RECONNECT_MARKER}: Confirm this message after the browser reconnects.`;
const RESTART_PROMPT = `${RESTART_MARKER}: Use the earlier file-writing context to confirm this new turn.`;
const RECOVERY_PROMPT = `${RECOVERY_MARKER}: Complete this queued message after the Provider configuration is corrected.`;
const HOLD_PROMPT = `${HOLD_MARKER}: Wait for the operator to stop this turn.`;
const WRITE_REPLY = "The file was written by the real OpenCode tool.";
const RECONNECT_REPLY = "The missed conversation update is now visible.";
const RESTART_REPLY = "The real agent resumed with the earlier conversation.";
const RECOVERY_REPLY = "The queued message completed after the Provider correction.";
const TOOL_CALL_ID = "call_opskar_file_write";
const Ready = Schema.Struct({ type: Schema.Literal("ready"), host: Schema.Literal("127.0.0.1"), port: Schema.Int });
const Change = Schema.Struct({ revision: Schema.Int });
const ServiceAddress = Schema.Struct({ port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })) });
const StoredDelivery = Schema.Struct({
  deliveryId: Schema.String,
  status: Schema.String,
  turnId: Schema.NullOr(Schema.String),
});
const TextPart = Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) });
const ChatMessage = Schema.Struct({
  role: Schema.String,
  content: Schema.optional(Schema.Union([Schema.String, Schema.Null, Schema.Array(TextPart)])),
  tool_call_id: Schema.optional(Schema.String),
});
const ChatTool = Schema.Struct({
  type: Schema.Literal("function"),
  function: Schema.Struct({
    name: Schema.String,
    parameters: Schema.optional(
      Schema.Struct({ properties: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) }),
    ),
  }),
});
const ChatRequest = Schema.Struct({
  model: Schema.String,
  stream: Schema.optional(Schema.Boolean),
  messages: Schema.Array(ChatMessage),
  tools: Schema.optional(Schema.Array(ChatTool)),
});

interface RunningServer {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output(): string;
}

type StreamFrame = { type: "change"; revision: number } | { type: "session-ended" };
type ToolCall = { name: string; arguments: string };
type FixtureAction = "auxiliary" | "write-tool" | "write-result" | "reconnect" | "restart" | "recovery" | "hold";

async function bounded<A>(promise: Promise<A>, label: string, timeoutMs = 60_000): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

await mkdir(OUT, { recursive: true });
const work = await mkdtemp(join(OUT, "run-"));
const dataDirectory = join(work, "data");
const keyFile = join(work, "credential.key");
const passwordFile = join(work, "console-password.key");
const master = randomBytes(32).toString("base64");
const password = randomBytes(24).toString("base64url");
const apiKey = `agent-e2e-${randomBytes(24).toString("hex")}`;
const protectedValues = [master, password, apiKey, Buffer.from(master, "base64").toString("hex")];
for (const secret of protectedValues) registerSecretValue(secret, { allowShort: true });
await writeFile(keyFile, `${master}\n`, { mode: 0o600 });
await writeFile(passwordFile, `${password}\n`, { mode: 0o600 });
await chmod(keyFile, 0o600);
await chmod(passwordFile, 0o600);

const children: RunningServer[] = [];
const streams: WorkspaceEvents[] = [];
const checks: string[] = [];
const browserErrors: string[] = [];
const failedAssets: { path: string; status: number }[] = [];
const externalBrowserRequests: { host: string; path: string }[] = [];
const fixtureRequests: {
  action: FixtureAction;
  authorized: boolean;
  model: string;
  tools: string[];
  toolResult: boolean;
  hadWriteHistory: boolean;
}[] = [];
const fixtureSockets = new Set<Socket>();
const stoppedServicePorts: number[] = [];
let socketChanged = Promise.withResolvers<void>();
let heldRequest = Promise.withResolvers<void>();
let heldClosed = Promise.withResolvers<void>();
let browser: Browser | undefined;
let page: Page | undefined;
let fixtureFailure: string | null = null;
let targetFile: string | null = null;
let selectedTool: { name: string; parameters: string[] } | null = null;
let writeCalls = 0;
let failure: string | null = null;
let failureVisibleText: string | null = null;
let failureScreenshot: string | null = null;
let workspaceId: string | null = null;
let agentId: string | null = null;
let threadId: string | null = null;
let cliPath: string | null = null;
let recoveryEvidence: {
  messageId: string;
  deliveryId: string;
  before: string;
  after: string;
  modelRequests: number;
} | null = null;

function checkSecrets(text: string): void {
  assert.ok(
    protectedValues.every((secret) => !text.includes(secret)),
    "A secret appeared in an API, event or browser reply.",
  );
}

function messageContent(message: typeof ChatMessage.Type): string {
  if (typeof message.content === "string") return message.content;
  return message.content?.map((part) => part.text ?? "").join("\n") ?? "";
}

function fileTool(input: typeof ChatRequest.Type): ToolCall {
  assert.ok(targetFile, "The fixture has no selected agent workspace.");
  const tools = input.tools ?? [];
  const direct = tools.find((tool) => /^(?:opencode_)?write$/u.test(tool.function.name));
  if (direct) {
    const parameters = Object.keys(direct.function.parameters?.properties ?? {});
    selectedTool = { name: direct.function.name, parameters };
    const pathKey = parameters.includes("path") ? "path" : parameters.includes("filePath") ? "filePath" : null;
    assert.ok(
      pathKey && parameters.includes("content"),
      `The real write tool has an unsupported parameter shape: ${parameters.join(", ")}`,
    );
    return { name: direct.function.name, arguments: JSON.stringify({ [pathKey]: targetFile, content: FILE_TEXT }) };
  }
  const system = input.messages
    .filter((message) => message.role === "system")
    .map(messageContent)
    .join("\n");
  const code = tools.find(
    (tool) =>
      /^(?:execute|exec|code)$/u.test(tool.function.name) && "code" in (tool.function.parameters?.properties ?? {}),
  );
  if (code && /tools\.opencode\.write\s*\(/u.test(system)) {
    selectedTool = { name: code.function.name, parameters: Object.keys(code.function.parameters?.properties ?? {}) };
    return {
      name: code.function.name,
      arguments: JSON.stringify({
        code: `await tools.opencode.write(${JSON.stringify({ filePath: targetFile, content: FILE_TEXT })});`,
      }),
    };
  }
  throw new Error(
    `The real OpenCode request has no supported file tool. Tools: ${tools.map((tool) => tool.function.name).join(", ")}`,
  );
}

function completion(response: ServerResponse, input: typeof ChatRequest.Type, text: string, tool?: ToolCall): void {
  const toolCalls = tool ? [{ id: TOOL_CALL_ID, type: "function", function: tool }] : undefined;
  const finish = tool ? "tool_calls" : "stop";
  if (!input.stream) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        id: "chatcmpl-opskar-e2e",
        object: "chat.completion",
        created: 0,
        model: MODEL,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: tool ? null : text,
              ...(toolCalls ? { tool_calls: toolCalls } : {}),
            },
            finish_reason: finish,
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      }),
    );
    return;
  }
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const delta = tool
    ? { role: "assistant", tool_calls: [{ index: 0, id: TOOL_CALL_ID, type: "function", function: tool }] }
    : { role: "assistant", content: text };
  response.write(
    `data: ${JSON.stringify({ id: "chatcmpl-opskar-e2e", object: "chat.completion.chunk", created: 0, model: MODEL, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({ id: "chatcmpl-opskar-e2e", object: "chat.completion.chunk", created: 0, model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

async function readChat(request: IncomingMessage): Promise<typeof ChatRequest.Type> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const part = Buffer.from(chunk);
    bytes += part.byteLength;
    assert.ok(bytes <= 4 * 1024 * 1024, "The fixture request exceeded its size limit.");
    chunks.push(part);
  }
  return Schema.decodeUnknownSync(ChatRequest)(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

const fixture = createServer((request, response) => {
  void (async () => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    const input = await readChat(request);
    const authorized = request.headers.authorization === `Bearer ${apiKey}`;
    assert.ok(authorized, "The real Provider request did not use the saved API key.");
    assert.equal(input.model, MODEL);
    const tools = (input.tools ?? []).map((tool) => tool.function.name);
    // OpenCode can append a user-role tool reminder. Follow the latest marked task, not that reminder.
    const latestUser = input.messages
      .filter(
        (message) =>
          message.role === "user" &&
          [WRITE_MARKER, RECONNECT_MARKER, RESTART_MARKER, RECOVERY_MARKER, HOLD_MARKER].some((marker) =>
            messageContent(message).includes(marker),
          ),
      )
      .at(-1);
    const prompt = latestUser ? messageContent(latestUser) : "";
    const hadWriteHistory = input.messages.some((message) => messageContent(message).includes(WRITE_MARKER));
    const toolResult = input.messages.some(
      (message) => message.role === "tool" && message.tool_call_id === TOOL_CALL_ID,
    );
    const action: FixtureAction =
      tools.length === 0
        ? "auxiliary"
        : prompt.includes(HOLD_MARKER)
          ? "hold"
          : prompt.includes(RECONNECT_MARKER)
            ? "reconnect"
            : prompt.includes(RESTART_MARKER)
              ? "restart"
              : prompt.includes(RECOVERY_MARKER)
                ? "recovery"
                : prompt.includes(WRITE_MARKER)
                  ? toolResult
                    ? "write-result"
                    : "write-tool"
                  : "auxiliary";
    fixtureRequests.push({ action, authorized, model: input.model, tools, toolResult, hadWriteHistory });
    if (action === "hold") {
      const closed = heldClosed;
      response.once("close", () => closed.resolve());
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      response.write(
        `data: ${JSON.stringify({ id: "chatcmpl-held", object: "chat.completion.chunk", created: 0, model: MODEL, choices: [{ index: 0, delta: { role: "assistant", content: "Waiting for cancellation." }, finish_reason: null }] })}\n\n`,
      );
      heldRequest.resolve();
      return;
    }
    if (action === "write-tool") {
      assert.ok(++writeCalls <= 2, "The real file tool never returned a result.");
      completion(response, input, "", fileTool(input));
    } else if (action === "write-result") completion(response, input, `${WRITE_REPLY} Private value ${apiKey}`);
    else if (action === "restart") completion(response, input, RESTART_REPLY);
    else if (action === "recovery") completion(response, input, RECOVERY_REPLY);
    else completion(response, input, action === "reconnect" ? RECONNECT_REPLY : "Execution fixture ready.");
  })().catch((error: unknown) => {
    fixtureFailure ??= redactText(error instanceof Error ? error.message : "The Provider fixture failed.");
    if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "The local Provider fixture rejected the request." } }));
  });
});
fixture.on("connection", (socket) => {
  fixtureSockets.add(socket);
  socket.once("close", () => {
    fixtureSockets.delete(socket);
    socketChanged.resolve();
    socketChanged = Promise.withResolvers<void>();
  });
});

class WorkspaceEvents {
  readonly frames: StreamFrame[] = [];
  readonly done: Promise<void>;
  #changed = Promise.withResolvers<void>();
  #closed = false;
  #failure: string | null = null;

  constructor(
    response: Response,
    readonly controller: AbortController,
  ) {
    this.done = this.#read(response);
  }

  async #read(response: Response): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) {
      this.#failure = "The workspace event stream has no body.";
      this.#closed = true;
      this.#changed.resolve();
      return;
    }
    const decoder = new TextDecoder();
    let pending = "";
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        pending = (pending + decoder.decode(part.value, { stream: true })).replaceAll("\r\n", "\n");
        assert.ok(pending.length <= 64 * 1024, "The workspace event frame exceeded its size limit.");
        for (let end = pending.indexOf("\n\n"); end >= 0; end = pending.indexOf("\n\n")) {
          const frame = pending.slice(0, end);
          pending = pending.slice(end + 2);
          checkSecrets(frame);
          const lines = frame.split("\n");
          const name = lines
            .find((line) => line.startsWith("event:"))
            ?.slice(6)
            .trim();
          const data = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          if (name === "change")
            this.frames.push({ type: "change", ...Schema.decodeUnknownSync(Change)(JSON.parse(data)) });
          else if (name === "session-ended") this.frames.push({ type: "session-ended" });
          else throw new Error("The workspace sent an unknown event type.");
          this.#changed.resolve();
          this.#changed = Promise.withResolvers<void>();
        }
      }
    } catch (error) {
      if (!this.controller.signal.aborted)
        this.#failure = redactText(error instanceof Error ? error.message : "The event stream failed.");
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      this.#closed = true;
      this.#changed.resolve();
    }
  }

  async after(index: number): Promise<StreamFrame> {
    for (;;) {
      const frame = this.frames[index];
      if (frame) return frame;
      if (this.#closed) throw new Error(this.#failure ?? "The workspace event stream closed.");
      await this.#changed.promise;
    }
  }

  async stop(): Promise<void> {
    this.controller.abort();
    await this.done;
    if (this.#failure) throw new Error(this.#failure);
  }
}

async function events(url: string, cookie: string): Promise<WorkspaceEvents> {
  const controller = new AbortController();
  const response = await bounded(
    fetch(`${url}/api/workspace/events`, { headers: { Origin: url, Cookie: cookie }, signal: controller.signal }),
    "event stream headers",
  ).catch((error: unknown) => {
    controller.abort();
    throw error;
  });
  assert.equal(response.status, 200);
  assert.ok(response.headers.get("content-type")?.includes("text/event-stream"));
  const stream = new WorkspaceEvents(response, controller);
  streams.push(stream);
  assert.equal((await bounded(stream.after(0), "initial workspace event")).type, "change");
  return stream;
}

async function stateAfterEvents<A>(
  stream: WorkspaceEvents,
  label: string,
  read: () => Promise<A | undefined>,
): Promise<A> {
  return await bounded(
    (async () => {
      for (;;) {
        const index = stream.frames.length;
        const state = await read();
        if (state !== undefined) return state;
        const frame = await stream.after(index);
        assert.equal(frame.type, "change", "The session ended before the expected state.");
      }
    })(),
    label,
  );
}

function launch(path: string, execute = true): RunningServer {
  let output = "";
  const child = fork(
    join(ROOT, "src/server/index.ts"),
    ["--web", ...(execute ? ["--execute", "--opencode-path", path] : []), "--data-dir", dataDirectory, "--port", "0"],
    {
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
        OPSKAR_WEB_PASSWORD_FILE: passwordFile,
        OPSKAR_CREDENTIAL_KEY_FILE: keyFile,
      },
    },
  );
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

async function start(path: string, execute = true) {
  const running = launch(path, execute);
  const ready = new Promise<typeof Ready.Type>((resolve, reject) => {
    running.child.once("message", (message) => {
      try {
        resolve(Schema.decodeUnknownSync(Ready)(message));
      } catch {
        reject(new Error("The Node server sent invalid readiness data."));
      }
    });
  });
  const state = await bounded(
    Promise.race([
      ready,
      running.exited.then(() => {
        throw new Error(`The Node server exited before readiness: ${redactText(running.output())}`);
      }),
    ]),
    "Node server readiness",
  );
  return { running, url: `http://${state.host}:${state.port}` };
}

async function stop(running: RunningServer): Promise<void> {
  running.child.send("shutdown");
  const result = await bounded(running.exited, "Node and Provider shutdown");
  assert.equal(result.code, 0, redactText(running.output()));
  assert.equal(result.signal, null);
}

async function checkServiceStopped(): Promise<void> {
  const { port } = Schema.decodeUnknownSync(ServiceAddress)(
    JSON.parse(await readFile(join(dataDirectory, "provider-runtime", "service.json"), "utf8")),
  );
  const connected = await new Promise<boolean>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error) => {
      if ("code" in error && error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
    socket.setTimeout(5000, () => socket.destroy(new Error("The recorded OpenCode service port did not answer.")));
  });
  assert.equal(connected, false, "The owned OpenCode service still accepts connections after Node shutdown.");
  stoppedServicePorts.push(port);
}

async function api(url: string, path: string, cookie = "", method = "GET", body?: string) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      Origin: url,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  checkSecrets(text);
  return { status: response.status, headers: response.headers, text };
}

async function login(url: string): Promise<string> {
  const response = await api(url, "/api/session", "", "POST", JSON.stringify({ password }));
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const token = cookie.slice(cookie.indexOf("=") + 1);
  protectedValues.push(token);
  registerSecretValue(token);
  return cookie;
}

async function workspace(url: string, cookie: string) {
  const response = await api(url, "/api/workspace", cookie);
  assert.equal(response.status, 200);
  return Schema.decodeUnknownSync(LocalWorkspaceSnapshot)(JSON.parse(response.text));
}

function agentPath(id: string): string {
  return `/api/workspace/agents/${encodeURIComponent(id)}`;
}

async function conversation(url: string, cookie: string, id: string) {
  const response = await api(url, `${agentPath(id)}/conversation`, cookie);
  assert.equal(response.status, 200);
  return Schema.decodeUnknownSync(LocalConversationPage)(JSON.parse(response.text));
}

async function send(url: string, cookie: string, id: string, text: string, clientMessageId: string): Promise<string> {
  const response = await api(
    url,
    `${agentPath(id)}/messages`,
    cookie,
    "POST",
    JSON.stringify({ text, clientMessageId }),
  );
  assert.equal(response.status, 200);
  return Schema.decodeUnknownSync(LocalMessageReceipt)(JSON.parse(response.text)).messageId;
}

async function queueRecovery(id: string): Promise<{ messageId: string; deliveryId: string }> {
  const runtime = ManagedRuntime.make(ServerStorage.layer(readServerOptions(["--data-dir", dataDirectory], {})));
  try {
    return await runtime.runPromise(
      Effect.gen(function* () {
        const storage = yield* ServerStorage;
        const receipt = yield* storage.mailbox.enqueue({
          sender: { kind: "user" },
          recipientAgentIds: [id],
          text: RECOVERY_PROMPT,
          idempotencyKey: "server-agent-e2e:provider-recovery",
        });
        const delivery = receipt.deliveries[0];
        assert.ok(delivery);
        assert.equal(
          storage.mailbox.listQueue(id).deliveries.find((item) => item.id === delivery.id)?.status,
          "queued",
        );
        return { messageId: receipt.messageId, deliveryId: delivery.id };
      }),
    );
  } finally {
    await runtime.dispose();
  }
}

function storedDelivery(id: string, messageId: string): typeof StoredDelivery.Type {
  const database = new DatabaseSync(join(dataDirectory, "openbot.db"), { readOnly: true });
  try {
    const rows = Schema.decodeUnknownSync(Schema.Array(StoredDelivery))(
      database
        .prepare(
          "SELECT delivery_id AS deliveryId, status, turn_id AS turnId FROM projection_deliveries WHERE recipient_agent_id = ? AND message_id = ?",
        )
        .all(id, messageId),
    );
    assert.equal(rows.length, 1, "The recovery message has missing or duplicate delivery rows.");
    const row = rows[0];
    assert.ok(row);
    return row;
  } finally {
    database.close();
  }
}

try {
  cliPath = process.argv[2] ?? process.env.OPSKAR_E2E_OPENCODE_PATH ?? process.env.OPENCODE_CLI ?? null;
  assert.ok(cliPath, "Supply the real OpenCode executable through OPSKAR_E2E_OPENCODE_PATH or the first argument.");
  await new Promise<void>((resolve, reject) => {
    fixture.once("error", reject);
    fixture.listen(0, "127.0.0.1", () => {
      fixture.removeListener("error", reject);
      resolve();
    });
  });
  const address = fixture.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const first = await start(cliPath);
  assert.equal((await api(first.url, "/api/workspace/agents", "", "POST", "{}")).status, 401);
  const cookie = await login(first.url);
  const observer = await events(first.url, cookie);
  const initial = await workspace(first.url, cookie);
  workspaceId = initial.workspaceId;
  assert.equal(initial.mode, "interactive");
  assert.equal(initial.execution.state, "unconfigured");

  browser = await chromium.launch(
    process.env.OPSKAR_E2E_BROWSER_PATH
      ? { executablePath: process.env.OPSKAR_E2E_BROWSER_PATH, headless: true }
      : { ...(process.platform === "win32" ? { channel: "msedge" } : {}), headless: true },
  );
  const context = await browser.newContext({ viewport: { width: 1365, height: 1000 }, serviceWorkers: "block" });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (["http:", "https:"].includes(url.protocol) && url.origin !== first.url) {
      externalBrowserRequests.push({ host: url.host, path: redactText(url.pathname) });
      await route.abort("blockedbyclient");
    } else await route.continue();
  });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => {
    if (browserErrors.length < 50) browserErrors.push(redactText(error.message));
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && failedAssets.length < 50)
      failedAssets.push({ path: redactText(new URL(response.url()).pathname), status: response.status() });
  });
  await page.goto(first.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByLabel("Server password").waitFor({ timeout: 60_000 });
  await page.getByLabel("Server password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Provider settings", exact: true }).click();
  await page.getByLabel("Base URL").fill(baseUrl);
  await page.getByLabel("Model ID").fill(MODEL);
  await page.getByLabel("API key", { exact: true }).fill(apiKey);
  const savedResponse = page.waitForResponse(
    (response) => response.url() === `${first.url}/api/provider` && response.request().method() === "PUT",
    { timeout: 60_000 },
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const saved = await savedResponse;
  assert.equal(saved.status(), 200);
  checkSecrets(await saved.text());
  await stateAfterEvents(observer, "real Provider readiness", async () => {
    const state = await workspace(first.url, cookie);
    if (state.execution.state === "error")
      throw new Error(state.execution.message ?? "The real Provider failed to start.");
    return state.execution.state === "ready" ? state : undefined;
  });
  assert.ok(!(await readFile(join(dataDirectory, "opskar-openai-profile-v1.json"), "utf8")).includes(apiKey));
  await page.goto(first.url);
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  await page.getByLabel("Name").fill(AGENT_NAME);
  await page.getByLabel("What should this agent help with?").fill("Create a file inside this workspace.");
  const createdResponse = page.waitForResponse(
    (response) => response.url() === `${first.url}/api/workspace/agents` && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  const created = await createdResponse;
  assert.ok(created.status() === 200 || created.status() === 201);
  agentId = Schema.decodeUnknownSync(LocalAgentCreateResult)(await created.json()).agentId;
  const agent = (await workspace(first.url, cookie)).agents.find((candidate) => candidate.id === agentId);
  assert.ok(agent);
  const inside = relative(join(dataDirectory, "files", "Agents"), agent.workspacePath);
  assert.ok(
    inside && !inside.startsWith("..") && !isAbsolute(inside),
    "The agent workspace is outside the test data directory.",
  );
  targetFile = join(agent.workspacePath, FILE_NAME);
  checks.push(
    "The browser saves an encrypted local Provider profile and creates an agent through the real Node service.",
  );

  const messageUrl = `${first.url}${agentPath(agentId)}/messages`;
  const sentRequest = page.waitForRequest((request) => request.url() === messageUrl && request.method() === "POST");
  const sentResponse = page.waitForResponse(
    (response) => response.url() === messageUrl && response.request().method() === "POST",
  );
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(WRITE_PROMPT);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const browserSend = Schema.decodeUnknownSync(LocalMessageInput)((await sentRequest).postDataJSON());
  const receipt = Schema.decodeUnknownSync(LocalMessageReceipt)(await (await sentResponse).json());
  const history = page.getByRole("main", { name: "Saved conversation history", exact: true });
  const displayedReply = `${WRITE_REPLY} Private value [redacted]`;
  await history.getByText(displayedReply, { exact: true }).waitFor({ timeout: 60_000 });
  const completed = await stateAfterEvents(observer, "persisted completed file turn", async () => {
    assert.ok(agentId);
    const state = await conversation(first.url, cookie, agentId);
    return state.activeTurnId === null && state.messages.some((message) => message.text.includes(WRITE_REPLY))
      ? state
      : undefined;
  });
  threadId = completed.threadId;
  assert.ok(threadId);
  assert.equal(await readFile(targetFile, "utf8"), FILE_TEXT);
  assert.ok(
    fixtureRequests.some((request) => request.action === "write-result" && request.toolResult),
    "The real file tool returned no result to the model.",
  );
  checkSecrets(await history.innerText());
  const duplicate = await send(first.url, cookie, agentId, browserSend.text, browserSend.clientMessageId);
  assert.equal(duplicate, receipt.messageId);
  assert.equal(
    (await conversation(first.url, cookie, agentId)).messages.filter(
      (message) => message.author === "user" && message.text.includes(WRITE_MARKER),
    ).length,
    1,
  );
  await page.screenshot({ path: join(OUT, "real-agent-file.png"), fullPage: true });
  checks.push(
    "A real OpenCode file tool writes the workspace file; the response is visible and redacted; retrying the client message ID does not duplicate it.",
  );

  await context.setOffline(true);
  await observer.stop();
  const missedReceipt = await send(first.url, cookie, agentId, RECONNECT_PROMPT, "opskar-e2e-reconnect-message");
  assert.ok(missedReceipt);
  const reconnected = await events(first.url, cookie);
  await stateAfterEvents(reconnected, "the missed completed turn", async () => {
    assert.ok(agentId);
    const state = await conversation(first.url, cookie, agentId);
    return state.activeTurnId === null && state.messages.some((message) => message.text.includes(RECONNECT_REPLY))
      ? state
      : undefined;
  });
  await context.setOffline(false);
  await history.getByText(RECONNECT_REPLY, { exact: true }).waitFor({ timeout: 60_000 });
  checks.push("A disconnected event consumer and browser recover the persisted update after reconnecting.");

  heldRequest = Promise.withResolvers<void>();
  heldClosed = Promise.withResolvers<void>();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(HOLD_PROMPT);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await bounded(heldRequest.promise, "the real held upstream turn");
  await page.getByRole("button", { name: "Stop agent", exact: true }).click();
  await bounded(heldClosed.promise, "upstream cancellation after Stop agent");
  await page.getByRole("button", { name: "Stop agent", exact: true }).waitFor({ state: "hidden" });
  await stateAfterEvents(reconnected, "the stopped conversation", async () => {
    assert.ok(agentId);
    const state = await conversation(first.url, cookie, agentId);
    return state.activeTurnId === null ? state : undefined;
  });
  checks.push("Stop agent cancels the real running turn and closes the held Provider response.");

  const frameIndex = reconnected.frames.length;
  assert.equal((await api(first.url, "/api/session", cookie, "DELETE")).status, 200);
  await bounded(
    (async () => {
      let index = frameIndex;
      for (;;) {
        if ((await reconnected.after(index++)).type === "session-ended") return;
      }
    })(),
    "session-ended event after logout",
  );
  await bounded(reconnected.done, "event stream close after logout");
  assert.equal((await api(first.url, "/api/workspace", cookie)).status, 401);
  const expiredStream = await fetch(`${first.url}/api/workspace/events`, {
    headers: { Cookie: cookie, Origin: first.url },
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(expiredStream.status, 401);
  checkSecrets(await expiredStream.text());
  assert.equal(externalBrowserRequests.length, 0, "The workspace browser attempted an external request.");
  assert.equal(browserErrors.length, 0, "The browser reported an uncaught error.");
  await browser.close();
  browser = undefined;
  page = undefined;
  await stop(first.running);
  await checkServiceStopped();
  await bounded(
    (async () => {
      while (fixtureSockets.size > 0) await socketChanged.promise;
    })(),
    "all Provider fixture connections to close",
  );
  checks.push(
    "Logout terminates the session event stream; a revoked session cannot reconnect; Node shutdown closes Provider connections.",
  );

  const restarted = await start(cliPath);
  assert.equal((await api(restarted.url, "/api/workspace", cookie)).status, 401);
  const restartCookie = await login(restarted.url);
  const restored = await workspace(restarted.url, restartCookie);
  assert.equal(restored.workspaceId, workspaceId);
  assert.ok(restored.agents.some((candidate) => candidate.id === agentId));
  const restoredConversation = await conversation(restarted.url, restartCookie, agentId);
  assert.equal(restoredConversation.threadId, threadId);
  assert.ok(restoredConversation.messages.some((message) => message.text.includes(WRITE_REPLY)));
  assert.ok(restoredConversation.messages.some((message) => message.text.includes(RECONNECT_REPLY)));
  assert.equal(await readFile(targetFile, "utf8"), FILE_TEXT);
  assert.equal(
    await send(restarted.url, restartCookie, agentId, browserSend.text, browserSend.clientMessageId),
    receipt.messageId,
  );
  assert.equal(
    (await conversation(restarted.url, restartCookie, agentId)).messages.filter(
      (message) => message.author === "user" && message.text.includes(WRITE_MARKER),
    ).length,
    1,
  );
  const restartEvents = await events(restarted.url, restartCookie);
  await stateAfterEvents(restartEvents, "restarted Provider readiness", async () => {
    const state = await workspace(restarted.url, restartCookie);
    if (state.execution.state === "error")
      throw new Error(state.execution.message ?? "The real Provider failed to restart.");
    return state.execution.state === "ready" ? state : undefined;
  });
  const resumedFrom = fixtureRequests.length;
  const resumedReceipt = await send(
    restarted.url,
    restartCookie,
    agentId,
    RESTART_PROMPT,
    "opskar-e2e-new-after-restart",
  );
  assert.notEqual(resumedReceipt, receipt.messageId);
  const resumedConversation = await stateAfterEvents(restartEvents, "a new completed turn after restart", async () => {
    assert.ok(agentId);
    const state = await conversation(restarted.url, restartCookie, agentId);
    return state.activeTurnId === null && state.messages.some((message) => message.text.includes(RESTART_REPLY))
      ? state
      : undefined;
  });
  assert.equal(resumedConversation.threadId, threadId);
  assert.equal(
    resumedConversation.messages.filter((message) => message.author === "user" && message.text.includes(RESTART_MARKER))
      .length,
    1,
  );
  const resumedRequests = fixtureRequests.slice(resumedFrom).filter((request) => request.action === "restart");
  assert.ok(resumedRequests.length > 0, "The restarted real Provider made no new model request.");
  assert.ok(
    resumedRequests.every((request) => request.hadWriteHistory),
    "The restarted Provider request lost its earlier file-writing context.",
  );
  assert.ok(
    fixtureRequests.every((request) => !request.tools.includes("question")),
    "The native question tool was exposed without a Web reply route.",
  );
  await restartEvents.stop();
  checks.push(
    "A new turn after restart reaches the real Provider with earlier context and completes on the same thread.",
  );
  await stop(restarted.running);
  await checkServiceStopped();
  await bounded(
    (async () => {
      while (fixtureSockets.size > 0) await socketChanged.promise;
    })(),
    "restarted Provider fixture connections to close",
  );
  checks.push(
    "Restart preserves agent/workspace/thread identity, messages, file contents and the persisted idempotency receipt.",
  );

  const settingsOnly = await start(cliPath, false);
  const settingsCookie = await login(settingsOnly.url);
  assert.equal((await workspace(settingsOnly.url, settingsCookie)).execution.state, "disabled");
  assert.equal(
    (
      await api(
        settingsOnly.url,
        "/api/provider",
        settingsCookie,
        "PUT",
        JSON.stringify({ baseUrl, model: "invalid model" }),
      )
    ).status,
    200,
  );
  await stop(settingsOnly.running);
  const queuedRecovery = await queueRecovery(agentId);
  const beforeInvalidStart = fixtureRequests.length;
  const invalidProvider = await start(cliPath);
  const correctionCookie = await login(invalidProvider.url);
  const correctionEvents = await events(invalidProvider.url, correctionCookie);
  await stateAfterEvents(correctionEvents, "invalid Provider configuration state", async () => {
    const state = await workspace(invalidProvider.url, correctionCookie);
    return state.execution.state === "error" ? state : undefined;
  });
  const retainedDelivery = storedDelivery(agentId, queuedRecovery.messageId);
  assert.equal(retainedDelivery.deliveryId, queuedRecovery.deliveryId);
  assert.equal(retainedDelivery.status, "queued");
  assert.equal(retainedDelivery.turnId, null);
  assert.equal(fixtureRequests.length, beforeInvalidStart, "An invalid Provider configuration ran queued work.");
  const correction = await api(
    invalidProvider.url,
    "/api/provider",
    correctionCookie,
    "PUT",
    JSON.stringify({ baseUrl, model: MODEL }),
  );
  assert.equal(correction.status, 200, "Pending work prevented the Provider correction.");
  const recoveredConversation = await stateAfterEvents(
    correctionEvents,
    "queued work after Provider correction",
    async () => {
      assert.ok(agentId);
      const state = await conversation(invalidProvider.url, correctionCookie, agentId);
      return state.activeTurnId === null && state.messages.some((message) => message.text.includes(RECOVERY_REPLY))
        ? state
        : undefined;
    },
  );
  assert.equal(recoveredConversation.threadId, threadId);
  assert.equal(
    recoveredConversation.messages.filter(
      (message) => message.author === "user" && message.text.includes(RECOVERY_MARKER),
    ).length,
    1,
  );
  assert.equal(
    recoveredConversation.messages.filter(
      (message) => message.author === "assistant" && message.text === RECOVERY_REPLY,
    ).length,
    1,
  );
  const completedDelivery = storedDelivery(agentId, queuedRecovery.messageId);
  assert.equal(completedDelivery.deliveryId, queuedRecovery.deliveryId);
  assert.equal(completedDelivery.status, "completed");
  await correctionEvents.stop();
  await stop(invalidProvider.running);
  await checkServiceStopped();
  await bounded(
    (async () => {
      while (fixtureSockets.size > 0) await socketChanged.promise;
    })(),
    "corrected Provider connections to close",
  );
  const recoveryRequests = fixtureRequests.slice(beforeInvalidStart).filter((request) => request.action === "recovery");
  assert.equal(recoveryRequests.length, 1, "The retained queued message ran more than once after correction.");
  recoveryEvidence = {
    ...queuedRecovery,
    before: retainedDelivery.status,
    after: completedDelivery.status,
    modelRequests: recoveryRequests.length,
  };
  checks.push(
    "Provider correction recovers one retained queued message from an invalid configuration exactly once on the same agent thread.",
  );
  assert.equal(fixtureFailure, null);
  for (const running of children) checkSecrets(running.output());
} catch (error) {
  failure = redactText(error instanceof Error ? error.message : "Unexpected real agent E2E failure.");
  process.exitCode = 1;
  if (page && !page.isClosed()) {
    try {
      const text = await page.locator("body").innerText({ timeout: 2000 });
      failureVisibleText = redactText(text).slice(0, 16_000);
      checkSecrets(text);
      failureScreenshot = join(OUT, "real-agent-failure.png");
      await page.screenshot({ path: failureScreenshot, fullPage: true, mask: [page.locator("input, textarea")] });
    } catch (diagnosticError) {
      browserErrors.push(
        redactText(diagnosticError instanceof Error ? diagnosticError.message : "Browser diagnostics failed."),
      );
    }
  }
} finally {
  await browser?.close();
  for (const stream of streams)
    await stream.stop().catch((error: unknown) => {
      failure ??= redactText(error instanceof Error ? error.message : "Event cleanup failed.");
    });
  for (const running of children) {
    if (running.child.exitCode !== null || running.child.signalCode !== null) continue;
    if (running.child.connected) running.child.send("shutdown");
    else running.child.kill();
    await bounded(running.exited, "test child cleanup").catch(() => running.child.kill());
  }
  if (fixture.listening)
    await new Promise<void>((resolve, reject) => {
      fixture.close((error) => (error ? reject(error) : resolve()));
      fixture.closeAllConnections();
    });
  const report = {
    passed: failure === null,
    runtime: process.versions.node,
    platform: process.platform,
    cliPath,
    workspaceId,
    agentId,
    threadId,
    targetFile,
    selectedTool,
    stoppedServicePorts,
    recoveryEvidence,
    checks,
    fixtureRequests,
    events: streams.map((stream) => stream.frames),
    failure,
    fixtureFailure,
    browserDiagnostics: { browserErrors, failedAssets, externalBrowserRequests, failureVisibleText, failureScreenshot },
    unverified: [
      "The 8 h wall-clock session deadline was not elapsed. Passed checks above identify the verified revocation and restart cases.",
    ],
    work,
  };
  const processOutput = children
    .map((running, index) => `Process ${index + 1}\n${redactText(running.output())}`)
    .join("\n");
  await writeFile(join(OUT, "process-output.txt"), processOutput);
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (failure !== null) process.exitCode = 1;
  // Machine-readable: safe E2E results and retained artifact paths.
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
