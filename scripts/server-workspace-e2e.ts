import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type { ConversationMessage, ConversationPage } from "@openbot/contracts/ipc";
import { SessionState } from "@openbot/contracts/server-console";
import { LocalConversationPage, LocalWorkspaceSnapshot } from "@openbot/contracts/server-workspace";
import { redactText, registerSecretValue } from "@openbot/logging";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { type Browser, chromium, type Page } from "playwright-core";
import { SERVER_CREDENTIAL_FILE, ServerCredentials } from "../src/server/server-credentials";
import { readServerOptions } from "../src/server/server-options";
import { ServerStorage } from "../src/server/server-storage";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".openbot-build/server-workspace");
const Ready = Schema.Struct({ type: Schema.Literal("ready"), host: Schema.Literal("127.0.0.1"), port: Schema.Int });
const StoredCredentials = Schema.Struct({
  credentials: Schema.Struct({ codex: Schema.String, claude: Schema.String }),
});
const FIRST_NAME = "Workspace Alpha";
const SECOND_NAME = "Workspace Beta";
const FIRST_COUNT = 126;
const SECOND_COUNT = 3;
const REDACTION_INDEX = 62;
const SHORT_SECRET = "key12345";
const LONG_DESCRIPTION = `${"a".repeat(INPUT_LIMITS.agentDescription - SHORT_SECRET.length - 1)} ${SHORT_SECRET}`;
const LONG_SENDER_NAME = `${"s".repeat(INPUT_LIMITS.accountName - SHORT_SECRET.length - 1)} ${SHORT_SECRET}`;
const LONG_ATTACHMENT_NAME = `${"f".repeat(INPUT_LIMITS.attachmentName - SHORT_SECRET.length - 1)} ${SHORT_SECRET}`;

interface RunningServer {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output(): string;
}

interface FixtureAgent {
  id: string;
  threadId: string;
  name: string;
  firstText: string;
  latestText: string;
  messageCount: number;
}

function messageText(name: string, index: number): string {
  return `${name} historical message ${String(index + 1).padStart(3, "0")}.`;
}

function allStoredMessages(
  storage: ServerStorage["Service"],
  agentId: string,
  threadId: string,
): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  const cursors = new Set<string>();
  let page = storage.database.readConversationPage(agentId, threadId);
  for (;;) {
    messages.unshift(...page.messages);
    if (!page.pageInfo.hasOlder) return messages;
    assert.ok(page.pageInfo.olderCursor, "An older page has no cursor.");
    assert.ok(!cursors.has(page.pageInfo.olderCursor), "Stored history repeated a page cursor.");
    cursors.add(page.pageInfo.olderCursor);
    page = storage.database.readConversationPage(agentId, threadId, {
      type: "before",
      cursor: page.pageInfo.olderCursor,
    });
  }
}

