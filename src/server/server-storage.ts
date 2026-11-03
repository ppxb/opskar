import { join } from "node:path";
import { DEFAULT_AGENT_DEFAULTS } from "@openbot/contracts/ipc";
import { Context, Effect, Layer } from "effect";
import { AgentStore } from "../backend/agent-store";
import { databaseRow, requiredNumberColumn } from "../backend/database/database-rows";
import { MailboxStore } from "../backend/mailbox-store";
import { OpenBotDatabase } from "../backend/openbot-database";
import { acquireServerDirectory } from "./server-directory";
import { type ServerOptions, ServerStartupFailed } from "./server-options";

interface ServerStorageState {
  paths: { dataDirectory: string; filesDirectory: string };
  database: OpenBotDatabase;
  agents: AgentStore;
  mailbox: MailboxStore;
  schemaVersion: number;
}

/** One database and one instance of each store. This layer does not start an execution service. */
export class ServerStorage extends Context.Service<ServerStorage, ServerStorageState>()("opskar/ServerStorage") {
  static layer(options: ServerOptions) {
    return Layer.effect(
      ServerStorage,
      Effect.gen(function* () {
        const paths = {
          dataDirectory: options.dataDirectory,
          filesDirectory: join(options.dataDirectory, "files"),
        };
        yield* acquireServerDirectory(paths.dataDirectory);
        const database = yield* Effect.acquireRelease(
          Effect.gen(function* () {
            const database = new OpenBotDatabase(paths.dataDirectory);
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
        // The explicit files root and isolated home argument prevent the store's ~/OpenBot default.
        const agents = new AgentStore(
          paths.dataDirectory,
          paths.dataDirectory,
          database,
          () => DEFAULT_AGENT_DEFAULTS,
          paths.filesDirectory,
        );
        yield* agents
          .initialize()
          .pipe(Effect.mapError(({ cause }) => new ServerStartupFailed({ code: "agent-store", cause })));
        const mailbox = new MailboxStore(paths.dataDirectory, agents.sharedRoot, database);
        yield* mailbox
          .initialize()
          .pipe(Effect.mapError(({ cause }) => new ServerStartupFailed({ code: "mailbox-store", cause })));
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
        // Store operations must run through the owning ManagedRuntime, so disposal waits for writes.
        return { paths, database, agents, mailbox, schemaVersion };
      }),
    );
  }
}
