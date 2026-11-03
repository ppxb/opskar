import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { join, resolve } from "node:path";
import { ProviderState, ProviderTestResult, SessionState } from "@openbot/contracts/server-console";
import { redactText, registerSecretValue } from "@openbot/logging";
import { Schema } from "effect";
import { type Browser, chromium, type Page } from "playwright-core";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".openbot-build/server-web");
const Ready = Schema.Struct({
  type: Schema.Literal("ready"),
  host: Schema.Literal("127.0.0.1"),
  port: Schema.Int,
});
const ChatRequest = Schema.Struct({
  model: Schema.String,
  stream: Schema.Literal(false),
  max_tokens: Schema.Int,
  messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.String })),
});

interface RunningServer {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output(): string;
}

interface ApiResponse {
  status: number;
  headers: Headers;
  body: string;
}

type FixtureMode = "ok" | "echo" | "failure" | "redirect" | "hold";

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

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

await mkdir(OUT, { recursive: true });
const work = await mkdtemp(join(OUT, "run-"));
const keyFile = join(work, "credential.key");
const passwordFile = join(work, "console-password.key");
const master = randomBytes(32).toString("base64");
const password = randomBytes(24).toString("base64url");
const apiKey = `opskar-e2e-${randomBytes(24).toString("hex")}`;
const secrets = [master, password, apiKey];
for (const secret of secrets) registerSecretValue(secret, { allowShort: true });
await writeFile(keyFile, `${master}\n`, { mode: 0o600 });
await writeFile(passwordFile, `${password}\n`, { mode: 0o600 });
await chmod(keyFile, 0o600);
await chmod(passwordFile, 0o600);

const children: RunningServer[] = [];
const checks: string[] = [];
const captures: { path: string; authorized: boolean; model: string; messageCount: number }[] = [];
let mode: FixtureMode = "ok";
let received = Promise.withResolvers<void>();
let disconnected = Promise.withResolvers<void>();
let fixtureFailure: string | null = null;
let redirectHits = 0;
let browser: Browser | undefined;
let page: Page | undefined;
const browserErrors: string[] = [];
const failedAssets: { path: string; status: number }[] = [];
const failedRequests: { path: string; reason: string }[] = [];
let failureVisibleText: string | null = null;
let failureScreenshot: string | null = null;

function safeAssetPath(url: string): string {
  try {
    return redactText(new URL(url).pathname);
  } catch {
    return "Invalid asset URL.";
  }
}

const fixture = createServer((request, response) => {
  const connectionClosed = disconnected;
  response.once("close", () => connectionClosed.resolve());
  if (request.url === "/redirect-target") {
    redirectHits += 1;
    response.end("Unexpected redirect follow.");
    return;
  }
  void (async () => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = Schema.decodeUnknownSync(ChatRequest)(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      assert.equal(input.messages.length, 1);
      assert.equal(input.messages[0]?.role, "user");
      assert.equal(input.max_tokens, 32);
      captures.push({
        path: request.url ?? "",
        authorized: request.headers.authorization === `Bearer ${apiKey}`,
        model: input.model,
        messageCount: input.messages.length,
      });
      received.resolve();
      if (mode === "hold") return;
      if (mode === "redirect") {
        response.writeHead(307, { Location: "/redirect-target" });
        response.end();
        return;
      }
      response.writeHead(mode === "failure" ? 401 : 200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify(
          mode === "failure"
            ? { error: { message: `The request used ${apiKey}.` } }
            : { choices: [{ message: { content: mode === "echo" ? `Echo ${apiKey}` : "OK" } }] },
        ),
      );
    } catch (error) {
      fixtureFailure = redactText(error instanceof Error ? error.message : "Provider fixture failed.");
      received.resolve();
      response.writeHead(500);
      response.end();
    }
  })();
});