function storedDigest(storage: ServerStorage["Service"]): string {
  const records = storage.agents.list().map((agent) => ({
    id: agent.id,
    name: agent.name,
    description: agent.description,
    model: agent.model,
    avatarSeed: agent.avatarSeed,
    preview: agent.preview,
    threadId: agent.threadId,
    messages: agent.threadId ? allStoredMessages(storage, agent.id, agent.threadId) : [],
  }));
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

async function seed(directory: string): Promise<{ agents: FixtureAgent[]; digest: string }> {
  const options = readServerOptions(["--data-dir", directory], { OPSKAR_CREDENTIAL_KEY_FILE: keyFile });
  const runtime = ManagedRuntime.make(
    ServerCredentials.layer(options).pipe(Layer.provideMerge(ServerStorage.layer(options))),
  );
  try {
    return await runtime.runPromise(
      Effect.gen(function* () {
        const storage = yield* ServerStorage;
        const credentials = yield* ServerCredentials;
        assert.equal(credentials.status, "ready");
        assert.ok(credentials.providers);
        yield* credentials.providers.set("codex", apiKey);
        yield* credentials.providers.set("claude", SHORT_SECRET);
        assert.equal(storage.agents.list().length, 0);
        const agents: FixtureAgent[] = [];
        for (const [name, count] of [
          [FIRST_NAME, FIRST_COUNT],
          [SECOND_NAME, SECOND_COUNT],
        ] as const) {
          const agent = yield* storage.agents.createAgent({
            name,
            description: name === FIRST_NAME ? LONG_DESCRIPTION : "Stored history for the local workspace E2E.",
            avatarSeed: name === SECOND_NAME ? SHORT_SECRET : name.toLowerCase().replaceAll(" ", "-"),
            avatarHue: null,
          });
          if (name === SECOND_NAME) yield* storage.agents.updateAgent({ agentId: agent.id, model: SHORT_SECRET });
          const threadId = yield* storage.agents.ensureThreadId(agent.id);
          const messages = Array.from(
            { length: count },
            (_, index): ConversationMessage => ({
              id: `${agent.id}-history-${index + 1}`,
              author: index % 2 === 0 ? "user" : "assistant",
              text:
                name === FIRST_NAME && index === REDACTION_INDEX
                  ? `${messageText(name, index)} Private value ${apiKey}`
                  : messageText(name, index),
              createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString(),
              status: "completed",
              ...(name === SECOND_NAME && index === 0
                ? {
                    senderMember: { id: "workspace-e2e-member", name: LONG_SENDER_NAME },
                    attachments: [
                      {
                        id: `${agent.id}-attachment`,
                        name: LONG_ATTACHMENT_NAME,
                        size: 0,
                        kind: "file",
                        mimeType: "text/plain",
                        previewKind: "none",
                        previewUrl: null,
                      },
                    ],
                  }
                : {}),
            }),
          );
          storage.database.persistConversation(
            { agentId: agent.id, threadId, activeTurnId: null, revision: 0, messages },
            "workspace-e2e.seeded",
          );
          yield* storage.agents.updatePreview(agent.id, messageText(name, count - 1));
          assert.equal(allStoredMessages(storage, agent.id, threadId).length, count);
          agents.push({
            id: agent.id,
            threadId,
            name,
            firstText: messageText(name, 0),
            latestText: messageText(name, count - 1),
            messageCount: count,
          });
        }
        return { agents, digest: storedDigest(storage) };
      }),
    );
  } finally {
    await runtime.dispose();
  }
}

async function digestAfterStop(directory: string): Promise<string> {
  const runtime = ManagedRuntime.make(ServerStorage.layer(readServerOptions(["--data-dir", directory], {})));
  try {
    return await runtime.runPromise(
      Effect.gen(function* () {
        const storage = yield* ServerStorage;
        const alpha = storage.agents.list().find((agent) => agent.name === FIRST_NAME);
        assert.ok(alpha?.threadId);
        assert.ok(alpha.description === LONG_DESCRIPTION, "The read-only projection changed the stored description.");
        const stored = allStoredMessages(storage, alpha.id, alpha.threadId);
        assert.ok(
          stored[REDACTION_INDEX]?.text.includes(apiKey),
          "The read-only projection changed the stored message secret.",
        );
        const beta = storage.agents.list().find((agent) => agent.name === SECOND_NAME);
        assert.ok(beta?.threadId);
        const betaMessage = allStoredMessages(storage, beta.id, beta.threadId)[0];
        assert.ok(
          betaMessage?.senderMember?.name === LONG_SENDER_NAME,
          "The read-only projection changed the stored sender name.",
        );
        assert.ok(
          betaMessage?.attachments?.[0]?.name === LONG_ATTACHMENT_NAME,
          "The read-only projection changed the stored attachment name.",
        );
        return storedDigest(storage);
      }),
    );
  } finally {
    await runtime.dispose();
  }
}

async function bounded<A>(promise: Promise<A>, label: string): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 45_000);
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
const directory = join(work, "data");
const keyFile = join(work, "credential.key");
const passwordFile = join(work, "console-password.key");
const master = randomBytes(32).toString("base64");
const password = randomBytes(24).toString("base64url");
const apiKey = `workspace-e2e-${randomBytes(24).toString("hex")}`;
const redactedMessage = `${messageText(FIRST_NAME, REDACTION_INDEX)} Private value [redacted]`;
const protectedValues = [master, password, apiKey, SHORT_SECRET];
for (const secret of protectedValues) registerSecretValue(secret, { allowShort: true });
await writeFile(keyFile, `${master}\n`, { mode: 0o600 });
await writeFile(passwordFile, `${password}\n`, { mode: 0o600 });
await chmod(keyFile, 0o600);
await chmod(passwordFile, 0o600);

