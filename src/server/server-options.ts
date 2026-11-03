import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Schema } from "effect";

const ServerOptions = Schema.Struct({
  dataDirectory: Schema.NonEmptyString,
  port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
  credentialKeyFile: Schema.optional(Schema.NonEmptyString),
  web: Schema.optional(Schema.Boolean),
  webPasswordFile: Schema.optional(Schema.NonEmptyString),
});

export type ServerOptions = typeof ServerOptions.Type;

export class ServerStartupFailed extends Schema.TaggedError<ServerStartupFailed>()("ServerStartupFailed", {
  code: Schema.Literals([
    "directory",
    "directory-in-use",
    "directory-not-owned",
    "database",
    "agent-store",
    "mailbox-store",
    "credential-key",
    "credential-key-required",
    "credential-store",
    "provider-profile",
    "web-password",
    "web-console",
    "workspace",
    "listener",
    "shutdown",
  ]),
  cause: Schema.Defect(),
}) {}

/** Decode command-line input once; no desktop profile is selected by default. */
export function readServerOptions(args: string[], environment = process.env): ServerOptions {
  const { values } = parseArgs({
    args,
    options: {
      "data-dir": { type: "string" },
      port: { type: "string", default: "0" },
      web: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const options = Schema.decodeUnknownSync(ServerOptions)({
    dataDirectory: values["data-dir"]?.trim(),
    port: Number(values.port),
    credentialKeyFile: environment.OPSKAR_CREDENTIAL_KEY_FILE?.trim(),
    web: values.web,
    webPasswordFile: environment.OPSKAR_WEB_PASSWORD_FILE?.trim(),
  });
  return {
    ...options,
    dataDirectory: resolve(options.dataDirectory),
    ...(options.credentialKeyFile === undefined ? {} : { credentialKeyFile: resolve(options.credentialKeyFile) }),
    ...(options.webPasswordFile === undefined ? {} : { webPasswordFile: resolve(options.webPasswordFile) }),
  };
}