function launch(
  directory: string,
  credentials = true,
  credentialFile = keyFile,
  operatorPasswordFile = passwordFile,
): RunningServer {
  let output = "";
  const child = fork(join(ROOT, "src/server/index.ts"), ["--web", "--data-dir", directory, "--port", "0"], {
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
      OPSKAR_WEB_PASSWORD_FILE: operatorPasswordFile,
      ...(credentials ? { OPSKAR_CREDENTIAL_KEY_FILE: credentialFile } : {}),
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

async function start(
  directory: string,
  credentials = true,
  credentialFile = keyFile,
  operatorPasswordFile = passwordFile,
) {
  const running = launch(directory, credentials, credentialFile, operatorPasswordFile);
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
  for (const secret of secrets) {
    assert.ok(!text.includes(secret), "A secret appeared in a public response or process output.");
  }
}

async function api(
  url: string,
  method: string,
  path: string,
  cookie = "",
  body?: string,
  origin: string | null = url,
  contentType = "application/json",
  signal = AbortSignal.timeout(10_000),
): Promise<ApiResponse> {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(origin === null ? {} : { Origin: origin }),
      ...(body === undefined ? {} : { "Content-Type": contentType }),
    },
    body,
    signal,
  });
  const text = await response.text();
  checkSecrets(text);
  return { status: response.status, headers: response.headers, body: text };
}

async function login(url: string): Promise<string> {
  const response = await api(url, "POST", "/api/session", "", JSON.stringify({ password }));
  assert.equal(response.status, 200);
  assert.equal(Schema.decodeUnknownSync(SessionState)(JSON.parse(response.body)).authenticated, true);
  const header = response.headers.get("set-cookie");
  assert.ok(header);
  assert.match(header, /HttpOnly/iu);
  assert.match(header, /SameSite=Strict/iu);
  const cookie = header.split(";")[0];
  assert.ok(cookie);
  registerSecretValue(cookie, { allowShort: true });
  return cookie;
}