const children: RunningServer[] = [];
const checks: string[] = [];
const browserErrors: string[] = [];
const failedAssets: { path: string; status: number }[] = [];
const externalRequests: { host: string; path: string }[] = [];
const browserApiRequests: { method: string; path: string }[] = [];
let browser: Browser | undefined;
let page: Page | undefined;
let failure: string | null = null;
let failureVisibleText: string | null = null;
let failureScreenshot: string | null = null;
let workspaceId: string | null = null;
let finalDigest: string | null = null;

function launch(dataDirectory: string): RunningServer {
  let output = "";
  const child = fork(join(ROOT, "src/server/index.ts"), ["--web", "--data-dir", dataDirectory, "--port", "0"], {
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

async function start(dataDirectory: string) {
  const running = launch(dataDirectory);
  const ready = new Promise<typeof Ready.Type>((resolve, reject) => {
    running.child.once("message", (message) => {
      try {
        resolve(Schema.decodeUnknownSync(Ready)(message));
      } catch {
        reject(new Error("The server sent invalid readiness data."));
      }
    });
  });
  const state = await bounded(
    Promise.race([
      ready,
      running.exited.then(() => {
        throw new Error(`Server exited before readiness: ${redactText(running.output())}`);
      }),
    ]),
    "server readiness",
  );
  return { running, url: `http://${state.host}:${state.port}` };
}

async function stop(running: RunningServer): Promise<void> {
  running.child.send("shutdown");
  const result = await bounded(running.exited, "server shutdown");
  assert.equal(result.code, 0, redactText(running.output()));
  assert.equal(result.signal, null);
}

function checkSecrets(text: string): void {
  assert.ok(
    protectedValues.every((secret) => !text.includes(secret)),
    "A credential appeared in workspace output.",
  );
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
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  checkSecrets(text);
  return { status: response.status, headers: response.headers, text };
}

async function login(url: string): Promise<string> {
  const response = await api(url, "/api/session", "", "POST", JSON.stringify({ password }));
  assert.equal(response.status, 200);
  assert.equal(Schema.decodeUnknownSync(SessionState)(JSON.parse(response.text)).authenticated, true);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  registerSecretValue(cookie, { allowShort: true });
  return cookie;
}

async function workspace(url: string, cookie: string) {
  const response = await api(url, "/api/workspace", cookie);
  assert.equal(response.status, 200);
  return Schema.decodeUnknownSync(LocalWorkspaceSnapshot)(JSON.parse(response.text));
}

function conversationPath(id: string): string {
  return `/api/workspace/agents/${encodeURIComponent(id)}/conversation`;
}

async function conversation(url: string, cookie: string, agentId: string, before?: string) {
  const response = await api(
    url,
    `${conversationPath(agentId)}${before ? `?before=${encodeURIComponent(before)}` : ""}`,
    cookie,
  );
  assert.equal(response.status, 200);
  return Schema.decodeUnknownSync(LocalConversationPage)(JSON.parse(response.text));
}

async function allApiMessages(url: string, cookie: string, first: ConversationPage): Promise<ConversationMessage[]> {
  const messages = [...first.messages];
  const cursors = new Set<string>();
  let page = first;
  while (page.pageInfo.hasOlder) {
    assert.ok(page.pageInfo.olderCursor);
    assert.ok(!cursors.has(page.pageInfo.olderCursor), "The workspace API repeated a page cursor.");
    cursors.add(page.pageInfo.olderCursor);
    page = await conversation(url, cookie, page.agentId, page.pageInfo.olderCursor);
    messages.unshift(...page.messages);
  }
  return messages;
}

try {
  const seeded = await seed(directory);
  const credentialEnvelope = (await readFile(join(directory, SERVER_CREDENTIAL_FILE), "utf8")).trim();
  const storedCiphertexts = Object.values(
    Schema.decodeUnknownSync(StoredCredentials)(JSON.parse(credentialEnvelope)).credentials,
  );
  protectedValues.push(credentialEnvelope, ...storedCiphertexts);
  registerSecretValue(credentialEnvelope, { allowShort: true });
  for (const ciphertext of storedCiphertexts) registerSecretValue(ciphertext, { allowShort: true });
  const [alpha, beta] = seeded.agents;
  assert.ok(alpha && beta);
  const first = await start(directory);
  assert.equal((await api(first.url, "/api/workspace")).status, 401);
  assert.equal((await api(first.url, conversationPath(alpha.id))).status, 401);
  const cookie = await login(first.url);
  const state = await workspace(first.url, cookie);
  workspaceId = state.workspaceId;
  assert.equal(state.mode, "read-only");
  assert.deepEqual(state.agents.map((agent) => agent.id).sort(), [alpha.id, beta.id].sort());
  assert.deepEqual(state.agents.map((agent) => agent.name).sort(), [FIRST_NAME, SECOND_NAME].sort());
  const displayedAlpha = state.agents.find((agent) => agent.id === alpha.id);
  const betaProfile = state.agents.find((agent) => agent.id === beta.id);
  assert.equal(betaProfile?.model, "redacted");
  assert.equal(betaProfile?.avatarSeed, "redacted");
  assert.ok(displayedAlpha);
  assert.equal(displayedAlpha.description.length, INPUT_LIMITS.agentDescription);
  const displayedBeta = await conversation(first.url, cookie, beta.id);
  const firstBetaMessage = displayedBeta.messages[0];
  assert.ok(firstBetaMessage?.senderMember && firstBetaMessage.attachments?.[0]);
  assert.equal(firstBetaMessage.senderMember.name.length, INPUT_LIMITS.accountName);
  assert.equal(firstBetaMessage.attachments[0].name.length, INPUT_LIMITS.attachmentName);
  checks.push(
    "Expanded redaction stays within description, sender and attachment limits, so complete replies remain readable.",
  );
  assert.equal((await api(first.url, conversationPath("missing-agent"), cookie)).status, 404);
  assert.equal((await api(first.url, conversationPath("../../openbot.db"), cookie)).status, 400);
  assert.equal((await api(first.url, `${conversationPath(alpha.id)}?before=invalid-cursor`, cookie)).status, 400);
  assert.equal((await api(first.url, `${conversationPath(alpha.id)}?path=openbot.db`, cookie)).status, 400);
  assert.equal((await api(first.url, "/api/workspace", cookie, "POST", "{}")).status, 404);
  checks.push(
    "Authenticated reads return the real agents; unknown agents, invalid paths/cursors and writes are refused.",
  );

  const latest = await conversation(first.url, cookie, alpha.id);
  assert.equal(latest.threadId, alpha.threadId);
  assert.equal(latest.messages.length, 50);
  assert.equal(latest.messages.at(-1)?.text, alpha.latestText);
  assert.equal(latest.pageInfo.hasOlder, true);
  const all = await allApiMessages(first.url, cookie, latest);
  assert.equal(all.length, alpha.messageCount);
  assert.equal(new Set(all.map((message) => message.id)).size, alpha.messageCount);
  assert.equal(all[0]?.text, alpha.firstText);
  assert.equal(all[REDACTION_INDEX]?.text, redactedMessage);
  assert.ok(latest.pageInfo.olderCursor);
  const mismatched = await api(
    first.url,
    `${conversationPath(beta.id)}?before=${encodeURIComponent(latest.pageInfo.olderCursor)}`,
    cookie,
  );
  assert.equal(mismatched.status, 400);
  checks.push(
    "Conversation pages preserve order and message IDs, and a cursor cannot cross into another agent's data.",
  );

  browser = await chromium.launch(
    process.env.OPSKAR_E2E_BROWSER_PATH
      ? { executablePath: process.env.OPSKAR_E2E_BROWSER_PATH, headless: true }
      : { ...(process.platform === "win32" ? { channel: "msedge" } : {}), headless: true },
  );
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, serviceWorkers: "block" });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (["http:", "https:"].includes(url.protocol) && url.origin !== first.url) {
      externalRequests.push({ host: url.host, path: redactText(url.pathname) });
      await route.abort("blockedbyclient");
    } else await route.continue();
  });
  page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => {
    if (browserErrors.length < 50) browserErrors.push(redactText(error.message));
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (response.status() >= 400 && failedAssets.length < 50)
      failedAssets.push({ path: redactText(url.pathname), status: response.status() });
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/")) browserApiRequests.push({ method: request.method(), path: url.pathname });
  });
  page.on("websocket", (socket) => {
    const url = new URL(socket.url());
    if (url.host !== new URL(first.url).host) externalRequests.push({ host: url.host, path: redactText(url.pathname) });
  });
  // The first Vite page transforms the shared workspace dependencies on demand.
  await page.goto(first.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByLabel("Server password").waitFor({ timeout: 60_000 });
  await page.getByLabel("Server password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: /^Workspace Alpha/u }).waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: /^Workspace Alpha/u }).click();
  const history = page.getByRole("main", { name: "Saved conversation history", exact: true });
  await history.getByText(alpha.latestText, { exact: true }).waitFor();
  await page.getByRole("button", { name: "Load earlier messages", exact: true }).click();
  await history.getByText(messageText(FIRST_NAME, FIRST_COUNT - 51), { exact: true }).waitFor();
  await history.getByText(redactedMessage, { exact: true }).waitFor();
  checkSecrets(await history.innerText());
  await page.getByRole("button", { name: "Load earlier messages", exact: true }).click();
  await history.getByText(alpha.firstText, { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: /^(Send|Send message|Run task|New agent)$/iu }).count(), 0);
  await page.screenshot({ path: join(OUT, "workspace-history.png"), fullPage: true });
  await page.getByRole("button", { name: /^Workspace Beta/u }).click();
  await history.getByText(beta.latestText, { exact: true }).waitFor();
  const refreshed = page.waitForResponse(
    (response) => response.url() === `${first.url}/api/workspace` && response.request().method() === "GET",
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  assert.equal((await refreshed).status(), 200);
  await history.getByText(beta.latestText, { exact: true }).waitFor();
  await page.reload();
  await history.getByText(beta.latestText, { exact: true }).waitFor();
  assert.ok(!(await history.innerText()).includes(alpha.latestText));
  checks.push("The browser selects agents, loads older messages and retains the selected conversation after reload.");

  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Server password").waitFor();
  const afterLogout = await page.locator("body").innerText();
  for (const text of [FIRST_NAME, SECOND_NAME, alpha.firstText, beta.latestText])
    assert.ok(!afterLogout.includes(text), "Logout left private workspace content visible.");
  assert.equal((await page.request.get(`${first.url}/api/workspace`)).status(), 401);
  assert.equal(externalRequests.length, 0, "The workspace attempted an external browser request.");
  assert.ok(
    browserApiRequests.every((request) => request.method === "GET" || request.path === "/api/session"),
    "The read-only workspace attempted a mutation.",
  );
  assert.ok(
    browserApiRequests.every((request) => !request.path.includes("/provider/test")),
    "The workspace attempted a Provider request.",
  );
  assert.equal(browserErrors.length, 0, "The browser reported an uncaught workspace error.");
  checks.push("Logout clears private content; the browser makes no external, account, Signal or Provider requests.");
  await browser.close();
  browser = undefined;
  page = undefined;
  await stop(first.running);

  const restarted = await start(directory);
  const restartedCookie = await login(restarted.url);
  assert.equal((await workspace(restarted.url, restartedCookie)).workspaceId, workspaceId);
  const restartedMessages = await allApiMessages(
    restarted.url,
    restartedCookie,
    await conversation(restarted.url, restartedCookie, alpha.id),
  );
  assert.deepEqual(
    restartedMessages.map((message) => ({ id: message.id, text: message.text })),
    all.map((message) => ({ id: message.id, text: message.text })),
  );
  await stop(restarted.running);
  finalDigest = await digestAfterStop(directory);
  assert.equal(finalDigest, seeded.digest);
  checks.push("API and browser history redact the saved API key while the original stored message remains unchanged.");
  const otherDirectory = join(work, "other-data");
  const other = await start(otherDirectory);
  const otherState = await workspace(other.url, await login(other.url));
  assert.notEqual(otherState.workspaceId, workspaceId);
  assert.equal(otherState.agents.length, 0);
  await stop(other.running);
  checks.push(
    "Restart preserves workspace identity, agent identity and all messages; a separate data directory has a separate identity.",
  );
  const invalidIdentityPath = join(otherDirectory, "opskar-workspace-v1.json");
  const invalidIdentity = Buffer.from("{invalid workspace identity\n", "utf8");
  await writeFile(invalidIdentityPath, invalidIdentity);
  const invalid = launch(otherDirectory);
  assert.equal((await bounded(invalid.exited, "invalid workspace identity refusal")).code, 1);
  assert.ok(invalid.output().includes("workspace"));
  assert.ok(
    (await readFile(invalidIdentityPath)).equals(invalidIdentity),
    "Startup replaced an unreadable workspace identity.",
  );
  checks.push("An invalid saved workspace identity stops startup and keeps the original file bytes.");
  for (const running of children) checkSecrets(running.output());
} catch (error) {
  failure = redactText(
    error instanceof Error
      ? error.message || (error.cause instanceof Error ? error.cause.message : error.name)
      : "Unexpected workspace E2E failure.",
  );
  process.exitCode = 1;
  if (page && !page.isClosed()) {
    try {
      const visible = await page.locator("body").innerText({ timeout: 2000 });
      failureVisibleText = redactText(visible).slice(0, 16_000);
      checkSecrets(visible);
      failureScreenshot = join(OUT, "workspace-failure.png");
      await page.screenshot({ path: failureScreenshot, fullPage: true, mask: [page.locator("input, textarea")] });
    } catch (diagnosticError) {
      browserErrors.push(
        redactText(diagnosticError instanceof Error ? diagnosticError.message : "Browser diagnostics failed."),
      );
    }
  }
} finally {
  await browser?.close();
  for (const running of children) {
    if (running.child.exitCode !== null || running.child.signalCode !== null) continue;
    if (running.child.connected) running.child.send("shutdown");
    else running.child.kill();
    await bounded(running.exited, "test child cleanup").catch(() => running.child.kill());
  }
  const report = {
    passed: failure === null,
    node: process.versions.node,
    platform: process.platform,
    checks,
    workspaceId,
    finalDigest,
    failure,
    browserDiagnostics: {
      browserErrors,
      failedAssets,
      externalRequests,
      browserApiRequests,
      failureVisibleText,
      failureScreenshot,
    },
    work,
  };
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  // Machine-readable: the safe E2E result and its retained data directory.
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
