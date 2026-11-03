import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createOpenBotLogger } from "@openbot/logging";
import { Cause, Effect, Exit, ManagedRuntime, Result, Schema } from "effect";
import { ProviderCredentialStore } from "../src/backend/provider-credential-store";
import { SERVER_CREDENTIAL_FILE, ServerCredentials } from "../src/server/server-credentials";
import { readServerOptions, ServerStartupFailed } from "../src/server/server-options";
import { ServerRuntime } from "../src/server/server-runtime";
import { ServerSecretCipher } from "../src/server/server-secret-cipher";
import { ServerStorage } from "../src/server/server-storage";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".openbot-build/server-credentials");
const Mode = Schema.Literals([
  "unconfigured",
  "cipher",
  "write",
  "read",
  "clear-first",
  "read-one",
  "clear-last",
  "write-failure",
]);
type Mode = typeof Mode.Type;
const ResultMessage = Schema.Struct({
  type: Schema.Literal("result"),
  status: Schema.String,
  checks: Schema.Array(Schema.String),
});
const TestValues = Schema.Struct({
  first: Schema.NonEmptyString,
  second: Schema.NonEmptyString,
  master: Schema.NonEmptyString,
});
const StoredEnvelope = Schema.Struct({
  version: Schema.Int,
  credentials: Schema.Struct({ codex: Schema.String, claude: Schema.String }),
});

