import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import {
  type ConsoleError,
  ProviderInput,
  type ProviderState,
  type ProviderTestResult,
  SessionInput,
  type SessionState,
} from "@openbot/contracts/server-console";
import {
  LocalAgentCreateInput,
  type LocalAgentCreateResult,
  LocalConversationInput,
  type LocalConversationPage,
  LocalMessageInput,
  type LocalMessageReceipt,
  LocalStopInput,
  type LocalWorkspaceSnapshot,
} from "@openbot/contracts/server-workspace";
import { Cause, Effect, Exit, Result, Schema } from "effect";
import { acquireServerAgent } from "./server-agent";
import { acquireConsoleAuth, CONSOLE_COOKIE } from "./server-console-auth";
import { ConsoleFailure, consoleError } from "./server-console-error";
import { type ServerOptions, ServerStartupFailed } from "./server-options";
import { acquireProviderConsole } from "./server-provider";
import { acquireLocalWorkspace } from "./server-workspace";

function sessionToken(request: IncomingMessage): string | undefined {
  return request.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${CONSOLE_COOKIE}=`))
    ?.slice(CONSOLE_COOKIE.length + 1);
}

type ConsoleReply =
  | typeof ConsoleError.Type
  | typeof SessionState.Type
  | ProviderState
  | typeof ProviderTestResult.Type
  | LocalWorkspaceSnapshot
  | LocalConversationPage
  | typeof LocalAgentCreateResult.Type
  | typeof LocalMessageReceipt.Type
  | Record<string, never>;

function send(response: ServerResponse, status: number, body: ConsoleReply, cookie?: string): void {
  if (response.destroyed) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(cookie ? { "Set-Cookie": cookie } : {}),
  });
  response.end(JSON.stringify(body));
}

const requestBody = Effect.fn("ConsoleHttp.requestBody")(function* <Value>(
  request: IncomingMessage,
  decode: (value: unknown) => Value,
  maxBytes = 16 * 1024,
) {
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
    return yield* new ConsoleFailure({ code: "invalid" });
  }
  return yield* Effect.tryPromise({
    try: async () => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      // Do not destroy the request when a size error needs an HTTP response.
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > maxBytes) throw new ConsoleFailure({ code: "too-large" });
        chunks.push(buffer);
      }
      return decode(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    },
    catch: (cause) => (cause instanceof ConsoleFailure ? cause : new ConsoleFailure({ code: "invalid" })),
  });
});

/** Local development assets and authenticated API. The listener owns the actual port. */
export const acquireWebConsole = Effect.fn("acquireWebConsole")(function* (options: ServerOptions) {
  const auth = yield* acquireConsoleAuth(options);
  const provider = yield* acquireProviderConsole(auth);
  const execution = yield* acquireServerAgent(options, auth, provider);
  const workspace = yield* acquireLocalWorkspace(auth, execution);
  const services = yield* Effect.context();
  const run = Effect.runPromiseExitWith(services);
  const pending = new Map<Promise<void>, AbortController>();
  const streams = new Map<ServerResponse, (lastEvent?: string) => void>();
  let revision = 0;
  let notification: ReturnType<typeof setTimeout> | undefined;
  const writeChange = (response: ServerResponse) => {
    if (
      !response.destroyed &&
      !response.writableEnded &&
      streams.has(response) &&
      !response.write(`event: change\ndata: ${JSON.stringify({ revision })}\n\n`)
    )
      streams.get(response)?.();
  };
  const unsubscribe = execution.subscribe(() => {
    revision += 1;
    if (notification) return;
    notification = setTimeout(() => {
      notification = undefined;
      for (const response of streams.keys()) writeChange(response);
    }, 50);
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      unsubscribe();
      if (notification) clearTimeout(notification);
      for (const close of streams.values()) close();
    }),
  );
  const stream = (request: IncomingMessage, response: ServerResponse): void => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });
    let closed = false;
    let releaseAuth: (() => void) | undefined;
    const close = (lastEvent?: string) => {
      if (closed) return;
      closed = true;
      streams.delete(response);
      clearInterval(heartbeat);
      releaseAuth?.();
      if (!response.destroyed && !response.writableEnded) response.end(lastEvent);
    };
    const heartbeat = setInterval(() => {
      if (!response.destroyed && !response.writableEnded && !response.write(": alive\n\n")) close();
    }, 15_000);
    heartbeat.unref();
    streams.set(response, close);
    response.once("close", () => close());
    response.once("error", () => close());
    const registered = auth.onSessionEnded(sessionToken(request), () => {
      close("event: session-ended\ndata: {}\n\n");
    });
    if (closed) registered();
    else releaseAuth = registered;
    writeChange(response);
  };
  const vite = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const [{ createServer }, { default: solid }, { default: tailwind }] = await Promise.all([
          import("vite"),
          import("@solidjs/vite-plugin"),
          import("@tailwindcss/vite"),
        ]);
        const root = resolve(import.meta.dirname, "../..");
        const privatePaths = [options.dataDirectory, options.webPasswordFile, options.credentialKeyFile].filter(
          (path) => path !== undefined,
        );
        const deniedPaths: string[] = [];
        for (const path of privatePaths) {
          for (const value of [path, await realpath(path)]) {
            // Vite treats deny entries as globs. Operator paths are literal paths.
            const normalized = value.replaceAll("\\", "/").replace(/([*?{}()[\]!+@])/gu, "\\$1");
            deniedPaths.push(normalized, `${normalized}/**`);
          }
        }
        return await createServer({
          configFile: false,
          envFile: false,
          publicDir: false,
          root: resolve(root, "src/server-web"),
          cacheDir: resolve(
            root,
            "node_modules/.vite-opskar-console",
            createHash("sha256").update(options.dataDirectory).digest("hex").slice(0, 16),
          ),
          logLevel: "silent",
          plugins: [solid(), tailwind({ optimize: false })],
          resolve: { dedupe: ["solid-js", "@solidjs/web", "@solidjs/signals"] },
          server: {
            middlewareMode: true,
            hmr: false,
            ws: false,
            watch: null,
            cors: false,
            fs: {
              strict: true,
              allow: [
                resolve(root, "src/server-web"),
                resolve(root, "src/renderer"),
                resolve(root, "packages"),
                resolve(root, "node_modules"),
              ],
              deny: [
                "**/.env*",
                "**/.git/**",
                "**/.openbot*/**",
                "**/*.key",
                "**/*.pem",
                "**/*.db",
                "**/.env.keys",
                ...deniedPaths,
              ],
            },
          },
        });
      },
      catch: (cause) => new ServerStartupFailed({ code: "web-console", cause }),
    }),
    (vite) =>
      Effect.promise(async () => {
        for (const controller of pending.values()) controller.abort();
        await Promise.all(pending.keys());
        await vite.close();
      }),
  );

  const route = Effect.fn("ConsoleHttp.route")(function* (request: IncomingMessage, response: ServerResponse) {
    const token = sessionToken(request);
    if (request.url === "/api/session") {
      if (request.method === "GET") {
        send(response, 200, { authenticated: auth.authenticated(token) });
        return;
      }
      if (request.method === "POST") {
        const input = yield* requestBody(request, Schema.decodeUnknownSync(SessionInput));
        const cookie = yield* auth.login(input.password, token);
        send(response, 200, { authenticated: true }, cookie);
        return;
      }
      if (request.method === "DELETE") {
        send(response, 200, { authenticated: false }, yield* auth.logout(token));
        return;
      }
    }
    yield* auth.requireSession(token);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/workspace/events" && request.method === "GET") {
      stream(request, response);
      return;
    }
    if (url.pathname === "/api/workspace/agents" && request.method === "POST") {
      const input = yield* requestBody(request, Schema.decodeUnknownSync(LocalAgentCreateInput));
      send(response, 200, yield* execution.createAgent(token, input));
      return;
    }
    const action = /^\/api\/workspace\/agents\/([A-Za-z0-9_-]{1,128})\/(messages|stop)$/u.exec(url.pathname);
    if (action && request.method === "POST") {
      const agentId = action[1] ?? "";
      if (action[2] === "messages") {
        const input = yield* requestBody(request, Schema.decodeUnknownSync(LocalMessageInput), 512 * 1024);
        send(response, 200, yield* execution.sendMessage(token, agentId, input));
      } else {
        const input = yield* requestBody(request, Schema.decodeUnknownSync(LocalStopInput));
        yield* execution.stopAgent(token, agentId, input);
        send(response, 200, {});
      }
      return;
    }
    if (url.pathname === "/api/workspace" && request.method === "GET") {
      if (url.search) return yield* new ConsoleFailure({ code: "workspace-input" });
      send(response, 200, yield* workspace.readWorkspace(token));
      return;
    }
    const conversation = /^\/api\/workspace\/agents\/([^/]+)\/conversation$/u.exec(url.pathname);
    if (conversation && request.method === "GET") {
      if (
        [...url.searchParams.keys()].some((key) => key !== "before") ||
        url.searchParams.getAll("before").length > 1
      ) {
        return yield* new ConsoleFailure({ code: "workspace-input" });
      }
      const input = yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(LocalConversationInput)({
            agentId: decodeURIComponent(conversation[1] ?? ""),
            ...(url.searchParams.has("before") ? { before: url.searchParams.get("before") } : {}),
          }),
        catch: () => new ConsoleFailure({ code: "workspace-input" }),
      });
      send(response, 200, yield* workspace.readConversation(token, input));
      return;
    }
    if (request.url === "/api/provider" && request.method === "GET") {
      send(response, 200, yield* provider.get(token));
    } else if (request.url === "/api/provider" && request.method === "PUT") {
      const input = yield* requestBody(request, Schema.decodeUnknownSync(ProviderInput));
      send(response, 200, yield* execution.saveProvider(token, input));
    } else if (request.url === "/api/provider/test" && request.method === "POST") {
      yield* requestBody(request, Schema.decodeUnknownSync(Schema.Struct({})));
      send(response, 200, yield* provider.test(token));
    } else send(response, 404, { error: "not-found" });
  });

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const port = request.socket.localPort;
    const host = `127.0.0.1:${port}`;
    const origin = `http://${host}`;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    // Vite injects style elements in development. Scripts and API requests remain same-origin.
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const mutation = request.method !== "GET" && request.method !== "HEAD";
    if (
      request.headers.host !== host ||
      (request.headers.origin !== undefined && request.headers.origin !== origin) ||
      (mutation && request.headers.origin !== origin) ||
      request.headers["sec-fetch-site"] === "cross-site"
    ) {
      const error = consoleError(new ConsoleFailure({ code: "forbidden" }));
      send(response, error.status, { error: error.error });
      return;
    }
    let pathname: string;
    try {
      if (!request.url?.startsWith("/") || request.url.startsWith("//")) throw new Error("Invalid request target.");
      pathname = decodeURIComponent(new URL(request.url, origin).pathname).replaceAll("\\", "/");
    } catch {
      const error = consoleError(new ConsoleFailure({ code: "forbidden" }));
      send(response, error.status, { error: error.error });
      return;
    }
    // Vite includes editor-launch and diagnostics endpoints. This console serves assets only.
    if (pathname.startsWith("/__")) {
      send(response, 404, { error: "not-found" });
      return;
    }
    if (!request.url?.startsWith("/api/")) {
      if (mutation) {
        send(response, 405, { error: "method-not-allowed" });
        return;
      }
      vite.middlewares(request, response, () => send(response, 404, { error: "not-found" }));
      return;
    }
    const controller = new AbortController();
    const abort = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.once("close", abort);
    const operation = (async () => {
      try {
        const result = await run(route(request, response), { signal: controller.signal });
        if (Exit.isFailure(result) && !controller.signal.aborted) {
          const error = Cause.findError(result.cause);
          const failure =
            Result.isSuccess(error) && error.success instanceof ConsoleFailure
              ? error.success
              : new ConsoleFailure({ code: "storage" });
          const mapped = consoleError(failure);
          send(response, mapped.status, { error: mapped.error });
        }
      } finally {
        response.removeListener("close", abort);
      }
    })();
    pending.set(operation, controller);
    void operation.then(
      () => pending.delete(operation),
      () => {
        pending.delete(operation);
        response.destroy();
      },
    );
  };
  return { handle };
});
