import { mkdir, open, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { ServerStartupFailed } from "./server-options";

const OWNER_FILE = ".opskar-server";
const OWNER_MARKER = "opskar-server-v1\n";
const LOCK_FILE = ".opskar-server.lock";

/** An exclusive lock for this Node host, with no automatic stale-lock removal. */
export const acquireServerDirectory = Effect.fn("acquireServerDirectory")(function* (directory: string) {
  yield* Effect.tryPromise({
    try: () => mkdir(directory, { recursive: true, mode: 0o700 }),
    catch: (cause) => new ServerStartupFailed({ code: "directory", cause }),
  });
  const lockPath = join(directory, LOCK_FILE);
  const lock = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => open(lockPath, "wx", 0o600),
      catch: (cause) =>
        new ServerStartupFailed({
          code: cause instanceof Error && "code" in cause && cause.code === "EEXIST" ? "directory-in-use" : "directory",
          cause,
        }),
    }),
    (lock) =>
      Effect.tryPromise({
        try: async () => {
          await lock.close();
          await unlink(lockPath);
        },
        catch: (cause) => new ServerStartupFailed({ code: "shutdown", cause }),
      }).pipe(Effect.orDie),
  );
  yield* Effect.tryPromise({
    try: () => lock.writeFile(`${process.pid}\n`),
    catch: (cause) => new ServerStartupFailed({ code: "directory", cause }),
  });
  // Finish the owner marker before cancellation can release the directory lock.
  yield* Effect.tryPromise({
    try: async () => {
      const entries = (await readdir(directory)).filter((entry) => entry !== LOCK_FILE);
      if (entries.includes(OWNER_FILE)) {
        if ((await readFile(join(directory, OWNER_FILE), "utf8")) !== OWNER_MARKER) {
          throw new Error("The data directory has an unknown owner marker.");
        }
      } else {
        if (entries.length > 0) throw new Error("Use an empty directory for the first Node host start.");
        await writeFile(join(directory, OWNER_FILE), OWNER_MARKER, { flag: "wx", mode: 0o600 });
      }
    },
    catch: (cause) => new ServerStartupFailed({ code: "directory-not-owned", cause }),
  }).pipe(Effect.uninterruptible);
});
