import { createServer, type Server } from "node:http";
import { Context, Effect, Layer } from "effect";
import { ServerCredentials } from "./server-credentials";
import { type ServerOptions, ServerStartupFailed } from "./server-options";
import { ServerStorage } from "./server-storage";
import { acquireWebConsole } from "./server-web";

const LOOPBACK = "127.0.0.1";

function listen(server: Server, port: number, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port, host: LOOPBACK, signal }, () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("The server has no TCP address."));
      else resolve(address.port);
    });
  });
}

function closeListener(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

/** Storage and optional local Provider console. Agent and scheduler services are not started. */
export class ServerRuntime extends Context.Service<
  ServerRuntime,
  { port: number; schemaVersion: number; credentialStorage: "ready" | "unconfigured" }
>()("opskar/ServerRuntime") {
  static layer(options: ServerOptions) {
    return Layer.effect(
      ServerRuntime,
      Effect.gen(function* () {
        const { schemaVersion } = yield* ServerStorage;
        const { status: credentialStorage } = yield* ServerCredentials;
        const web = options.web ? yield* acquireWebConsole(options) : null;
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            createServer((request, response) => {
              const ready = request.method === "GET" && request.url === "/health/ready";
              if (web && !ready) {
                web.handle(request, response);
                return;
              }
              response.writeHead(ready ? 200 : 404, {
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
              });
              response.end(
                JSON.stringify(
                  ready
                    ? { status: "ready", stage: "storage", schemaVersion, credentialStorage }
                    : { error: "not-found" },
                ),
              );
            }),
          ),
          (server) =>
            Effect.tryPromise({
              try: () => closeListener(server),
              catch: (cause) => new ServerStartupFailed({ code: "shutdown", cause }),
            }).pipe(Effect.orDie),
        );
        const port = yield* Effect.tryPromise({
          try: (signal) => listen(server, options.port, signal),
          catch: (cause) => new ServerStartupFailed({ code: "listener", cause }),
        });
        return { port, schemaVersion, credentialStorage };
      }),
    ).pipe(Layer.provideMerge(ServerCredentials.layer(options).pipe(Layer.provideMerge(ServerStorage.layer(options)))));
  }
}
