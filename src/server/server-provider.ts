import { lstat, readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { ProviderInput, type ProviderState } from "@openbot/contracts/server-console";
import { redactText, registerSecretValue } from "@openbot/logging";
import { Effect, Option, Schema, Semaphore } from "effect";
import { writeJsonFileAtomically } from "../backend/atomic-json-file";
import type { ConsoleAuth } from "./server-console-auth";
import { ConsoleFailure } from "./server-console-error";
import { ServerCredentials } from "./server-credentials";
import { ServerStartupFailed } from "./server-options";
import { ServerStorage } from "./server-storage";

export const SERVER_PROFILE_FILE = "opskar-openai-profile-v1.json";
const PROFILE_CONTEXT = "opskar/openai-profile/v1";
const Profile = Schema.Struct({ ...ProviderInput.fields, apiKey: Schema.String.check(Schema.isMaxLength(8192)) });
type Profile = typeof Profile.Type;
const Envelope = Schema.Struct({ version: Schema.Literal(1), ciphertext: Schema.NonEmptyString });
const Completion = Schema.Struct({
  choices: Schema.Array(Schema.Struct({ message: Schema.Struct({ content: Schema.String }) })),
});

function privateHttpHost(host: string): boolean {
  if (host === "localhost" || host === "[::1]") return true;
  if (isIP(host) !== 4) return false;
  const [first, second] = host.split(".").map(Number);
  return (
    first === 127 ||
    first === 10 ||
    (first === 192 && second === 168) ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31)
  );
}

function normalizeEndpoint(value: string): string {
  const url = new URL(value.trim());
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && privateHttpHost(url.hostname)))
  ) {
    throw new ConsoleFailure({ code: "invalid" });
  }
  return url.href.replace(/\/+$/u, "");
}

async function completionText(response: Response): Promise<string> {
  if (!response.body) throw new ConsoleFailure({ code: "response" });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 64 * 1024) throw new ConsoleFailure({ code: "response" });
      chunks.push(part.value);
    }
    const body = Schema.decodeUnknownSync(Completion)(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const text = body.choices[0]?.message.content;
    if (!text?.trim()) throw new ConsoleFailure({ code: "response" });
    return text;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** A saved endpoint and a fixed connection test. No agent or CLI runtime is started. */
export const acquireProviderConsole = Effect.fn("acquireProviderConsole")(function* (auth: ConsoleAuth) {
  const credentials = yield* ServerCredentials;
  const { paths } = yield* ServerStorage;
  const path = join(paths.dataDirectory, SERVER_PROFILE_FILE);
  let profile: Profile | null = null;
  const contents = yield* Effect.tryPromise({
    try: async () => {
      try {
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.size > 32 * 1024) throw new Error("Invalid Provider profile file.");
        return await readFile(path, "utf8");
      } catch (cause) {
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
        throw cause;
      }
    },
    catch: (cause) => new ServerStartupFailed({ code: "provider-profile", cause }),
  });
  if (contents !== null) {
    if (credentials.status !== "ready") {
      return yield* new ServerStartupFailed({
        code: "credential-key-required",
        cause: new Error("A profile key is required."),
      });
    }
    profile = yield* Effect.try({
      try: () => {
        const envelope = Schema.decodeUnknownSync(Envelope)(JSON.parse(contents));
        const saved = Schema.decodeUnknownSync(Profile)(
          JSON.parse(credentials.cipher.decrypt(Buffer.from(envelope.ciphertext, "base64"), PROFILE_CONTEXT)),
        );
        if (normalizeEndpoint(saved.baseUrl) !== saved.baseUrl || !saved.model.trim())
          throw new Error("Invalid profile.");
        if (saved.apiKey) registerSecretValue(saved.apiKey, { allowShort: true });
        return saved;
      },
      catch: (cause) => new ServerStartupFailed({ code: "provider-profile", cause }),
    });
  }
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      profile = null;
    }),
  );
  const writes = Semaphore.makeUnsafe(1);
  const probes = Semaphore.makeUnsafe(1);
  const state = (): ProviderState => ({
    credentialStorage: credentials.status,
    provider: profile ? { baseUrl: profile.baseUrl, model: profile.model, hasApiKey: Boolean(profile.apiKey) } : null,
  });
  const get = Effect.fn("ProviderConsole.get")(function* (token: string | undefined) {
    yield* auth.requireSession(token);
    return state();
  });
  const save = Effect.fn("ProviderConsole.save")(function* (token: string | undefined, input: ProviderInput) {
    return yield* writes.withPermit(
      Effect.gen(function* () {
        yield* auth.requireSession(token);
        if (credentials.status !== "ready") return yield* new ConsoleFailure({ code: "unconfigured" });
        const baseUrl = yield* Effect.try({
          try: () => normalizeEndpoint(input.baseUrl),
          catch: () => new ConsoleFailure({ code: "invalid" }),
        });
        const model = input.model.trim();
        if (!model || /[\r\n]/u.test(model) || (input.apiKey !== undefined && /[\r\n]/u.test(input.apiKey))) {
          return yield* new ConsoleFailure({ code: "invalid" });
        }
        if (profile?.apiKey && profile.baseUrl !== baseUrl && input.apiKey === undefined) {
          return yield* new ConsoleFailure({ code: "key-required" });
        }
        const next = {
          baseUrl,
          model,
          apiKey: input.apiKey === undefined ? (profile?.apiKey ?? "") : input.apiKey.trim(),
        };
        if (next.apiKey) registerSecretValue(next.apiKey, { allowShort: true });
        const ciphertext = yield* Effect.try({
          try: () => credentials.cipher.encrypt(JSON.stringify(next), PROFILE_CONTEXT).toString("base64"),
          catch: () => new ConsoleFailure({ code: "storage" }),
        });
        yield* writeJsonFileAtomically(path, { version: 1, ciphertext }).pipe(
          Effect.mapError(() => new ConsoleFailure({ code: "storage" })),
        );
        profile = next;
        return state();
      }).pipe(Effect.uninterruptible),
    );
  });
  const test = Effect.fn("ProviderConsole.test")(function* (token: string | undefined) {
    yield* auth.requireSession(token);
    if (!profile) return yield* new ConsoleFailure({ code: "not-saved" });
    const saved = profile;
    const result = yield* probes.withPermitsIfAvailable(1)(
      Effect.tryPromise({
        try: async (signal) => {
          const deadline = AbortSignal.timeout(20_000);
          try {
            const response = await fetch(`${saved.baseUrl}/chat/completions`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(saved.apiKey ? { Authorization: `Bearer ${saved.apiKey}` } : {}),
              },
              body: JSON.stringify({
                model: saved.model,
                messages: [{ role: "user", content: "Reply with OK." }],
                max_tokens: 32,
                stream: false,
              }),
              redirect: "manual",
              signal: AbortSignal.any([signal, deadline]),
            });
            if (!response.ok) {
              await response.body?.cancel();
              throw new ConsoleFailure({ code: "provider" });
            }
            const text = await completionText(response);
            return { status: "ok" as const, text: redactText(text).slice(0, 4096) };
          } catch (cause) {
            if (deadline.aborted) throw new ConsoleFailure({ code: "timeout" });
            throw cause;
          }
        },
        catch: (cause) => (cause instanceof ConsoleFailure ? cause : new ConsoleFailure({ code: "provider" })),
      }),
    );
    yield* auth.requireSession(token);
    if (Option.isNone(result)) return yield* new ConsoleFailure({ code: "busy" });
    return result.value;
  });
  return { get, save, test };
});