async function child(): Promise<void> {
  const mode = Schema.decodeUnknownSync(Mode)(process.argv[3]);
  const values = Schema.decodeUnknownSync(TestValues)({
    first: process.env.OPSKAR_E2E_FIRST,
    second: process.env.OPSKAR_E2E_SECOND,
    master: process.env.OPSKAR_E2E_MASTER,
  });
  const options = readServerOptions(process.argv.slice(4));
  const runtime = ManagedRuntime.make(ServerRuntime.layer(options));
  const outcome = await runtime.runPromiseExit(
    Effect.gen(function* () {
      const server = yield* ServerRuntime;
      const credentials = yield* ServerCredentials;
      const storage = yield* ServerStorage;
      const checks: string[] = [];
      const response = yield* Effect.tryPromise(() => fetch(`http://127.0.0.1:${server.port}/health/ready`));
      assert.equal(response.status, 200);
      const health = yield* Effect.tryPromise(() => response.text());
      assert.equal(
        health.includes(values.first) || health.includes(values.second) || health.includes(values.master),
        false,
      );
      assert.ok(health.includes(`"credentialStorage":"${credentials.status}"`));
      if (mode === "unconfigured") {
        assert.equal(credentials.status, "unconfigured");
        assert.equal(credentials.cipher, null);
        assert.equal(credentials.providers, null);
        return {
          type: "result",
          status: credentials.status,
          checks: ["No key and no saved credentials leave the capability unconfigured."],
        };
      }
      assert.equal(credentials.status, "ready");
      assert.ok(credentials.cipher && credentials.providers);
      const { cipher, providers } = credentials;
      const file = join(storage.paths.dataDirectory, SERVER_CREDENTIAL_FILE);

      if (mode === "cipher") {
        for (const value of [values.first, values.second, "", "服务端凭据 🔑\nsecond line"]) {
          assert.ok(cipher.decrypt(cipher.encrypt(value)) === value, "Cipher round trip failed.");
        }
        const first = cipher.encrypt(values.first);
        assert.ok(!first.equals(cipher.encrypt(values.first)), "Repeated encryption reused ciphertext.");
        const headerLength = Buffer.byteLength("OPSKAR_CREDENTIAL_V1\0");
        for (const index of [0, headerLength - 2, headerLength, headerLength + 12, first.length - 1]) {
          const changed = Buffer.from(first);
          changed.writeUInt8(changed.readUInt8(index) ^ 1, index);
          assert.throws(() => cipher.decrypt(changed), /could not be decrypted/);
        }
        for (const changed of [
          first.subarray(0, first.length - 1),
          Buffer.concat([first, Buffer.of(0)]),
          Buffer.from("desktop-ciphertext"),
        ]) {
          assert.throws(() => cipher.decrypt(changed), /could not be decrypted/);
        }
        assert.ok(cipher.decrypt(first) === values.first, "A rejected blob changed the cipher state.");
        const bound = cipher.encrypt(values.first, "codex");
        assert.ok(cipher.decrypt(bound, "codex") === values.first, "Record context round trip failed.");
        assert.throws(() => cipher.decrypt(bound, "claude"), /could not be decrypted/);
        assert.throws(() => cipher.decrypt(bound), /could not be decrypted/);
        const legacyPath = join(dirname(options.dataDirectory), "legacy-cipher-fixture.json");
        const legacyCipher = {
          encrypt: (value: string) => Buffer.from(`legacy:${value}`, "utf8"),
          decrypt: (value: Buffer) => {
            if (!value.subarray(0, 7).equals(Buffer.from("legacy:"))) throw new Error("Invalid legacy fixture.");
            return value.subarray(7).toString("utf8");
          },
        };
        yield* Effect.tryPromise(() =>
          writeFile(
            legacyPath,
            JSON.stringify({
              version: 1,
              credentials: { codex: legacyCipher.encrypt(values.first).toString("base64") },
            }),
          ),
        );
        const legacy = new ProviderCredentialStore(legacyPath, legacyCipher);
        assert.equal(yield* legacy.load(), null);
        assert.ok(legacy.get("codex") === values.first, "A one-argument cipher could not load the existing envelope.");
        yield* legacy.set("claude", values.second);
        yield* legacy.clear("codex");
        const reloaded = new ProviderCredentialStore(legacyPath, legacyCipher);
        assert.equal(yield* reloaded.load(), null);
        assert.equal(reloaded.status("codex"), "missing");
        assert.ok(reloaded.get("claude") === values.second, "A one-argument cipher did not preserve a saved value.");
        yield* reloaded.clear("claude");
        assert.equal(existsSync(legacyPath), false);
        checks.push(
          "AES-GCM preserves text, uses fresh nonces and rejects changed headers, nonces, bodies, tags and lengths.",
        );
      } else {
        if (mode === "write") {
          yield* Effect.all([providers.set("codex", values.first), providers.set("claude", values.second)], {
            concurrency: 2,
          });
        }
        if (["write", "read", "clear-first", "write-failure"].includes(mode)) {
          assert.ok(providers.get("codex") === values.first, "The first saved credential was not restored.");
          assert.ok(providers.get("claude") === values.second, "The second saved credential was not restored.");
        }
        if (mode === "clear-first") {
          yield* providers.clear("codex");
          assert.equal(providers.status("codex"), "missing");
          assert.ok(providers.get("claude") === values.second, "Clearing one credential changed the other.");
        }
        if (mode === "read-one" || mode === "clear-last") {
          assert.equal(providers.status("codex"), "missing");
          assert.ok(providers.get("claude") === values.second, "The remaining credential did not survive restart.");
        }
        if (mode === "clear-last") {
          yield* providers.clear("claude");
          assert.equal(providers.status("claude"), "missing");
          assert.equal(existsSync(file), false);
        }
        if (mode === "write-failure") {
          const before = yield* Effect.tryPromise(() => readFile(file));
          assert.ok(cipher instanceof ServerSecretCipher);
          cipher.dispose();
          const failed = yield* Effect.result(providers.set("codex", `${values.first}-replacement`));
          assert.ok(Result.isFailure(failed), "Saving through a closed cipher did not fail.");
          assert.ok(providers.get("codex") === values.first, "A failed write changed memory.");
          assert.ok((yield* Effect.tryPromise(() => readFile(file))).equals(before), "A failed write changed disk.");
        }
        checks.push(`Credential store operation ${mode} retained the expected saved or missing state.`);
      }

      const logger = createOpenBotLogger("cipher-e2e");
      const opaque = mode === "read-one" || mode === "clear-last" ? [values.second] : [values.first, values.second];
      logger.info("Opaque values", {
        first: opaque,
        second: values.master,
        third: Buffer.from(values.master, "base64").toString("hex"),
      });
      checks.push("The process emitted a redaction probe without adding secrets to its result.");
      return { type: "result", status: credentials.status, checks };
    }),
  );
  await runtime.dispose();
  let reply: typeof ResultMessage.Type;
  if (Exit.isFailure(outcome)) {
    const error = Cause.findError(outcome.cause);
    const status =
      Result.isSuccess(error) && error.success instanceof ServerStartupFailed ? error.success.code : "probe-failed";
    reply = { type: "result", status, checks: [] };
    process.exitCode = 1;
  } else reply = Schema.decodeUnknownSync(ResultMessage)(outcome.value);
  const send = process.send?.bind(process);
  assert.ok(send);
  await new Promise<void>((resolve, reject) => send(reply, (error) => (error ? reject(error) : resolve())));
  process.disconnect?.();
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const work = await mkdtemp(join(OUT, "run-"));
  const directory = join(work, "data");
  const file = join(directory, SERVER_CREDENTIAL_FILE);
  const key = randomBytes(32);
  const wrongKey = randomBytes(32);
  const first = randomBytes(24).toString("hex");
  const second = randomBytes(24).toString("hex");
  const keyFile = join(work, "operator.key");
  const wrongKeyFile = join(work, "wrong.key");
  const keyText = `${key.toString("base64")}\n`;
  await writeFile(keyFile, keyText, { flag: "wx", mode: 0o600 });
  await writeFile(wrongKeyFile, `${wrongKey.toString("base64")}\n`, { flag: "wx", mode: 0o600 });
  const sensitive = [
    first,
    second,
    key.toString("base64"),
    key.toString("hex"),
    wrongKey.toString("base64"),
    wrongKey.toString("hex"),
  ];
  const checks: string[] = [];

  async function run(mode: Mode, selectedKey?: string, expectedFailure?: string) {
    const entry = expectedFailure ? join(ROOT, "src/server/index.ts") : import.meta.filename;
    const args = [...(expectedFailure ? [] : ["--child", mode]), "--data-dir", directory];
    const processChild = fork(entry, args, {
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
        OPSKAR_E2E_FIRST: first,
        OPSKAR_E2E_SECOND: second,
        OPSKAR_E2E_MASTER: key.toString("base64"),
        ...(selectedKey === undefined ? {} : { OPSKAR_CREDENTIAL_KEY_FILE: selectedKey }),
      },
    });
    let output = "";
    let message: unknown;
    processChild.stdout?.on("data", (value: Buffer) => (output += value.toString()));
    processChild.stderr?.on("data", (value: Buffer) => (output += value.toString()));
    processChild.on("message", (value) => (message = value));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("The credential process did not exit.")), 30_000);
        timer.unref();
        processChild.once("error", reject);
        processChild.once("close", (code) => resolve(code));
      });
      for (const secret of sensitive) {
        assert.equal(output.includes(secret), false, "A child log exposed a synthetic secret.");
        assert.equal(
          (JSON.stringify(message) ?? "").includes(secret),
          false,
          "A child result exposed a synthetic secret.",
        );
      }
      assert.equal(code, expectedFailure ? 1 : 0, "Unexpected credential process exit status.");
      assert.equal(existsSync(join(directory, ".opskar-server.lock")), false);
      if (expectedFailure) {
        assert.ok(output.includes(expectedFailure), "The expected startup failure code was not reported.");
        assert.equal(output.includes('"type":"ready"'), false);
        return;
      }
      const result = Schema.decodeUnknownSync(ResultMessage)(message);
      assert.equal(result.status, mode === "unconfigured" ? "unconfigured" : "ready");
      if (mode !== "unconfigured") assert.ok(output.includes("[redacted]"));
    } finally {
      clearTimeout(timer);
      if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill();
    }
  }

  let failure: string | null = null;
  try {
    await run("unconfigured");
    assert.equal(existsSync(file), false);
    await run("cipher", keyFile);
    checks.push("Unconfigured startup has no cipher; configured AES-GCM round trips and tamper checks pass.");
    await run("write", keyFile);
    const original = await readFile(file);
    for (const secret of sensitive)
      assert.equal(original.includes(secret), false, "Plaintext was stored in the credential file.");
    await run("read", keyFile);
    assert.ok((await readFile(file)).equals(original), "Loading credentials rewrote the file.");
    checks.push(
      "Concurrent saves survive restart as encrypted data, with no plaintext in disk, logs, health or IPC results.",
    );

    for (const [selectedKey, code] of [
      [undefined, "credential-key-required"],
      [wrongKeyFile, "credential-store"],
      [join(work, "missing.key"), "credential-key"],
    ] as const) {
      await run("read", selectedKey, code);
      assert.ok((await readFile(file)).equals(original), "A key failure changed saved ciphertext.");
    }
    checks.push("Missing, wrong and unavailable keys stop the real server without changing stored ciphertext.");

    const savedFile = join(work, "before-link.json");
    const missingTarget = join(work, "missing-link-target");
    await rename(file, savedFile);
    try {
      await symlink(missingTarget, file, process.platform === "win32" ? "junction" : "file");
      assert.ok((await lstat(file)).isSymbolicLink());
      await run("read", keyFile, "credential-store");
      await run("read", undefined, "credential-store");
      assert.ok((await lstat(file)).isSymbolicLink(), "The credential link was replaced.");
      assert.equal(existsSync(missingTarget), false);
    } finally {
      const remaining = await lstat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (remaining) await rename(file, join(work, "rejected-vault-link"));
      await rename(savedFile, file);
    }
    assert.ok((await readFile(file)).equals(original));
    checks.push("A dangling credential link is refused with or without a key and is not replaced by an empty store.");

    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const canonical = key.toString("base64");
    const last = canonical[42];
    assert.ok(last);
    const noncanonical = `${canonical.slice(0, 42)}${alphabet[alphabet.indexOf(last) + 1]}=`;
    for (const [name, text] of [
      ["short", randomBytes(31).toString("base64")],
      ["long", randomBytes(33).toString("base64")],
      ["malformed", first],
      ["oversized", first.repeat(8)],
      ["noncanonical", noncanonical],
    ]) {
      assert.ok(name && text);
      const invalidFile = join(work, `${name}.key`);
      await writeFile(invalidFile, text, { flag: "wx", mode: 0o600 });
      await run("read", invalidFile, "credential-key");
      assert.ok((await readFile(file)).equals(original), "An invalid key file changed credentials.");
    }
    const insideKey = join(directory, "rejected.key");
    await writeFile(insideKey, keyText, { flag: "wx", mode: 0o600 });
    try {
      await run("read", insideKey, "credential-key");
    } finally {
      await rename(insideKey, join(work, "rejected-inside.key"));
    }
    if (process.platform !== "win32") {
      await chmod(keyFile, 0o644);
      try {
        await run("read", keyFile, "credential-key");
      } finally {
        await chmod(keyFile, 0o600);
      }
    }
    checks.push(
      "Invalid key sizes, malformed encoding, noncanonical base64 and keys inside the data directory are refused.",
    );

    const envelope = Schema.decodeUnknownSync(StoredEnvelope)(JSON.parse(original.toString("utf8")));
    const blob = Buffer.from(envelope.credentials.codex, "base64");
    blob.writeUInt8(blob.readUInt8(blob.length - 1) ^ 1, blob.length - 1);
    for (const damaged of [
      JSON.stringify({ ...envelope, credentials: { ...envelope.credentials, codex: blob.toString("base64") } }),
      JSON.stringify({
        ...envelope,
        credentials: { codex: envelope.credentials.claude, claude: envelope.credentials.codex },
      }),
      JSON.stringify({ ...envelope, version: 2 }),
      `{"version":1,"credentials":${first}`,
    ]) {
      const bytes = Buffer.from(damaged);
      await writeFile(file, bytes);
      try {
        await run("read", keyFile, "credential-store");
        assert.ok((await readFile(file)).equals(bytes), "An unreadable envelope was overwritten.");
      } finally {
        await writeFile(file, original);
      }
    }
    checks.push(
      "Tampered ciphertext, swapped provider entries, unknown envelope versions and malformed JSON fail closed and remain unchanged.",
    );

    await run("write-failure", keyFile);
    assert.ok((await readFile(file)).equals(original));
    await run("read", keyFile);
    checks.push("An encryption failure preserves memory and disk, and a fresh process can still load the credentials.");
    await run("clear-first", keyFile);
    await run("read-one", keyFile);
    await run("clear-last", keyFile);
    assert.equal(existsSync(file), false);
    await run("unconfigured");
    assert.ok((await readFile(keyFile)).equals(Buffer.from(keyText)), "The operator key was changed.");
    checks.push("Clearing one credential preserves the other; clearing the last keeps the operator key unchanged.");
  } catch (error) {
    failure = error instanceof Error ? error.message : "Credential E2E failed.";
    process.exitCode = 1;
  }
  const report = {
    passed: failure === null,
    node: process.versions.node,
    platform: process.platform,
    checks,
    failure,
    posixPermissionsTested: process.platform !== "win32",
    work,
  };
  await writeFile(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  // Machine-readable: no key values, plaintext or raw child output enter this report.
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[2] === "--child") {
  await child().catch(() => {
    process.exitCode = 1;
    process.disconnect?.();
  });
} else await main();
