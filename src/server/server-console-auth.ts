import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { registerSecretValue } from "@openbot/logging";
import { Effect } from "effect";
import { isPathInside } from "../backend/path-containment";
import { ConsoleFailure } from "./server-console-error";
import { type ServerOptions, ServerStartupFailed } from "./server-options";

const SESSION_MS = 8 * 60 * 60 * 1000;
export const CONSOLE_COOKIE = "opskar_session";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Single-operator access. Sessions remain in this process and expire on restart. */
export class ConsoleAuth {
  readonly #passwordHash: Buffer;
  readonly #sessions = new Map<string, number>();
  #attempts = 0;
  #windowEnd = 0;

  constructor(password: string) {
    registerSecretValue(password, { allowShort: true });
    this.#passwordHash = digest(password);
  }

  authenticated(token: string | undefined): boolean {
    if (!token || !/^[a-f0-9]{64}$/u.test(token)) return false;
    const hash = digest(token).toString("hex");
    const expires = this.#sessions.get(hash);
    if (expires === undefined) return false;
    if (expires <= Date.now()) {
      this.#sessions.delete(hash);
      return false;
    }
    return true;
  }

  requireSession = Effect.fn("ConsoleAuth.requireSession")(function* (this: ConsoleAuth, token: string | undefined) {
    if (!this.authenticated(token)) return yield* new ConsoleFailure({ code: "unauthorized" });
  });

  login = Effect.fn("ConsoleAuth.login")(function* (this: ConsoleAuth, password: string, previous: string | undefined) {
    const now = Date.now();
    if (now >= this.#windowEnd) {
      this.#attempts = 0;
      this.#windowEnd = now + 60_000;
    }
    if (++this.#attempts > 10) return yield* new ConsoleFailure({ code: "rate-limit" });
    if (!timingSafeEqual(this.#passwordHash, digest(password))) {
      return yield* new ConsoleFailure({ code: "unauthorized" });
    }
    if (previous) this.#sessions.delete(digest(previous).toString("hex"));
    for (const [hash, expires] of this.#sessions) if (expires <= now) this.#sessions.delete(hash);
    if (this.#sessions.size >= 16) return yield* new ConsoleFailure({ code: "rate-limit" });
    const token = randomBytes(32).toString("hex");
    registerSecretValue(token);
    this.#sessions.set(digest(token).toString("hex"), now + SESSION_MS);
    return `${CONSOLE_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`;
  });

  logout = Effect.fn("ConsoleAuth.logout")(function* (this: ConsoleAuth, token: string | undefined) {
    yield* this.requireSession(token);
    if (token) this.#sessions.delete(digest(token).toString("hex"));
    return `${CONSOLE_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  });

  dispose(): void {
    this.#sessions.clear();
    this.#passwordHash.fill(0);
  }
}

export const acquireConsoleAuth = Effect.fn("acquireConsoleAuth")(function* (options: ServerOptions) {
  return yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async (signal) => {
        if (!options.webPasswordFile) throw new Error("A Web password file is required.");
        const path = await realpath(options.webPasswordFile);
        const directory = await realpath(options.dataDirectory);
        if (isPathInside(directory, path)) throw new Error("Keep the Web password outside the data directory.");
        const metadata = await stat(path);
        if (
          !metadata.isFile() ||
          metadata.size > 1024 ||
          (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
        ) {
          throw new Error("The Web password file must be a private regular file.");
        }
        const password = (await readFile(path, { encoding: "utf8", signal })).trim();
        if (password.length < 16) throw new Error("The Web password needs at least 16 characters.");
        if (options.credentialKeyFile) {
          const key = (await readFile(options.credentialKeyFile, { encoding: "utf8", signal })).trim();
          if (password === key) throw new Error("Use separate Web and encryption secrets.");
        }
        return new ConsoleAuth(password);
      },
      catch: (cause) => new ServerStartupFailed({ code: "web-password", cause }),
    }),
    (auth) => Effect.sync(() => auth.dispose()),
  );
});
