import { createOpenBotLogger } from "@openbot/logging";
import { Cause, Exit, ManagedRuntime, Result } from "effect";
import { readServerOptions, ServerStartupFailed } from "./server-options";
import { ServerRuntime } from "./server-runtime";

const logger = createOpenBotLogger("node-server");

async function main(): Promise<void> {
  const options = readServerOptions(process.argv.slice(2));
  const runtime = ManagedRuntime.make(ServerRuntime.layer(options));
  let stopping = false;
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    shutdownPromise = (async () => {
      try {
        await runtime.dispose();
      } catch {
        logger.error("Node server shutdown failed.");
        process.exitCode = 1;
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        process.removeListener("message", receive);
        process.removeListener("disconnect", stop);
        if (process.connected) process.disconnect?.();
      }
    })();
    return shutdownPromise;
  };
  const stop = () => void shutdown();
  // A Node parent process can stop its own child through the private IPC channel.
  const receive = (message: unknown) => {
    if (message === "shutdown") stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.on("message", receive);
  process.once("disconnect", stop);

  const started = await runtime.runPromiseExit(ServerRuntime);
  if (stopping) return;
  if (Exit.isFailure(started)) {
    const error = Cause.findError(started.cause);
    const code =
      Result.isSuccess(error) && error.success instanceof ServerStartupFailed ? error.success.code : "internal";
    logger.error("Node server startup failed.", { code });
    process.exitCode = 1;
    await shutdown();
    return;
  }
  const ready = { type: "ready", host: "127.0.0.1", ...started.value };
  try {
    await new Promise<void>((resolve, reject) => {
      // Keep this one-shot listener for the process lifetime: stream errors can follow the write callback.
      process.stdout.once("error", reject);
      // Machine-readable: a process supervisor can read the actual bound port.
      process.stdout.write(`${JSON.stringify(ready)}\n`, (error) => (error ? reject(error) : resolve()));
    });
    const send = process.send?.bind(process);
    if (process.connected && send) {
      await new Promise<void>((resolve, reject) => send(ready, (error) => (error ? reject(error) : resolve())));
    }
  } catch {
    logger.error("Node server could not report readiness.");
    process.exitCode = 1;
    await shutdown();
  }
}

void main().catch(() => {
  logger.error("Node server could not start. Use --data-dir <directory> and an optional --port <0-65535>.");
  process.exitCode = 1;
});
