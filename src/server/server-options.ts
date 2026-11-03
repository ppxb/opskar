import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Schema } from "effect";

const ServerOptions = Schema.Struct({
  dataDirectory: Schema.NonEmptyString,
  port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
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
    "listener",
    "shutdown",
  ]),
  cause: Schema.Defect(),
}) {}

/** Decode command-line input once; no desktop profile is selected by default. */
export function readServerOptions(args: string[]): ServerOptions {
  const { values } = parseArgs({
    args,
    options: {
      "data-dir": { type: "string" },
      port: { type: "string", default: "0" },
    },
    strict: true,
    allowPositionals: false,
  });
  const options = Schema.decodeUnknownSync(ServerOptions)({
    dataDirectory: values["data-dir"]?.trim(),
    port: Number(values.port),
  });
  return { ...options, dataDirectory: resolve(options.dataDirectory) };
}
