import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { ProviderCredentialStore, type SecretCipher } from "../backend/provider-credential-store";
import { type ServerOptions, ServerStartupFailed } from "./server-options";
import { acquireServerCipher } from "./server-secret-cipher";
import { ServerStorage } from "./server-storage";

export const SERVER_CREDENTIAL_FILE = "opskar-provider-credentials-v1.json";

type ServerCredentialState =
  | { status: "unconfigured"; cipher: null; providers: null }
  | { status: "ready"; cipher: SecretCipher; providers: ProviderCredentialStore };

/** Internal credential access only; no secret values or write operations are exposed over HTTP. */
export class ServerCredentials extends Context.Service<ServerCredentials, ServerCredentialState>()(
  "opskar/ServerCredentials",
) {
  static layer(options: ServerOptions) {
    return Layer.effect(
      ServerCredentials,
      Effect.gen(function* () {
        const { paths } = yield* ServerStorage;
        const credentialFile = join(paths.dataDirectory, SERVER_CREDENTIAL_FILE);
        const exists = yield* Effect.tryPromise({
          try: async () => {
            try {
              const metadata = await lstat(credentialFile);
              if (!metadata.isFile()) throw new Error("The credential path must be a regular file.");
              return true;
            } catch (cause) {
              if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
              throw cause;
            }
          },
          catch: (cause) => new ServerStartupFailed({ code: "credential-store", cause }),
        });
        if (options.credentialKeyFile === undefined) {
          if (exists) {
            return yield* new ServerStartupFailed({
              code: "credential-key-required",
              cause: new Error("A key is required to open the existing server credentials."),
            });
          }
          return { status: "unconfigured", cipher: null, providers: null } satisfies ServerCredentialState;
        }
        const cipher = yield* acquireServerCipher(options.credentialKeyFile, paths.dataDirectory);
        const providers = new ProviderCredentialStore(credentialFile, cipher);
        const unreadable = yield* providers.load();
        // The shared store reports unreadable data as a value. Do not expose its destructive recovery writes.
        if (unreadable) return yield* new ServerStartupFailed({ code: "credential-store", cause: unreadable });
        return { status: "ready", cipher, providers } satisfies ServerCredentialState;
      }),
    );
  }
}