async function hostileHost(url: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      `${url}/api/session`,
      { headers: { Host: "attacker.invalid" }, signal: AbortSignal.timeout(10_000) },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

async function rawTargetStatus(url: string, target: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const request = httpRequest(url, { path: target, signal: AbortSignal.timeout(10_000) }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}

let failure: string | null = null;
try {
  const fixturePort = await listen(fixture);
  const baseUrl = `http://127.0.0.1:${fixturePort}/v1`;
  const directory = join(work, "data");
  const first = await start(directory);
  assert.equal((await api(first.url, "GET", "/api/provider")).status, 401);
  assert.equal((await api(first.url, "POST", "/api/provider/test", "", "{}")).status, 401);
  assert.equal(
    Schema.decodeUnknownSync(SessionState)(JSON.parse((await api(first.url, "GET", "/api/session")).body))
      .authenticated,
    false,
  );
  assert.equal(
    (await api(first.url, "POST", "/api/session", "", JSON.stringify({ password: "wrong-password" }))).status,
    401,
  );
  const cookie = await login(first.url);
  assert.ok((await hostileHost(first.url)) >= 400);
  assert.equal(await rawTargetStatus(first.url, "/__open-in-editor"), 404);
  assert.equal(await rawTargetStatus(first.url, "/%5f%5fopen-in-editor"), 404);
  assert.equal(await rawTargetStatus(first.url, `${first.url}/__open-in-editor`), 403);
  assert.equal((await api(first.url, "POST", "/main.tsx", "", "{}")).status, 405);
  assert.equal(
    (await api(first.url, "GET", "/api/provider", cookie, undefined, "https://attacker.invalid")).status,
    403,
  );
  assert.equal((await api(first.url, "PUT", "/api/provider", cookie, "{}", null)).status, 403);
  assert.equal((await api(first.url, "POST", "/api/session", "", "{}", "https://attacker.invalid")).status, 403);
  assert.equal((await api(first.url, "PUT", "/api/provider", cookie, "{}", first.url, "text/plain")).status, 400);
  assert.equal(
    (await api(first.url, "PUT", "/api/provider", cookie, JSON.stringify({ text: "x".repeat(80_000) }))).status,
    413,
  );
  checks.push(
    "Unauthenticated requests, invalid passwords, foreign origins, host headers and unsafe bodies are refused.",
  );

  const initial = Schema.decodeUnknownSync(ProviderState)(
    JSON.parse((await api(first.url, "GET", "/api/provider", cookie)).body),
  );
  assert.equal(initial.provider, null);
  const saved = await api(
    first.url,
    "PUT",
    "/api/provider",
    cookie,
    JSON.stringify({ baseUrl, model: "fixture-model", apiKey }),
  );
  assert.equal(saved.status, 200);
  assert.equal(Schema.decodeUnknownSync(ProviderState)(JSON.parse(saved.body)).provider?.hasApiKey, true);
  const profile = await readFile(join(directory, "opskar-openai-profile-v1.json"), "utf8");
  checkSecrets(profile);
  assert.ok(!profile.includes(baseUrl), "The encrypted profile contains its plaintext address.");
  const result = await api(first.url, "POST", "/api/provider/test", cookie, "{}");
  assert.equal(result.status, 200);
  assert.equal(Schema.decodeUnknownSync(ProviderTestResult)(JSON.parse(result.body)).text, "OK");
  assert.equal(captures.at(-1)?.authorized, true);
  assert.equal(captures.at(-1)?.model, "fixture-model");
  checks.push("Saved settings use encrypted storage, hide credentials and send the expected chat request.");

  assert.equal(
    (
      await api(
        first.url,
        "PUT",
        "/api/provider",
        cookie,
        JSON.stringify({ baseUrl: `${baseUrl}/other`, model: "fixture-model" }),
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await api(
        first.url,
        "PUT",
        "/api/provider",
        cookie,
        JSON.stringify({ baseUrl: "https://user:password@example.invalid/v1", model: "fixture-model", apiKey }),
      )
    ).status,
    400,
  );
  assert.equal(
    (await api(first.url, "PUT", "/api/provider", cookie, JSON.stringify({ baseUrl, model: "retained-key" }))).status,
    200,
  );
  await api(first.url, "POST", "/api/provider/test", cookie, "{}");
  assert.equal(captures.at(-1)?.authorized, true);
  const cleared = await api(
    first.url,
    "PUT",
    "/api/provider",
    cookie,
    JSON.stringify({ baseUrl, model: "without-key", apiKey: "" }),
  );
  assert.equal(Schema.decodeUnknownSync(ProviderState)(JSON.parse(cleared.body)).provider?.hasApiKey, false);
  await api(first.url, "POST", "/api/provider/test", cookie, "{}");
  assert.equal(captures.at(-1)?.authorized, false);
  assert.equal(
    (await api(first.url, "PUT", "/api/provider", cookie, JSON.stringify({ baseUrl, model: "fixture-model", apiKey })))
      .status,
    200,
  );
  checks.push("Address changes require a new key; same-address edits retain it; explicit removal stops authorization.");

  mode = "echo";
  assert.equal((await api(first.url, "POST", "/api/provider/test", cookie, "{}")).status, 200);
  mode = "failure";
  assert.ok((await api(first.url, "POST", "/api/provider/test", cookie, "{}")).status >= 400);
  mode = "redirect";
  assert.ok((await api(first.url, "POST", "/api/provider/test", cookie, "{}")).status >= 400);
  assert.equal(redirectHits, 0);
  mode = "hold";
  received = Promise.withResolvers<void>();
  disconnected = Promise.withResolvers<void>();
  const abort = new AbortController();
  const pending = api(
    first.url,
    "POST",
    "/api/provider/test",
    cookie,
    "{}",
    first.url,
    "application/json",
    abort.signal,
  ).then(
    () => false,
    () => true,
  );
  await bounded(received.promise, "Provider request");
  abort.abort();
  assert.equal(await pending, true);
  await bounded(disconnected.promise, "Provider cancellation");
  mode = "ok";
  checks.push(
    "Provider echoes and failures cannot return secrets; redirects are blocked; cancellation closes upstream I/O.",
  );

  await stop(first.running);
  const restarted = await start(directory);
  assert.equal((await api(restarted.url, "GET", "/api/provider", cookie)).status, 401);
  const nextCookie = await login(restarted.url);
  const restored = Schema.decodeUnknownSync(ProviderState)(
    JSON.parse((await api(restarted.url, "GET", "/api/provider", nextCookie)).body),
  );
  assert.equal(restored.provider?.baseUrl, baseUrl);
  assert.equal(restored.provider?.model, "fixture-model");
  assert.equal(restored.provider?.hasApiKey, true);
  assert.equal((await api(restarted.url, "POST", "/api/provider/test", nextCookie, "{}")).status, 200);
  assert.equal((await api(restarted.url, "DELETE", "/api/session", nextCookie)).status, 200);
  assert.equal((await api(restarted.url, "GET", "/api/provider", nextCookie)).status, 401);
  checks.push("Restart preserves Provider settings and invalidates sessions; logout revokes the current session.");

  // Use .txt files so the assertion depends on configured and physical paths, not the *.key deny rule.
  const servedSecrets = await mkdtemp(join(ROOT, "node_modules/.opskar-console-e2e-"));
  const aliasedSecrets = join(work, "secret-alias");
  await writeFile(join(servedSecrets, "master[v1].txt"), `${master}\n`, { mode: 0o600 });
  await writeFile(join(servedSecrets, "password[dev].txt"), `${password}\n`, { mode: 0o600 });
  await chmod(join(servedSecrets, "master[v1].txt"), 0o600);
  await chmod(join(servedSecrets, "password[dev].txt"), 0o600);
  await symlink(servedSecrets, aliasedSecrets, process.platform === "win32" ? "junction" : "dir");
  const privateFiles = await start(
    join(work, "private-paths"),
    true,
    join(aliasedSecrets, "master[v1].txt"),
    join(aliasedSecrets, "password[dev].txt"),
  );
  for (const directory of [servedSecrets, aliasedSecrets]) {
    for (const name of ["master[v1].txt", "password[dev].txt"]) {
      const path = `/@fs/${join(directory, name).replaceAll("\\", "/")}`;
      for (const suffix of ["", "?raw"]) {
        const response = await api(privateFiles.url, "GET", `${path}${suffix}`);
        assert.ok(response.status >= 400, "Vite served a private file through a configured or physical path.");
      }
    }
  }
  await stop(privateFiles.running);
  const publicFixtures = join(ROOT, "src/server-web/public/.openbot-build");
  await mkdir(publicFixtures, { recursive: true });
  const publicSecrets = await mkdtemp(join(publicFixtures, "private-"));
  const publicPassword = join(publicSecrets, "password.txt");
  await writeFile(publicPassword, `${password}\n`, { mode: 0o600 });
  await chmod(publicPassword, 0o600);
  const publicFiles = await start(join(work, "public-paths"), true, keyFile, publicPassword);
  const publicPath = `/.openbot-build/${publicSecrets.split(/[\\/]/u).at(-1)}/password.txt`;
  // The response can be the app fallback, but it must never contain the password.
  await api(publicFiles.url, "GET", publicPath);
  await api(publicFiles.url, "GET", `${publicPath}?raw`);
  await stop(publicFiles.running);
  checks.push("Vite refuses private files through aliases, physical paths, glob characters and the public directory.");

  browser = await chromium.launch(
    process.env.OPSKAR_E2E_BROWSER_PATH
      ? { executablePath: process.env.OPSKAR_E2E_BROWSER_PATH, headless: true }
      : { ...(process.platform === "win32" ? { channel: "msedge" } : {}), headless: true },
  );
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (error) => {
    if (browserErrors.length < 50) browserErrors.push(redactText(error.message));
  });
  page.on("console", (message) => {
    if (message.type() === "error" && browserErrors.length < 50) browserErrors.push(redactText(message.text()));
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && failedAssets.length < 50) {
      failedAssets.push({ path: safeAssetPath(response.url()), status: response.status() });
    }
  });
  page.on("requestfailed", (request) => {
    if (failedRequests.length < 50) {
      failedRequests.push({
        path: safeAssetPath(request.url()),
        reason: redactText(request.failure()?.errorText ?? "Request failed."),
      });
    }
  });
  page.setDefaultTimeout(15_000);
  await page.goto(`${restarted.url}/settings/providers`);
  await page.getByLabel("Server password").waitFor({ timeout: 60_000 });
  await page.getByLabel("Server password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Base URL").fill(baseUrl);
  await page.getByLabel("Model ID").fill("browser-model");
  await page.getByLabel("API key", { exact: true }).fill(apiKey);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  await page.getByText("OK", { exact: true }).waitFor();
  assert.equal(captures.at(-1)?.model, "browser-model");
  assert.equal(captures.at(-1)?.authorized, true);
  assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "");
  checkSecrets(await page.locator("body").innerText());
  await page.screenshot({ path: join(OUT, "provider-console.png"), fullPage: true });
  await page.reload();
  await page.getByRole("button", { name: "Test connection", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Model ID").inputValue(), "browser-model");
  assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "");
  mode = "hold";
  received = Promise.withResolvers<void>();
  disconnected = Promise.withResolvers<void>();
  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  await bounded(received.promise, "browser Provider request");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await bounded(disconnected.promise, "browser Provider cancellation");
  mode = "ok";
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByLabel("Server password").waitFor();
  assert.equal(
    Schema.decodeUnknownSync(SessionState)(
      await page.request.get(`${restarted.url}/api/session`).then((response) => response.json()),
    ).authenticated,
    false,
  );
  checks.push("The real browser signs in, saves, tests, reloads settings, cancels requests and signs out.");
  await browser.close();
  browser = undefined;
  page = undefined;
  await stop(restarted.running);

  const unconfigured = await start(join(work, "unconfigured"), false);
  const unconfiguredCookie = await login(unconfigured.url);
  const empty = Schema.decodeUnknownSync(ProviderState)(
    JSON.parse((await api(unconfigured.url, "GET", "/api/provider", unconfiguredCookie)).body),
  );
  assert.equal(empty.credentialStorage, "unconfigured");
  assert.equal(
    (
      await api(
        unconfigured.url,
        "PUT",
        "/api/provider",
        unconfiguredCookie,
        JSON.stringify({ baseUrl, model: "fixture-model", apiKey }),
      )
    ).status,
    503,
  );
  await stop(unconfigured.running);
  checks.push("A server without an encryption key reports the missing capability and refuses Provider writes.");

  const persistedPath = join(directory, "opskar-openai-profile-v1.json");
  const persisted = await readFile(persistedPath, "utf8");
  const missingKey = launch(directory, false);
  assert.equal((await bounded(missingKey.exited, "missing key refusal")).code, 1);
  assert.ok(missingKey.output().includes("credential-key-required"));
  assert.ok((await readFile(persistedPath, "utf8")) === persisted, "Missing-key startup changed the saved profile.");
  const wrongKeyFile = join(work, "wrong-credential.key");
  const wrongKey = randomBytes(32).toString("base64");
  secrets.push(wrongKey);
  registerSecretValue(wrongKey, { allowShort: true });
  await writeFile(wrongKeyFile, `${wrongKey}\n`, { mode: 0o600 });
  await chmod(wrongKeyFile, 0o600);
  const wrong = launch(directory, true, wrongKeyFile);
  assert.equal((await bounded(wrong.exited, "wrong key refusal")).code, 1);
  assert.ok(wrong.output().includes("provider-profile"));
  assert.ok((await readFile(persistedPath, "utf8")) === persisted, "Wrong-key startup changed the saved profile.");
  checks.push("Missing and wrong encryption keys refuse startup without changing the saved Provider profile.");
  for (const running of children) checkSecrets(running.output());
  assert.equal(fixtureFailure, null);
} catch (error) {
  failure = redactText(error instanceof Error ? error.message : "Unexpected E2E failure.");
  process.exitCode = 1;
  if (page && !page.isClosed()) {
    try {
      const visible = await page.locator("body").innerText({ timeout: 2000 });
      failureVisibleText = redactText(visible).slice(0, 16_000);
      // Never save a screenshot when page text contains a fixture secret. Also mask every input.
      checkSecrets(visible);
      const screenshot = join(OUT, "provider-console-failure.png");
      await page.screenshot({ path: screenshot, fullPage: true, mask: [page.locator("input, textarea")] });
      failureScreenshot = screenshot;
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
  if (fixture.listening) await close(fixture);
  const report = {
    passed: failure === null,
    runtime: process.versions.node,
    platform: process.platform,
    browser: process.env.OPSKAR_E2E_BROWSER_PATH
      ? "operator executable"
      : process.platform === "win32"
        ? "msedge"
        : "chromium",
    checks,
    requests: captures,
    failure,
    fixtureFailure,
    browserDiagnostics: { browserErrors, failedAssets, failedRequests, failureVisibleText, failureScreenshot },
    work,
  };
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  // Machine-readable: safe test results and the retained artifact directory.
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
