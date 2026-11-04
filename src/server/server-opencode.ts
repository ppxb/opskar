import { execFile } from "node:child_process";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { type ServerOptions, ServerStartupFailed } from "./server-options";

const runFile = promisify(execFile);

async function availablePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("No service port.")));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

/** OpenCode 2 owns a service in its isolated home. The Node host owns its shutdown. */
export const acquireServerOpenCode = Effect.fn("acquireServerOpenCode")(function* (options: ServerOptions) {
  const resource = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        if (!options.opencodePath) throw new Error("No executable was configured.");
        const executable = await realpath(options.opencodePath);
        if (!(await stat(executable)).isFile()) throw new Error("The executable is not a file.");
        const root = join(options.dataDirectory, "provider-runtime");
        const environment: Record<string, string> = Object.fromEntries(
          Object.keys(process.env).map((key) => [key, ""]),
        );
        for (const name of ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "TZ"]) {
          if (process.env[name]) environment[name] = process.env[name];
        }
        for (const [name, folder] of [
          ["HOME", "home"],
          ["USERPROFILE", "home"],
          ["APPDATA", "appdata"],
          ["LOCALAPPDATA", "localappdata"],
          ["XDG_CONFIG_HOME", "config"],
          ["XDG_DATA_HOME", "data"],
          ["XDG_STATE_HOME", "state"],
          ["XDG_CACHE_HOME", "cache"],
          ["TEMP", "temp"],
          ["TMP", "temp"],
          ["TMPDIR", "temp"],
        ]) {
          if (!name || !folder) continue;
          const path = join(root, folder);
          await mkdir(path, { recursive: true, mode: 0o700 });
          environment[name] = path;
        }
        environment.OPENCODE_DISABLE_AUTOUPDATE = "1";
        environment.OPENCODE_DISABLE_MODELS_FETCH = "1";
        environment.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1";
        const config = join(root, "opskar-opencode.json");
        await writeFile(
          config,
          `${JSON.stringify({
            autoupdate: false,
            enabled_providers: ["opskar-local"],
            permission: { question: "deny" },
          })}\n`,
          { mode: 0o600 },
        );
        environment.OPENCODE_CONFIG = config;
        const version = await runFile(executable, ["--version"], {
          env: environment,
          windowsHide: true,
          timeout: 15_000,
        });
        if (!/\b(?:v)?2\.\d+\.\d+\b/u.test(version.stdout)) throw new Error("OpenCode 2 is required.");
        return { executable, environment, root };
      },
      catch: (cause) => new ServerStartupFailed({ code: "agent-runtime", cause }),
    }),
    ({ executable, environment }) =>
      Effect.tryPromise({
        try: () => runFile(executable, ["service", "stop"], { env: environment, windowsHide: true, timeout: 15_000 }),
        catch: (cause) => new ServerStartupFailed({ code: "shutdown", cause }),
      }).pipe(Effect.asVoid, Effect.orDie),
  );
  yield* Effect.tryPromise({
    try: async () => {
      const port = await availablePort();
      await runFile(resource.executable, ["service", "set", "port", String(port)], {
        env: resource.environment,
        windowsHide: true,
        timeout: 15_000,
      });
      await writeFile(join(resource.root, "service.json"), `${JSON.stringify({ port })}\n`, { mode: 0o600 });
    },
    catch: (cause) => new ServerStartupFailed({ code: "agent-runtime", cause }),
  });
  return resource;
});
