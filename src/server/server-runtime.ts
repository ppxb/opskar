import { createServer, type Server } from "node:http";
import { Context, Effect, Layer } from "effect";
import { databaseRow, requiredNumberColumn } from "../backend/database/database-rows";
import { OpenBotDatabase } from "../backend/openbot-database";
import { acquireServerDirectory } from "./server-directory";
import { type ServerOptions, ServerStartupFailed } from "./server-options";

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

/** Storage bootstrap only. Agent, provider, scheduler and account services are not started. */
export class ServerRuntime extends Context.Service<ServerRuntime, { port: number; schemaVersion: number }>()(
  "opskar/ServerRuntime",
) {
  static layer(options: ServerOptions) {
    return Layer.effect(
      ServerRuntime,
      Effect.gen(function* () {
        yield* acquireServerDirectory(options.dataDirectory);
        const database = yield* Effect.acquireRelease(
          Effect.gen(function* () {
            const database = new OpenBotDatabase(options.dataDirectory);
            yield* database
              .initialize()
              .pipe(Effect.mapError(({ cause }) => new ServerStartupFailed({ code: "database", cause })));
            return database;
          }),
          (database) =>
            Effect.try({
              try: () => database.close(),
              catch: (cause) => new ServerStartupFailed({ code: "shutdown", cause }),
            }).pipe(Effect.orDie),
        );
        const schemaVersion = yield* Effect.try({
          try: () => {
            const row = databaseRow(
              database.connection.prepare("SELECT MAX(version) AS version FROM schema_migrations").get(),
            );
            if (!row) throw new Error("The database has no schema version.");
            return requiredNumberColumn(row, "version");
          },
          catch: (cause) => new ServerStartupFailed({ code: "database", cause }),
        });
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            createServer((request, response) => {
              const ready = request.method === "GET" && request.url === "/health/ready";
              response.writeHead(ready ? 200 : 404, {
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
              });
              response.end(
                JSON.stringify(ready ? { status: "ready", stage: "storage", schemaVersion } : { error: "not-found" }),
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
        return { port, schemaVersion };
      }),
    );
  }
}
