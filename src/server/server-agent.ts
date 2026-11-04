import { join } from "node:path";
import { AGENT_PROVIDERS, type AgentSummary, isAgentModel } from "@openbot/contracts/ipc";
import type { ProviderInput } from "@openbot/contracts/server-console";
import type {
  LocalAgentCreateInput,
  LocalExecutionState,
  LocalMessageInput,
  LocalStopInput,
} from "@openbot/contracts/server-workspace";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger, redactText } from "@openbot/logging";
import { Effect, Result, Semaphore } from "effect";
import { type AgentLifecycleFailed, AgentService } from "../backend/agent-service";
import type { ConsoleAuth } from "./server-console-auth";
import { ConsoleFailure } from "./server-console-error";
import { acquireServerOpenCode } from "./server-opencode";
import type { ServerOptions } from "./server-options";
import { LOCAL_PROVIDER_ID, type ServerProviderConsole } from "./server-provider";
import { ServerStorage } from "./server-storage";

const logger = createOpenBotLogger("server-agent");

/** One real AgentService, with the same durable mailbox as the read API. */
export const acquireServerAgent = Effect.fn("acquireServerAgent")(function* (
  options: ServerOptions,
  auth: ConsoleAuth,
  provider: ServerProviderConsole,
) {
  const storage = yield* ServerStorage;
  const runtime = options.execute ? yield* acquireServerOpenCode(options) : null;
  const commands = Semaphore.makeUnsafe(1);
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  let service: AgentService | null = null;
  let serviceInitialized = false;
  let phase: LocalExecutionState["state"] = runtime ? "unconfigured" : "disabled";
  let failure: string | null = null;
  const selectedModel = () => {
    const profile = provider.configuration();
    const model = profile?.models[0]?.id;
    return model ? `${LOCAL_PROVIDER_ID}/${model}` : null;
  };
  const state = (): LocalExecutionState => {
    const model = selectedModel();
    const available =
      service?.getStatus().providers?.some((entry) => entry.id === "opencode" && entry.state === "available") &&
      service?.listModels().some((entry) => entry.provider === "opencode" && entry.id === model);
    const currentPhase = serviceInitialized ? (available ? "ready" : "error") : phase;
    return {
      state: currentPhase,
      message:
        currentPhase === "ready"
          ? null
          : serviceInitialized && !available
            ? sourceText("error.host.agentStartFailed")
            : failure,
      model: runtime && model ? redactText(model) : null,
    };
  };
  const mapFailure = (error: AgentLifecycleFailed): ConsoleFailure => {
    logger.error("Agent operation failed.", { operation: error.operation });
    return new ConsoleFailure({ code: "agent-operation" });
  };
  const close = Effect.fn("ServerAgent.close")(function* () {
    const current = service;
    service = null;
    serviceInitialized = false;
    if (current) {
      phase = "starting";
      failure = null;
      changed();
      yield* current.stop().pipe(Effect.mapError(mapFailure));
      current.removeAllListeners();
    }
  });
  yield* Effect.addFinalizer(() => commands.withPermit(close()).pipe(Effect.orDie));
  const start = Effect.fn("ServerAgent.start")(function* () {
    if (!runtime) return;
    const model = selectedModel();
    if (!model) {
      phase = "unconfigured";
      failure = null;
      changed();
      return;
    }
    if (!isAgentModel(model)) {
      phase = "error";
      failure = sourceText("error.host.agentModelInvalid");
      changed();
      return;
    }
    phase = "starting";
    failure = null;
    changed();
    // Apply the single endpoint's selected model before recovery can drain queued user work.
    for (const agent of storage.agents.list()) {
      if (agent.provider === "opencode" && agent.model.startsWith(`${LOCAL_PROVIDER_ID}/`) && agent.model !== model) {
        yield* storage.agents
          .updateAgent({ agentId: agent.id, model })
          .pipe(Effect.mapError(() => new ConsoleFailure({ code: "agent-operation" })));
      }
    }
    const current = new AgentService({
      store: storage.agents,
      mailbox: storage.mailbox,
      browser: null,
      automation: "disabled",
      interactivePrompts: false,
      fixedExecutables: { opencode: runtime.executable },
      preferredProvider: "opencode",
      preferredModel: model,
      offProviders: AGENT_PROVIDERS.filter((id) => id !== "opencode"),
      memoryReviewInterval: () => 0,
      credentials: {
        apiKey: () => null,
        customProviders: () => {
          const profile = provider.configuration();
          return profile ? [profile] : [];
        },
        mcpServers: () => [],
        providerStateDirectory: join(runtime.root, "launch-state"),
        providerTempDirectory: join(runtime.root, "temp"),
        agentEnvironment: () => runtime.environment,
      },
      approvalAutomation: {
        autoApproves: (id) =>
          storage.agents.list().some((agent) => agent.id === id && (agent.access ?? "full") === "full"),
      },
    });
    service = current;
    current.on("event", changed);
    const initialized = yield* Effect.result(current.initialize({ storesAlreadyInitialized: true }));
    if (initialized._tag === "Failure") {
      logger.error("Agent initialization failed.", { operation: initialized.failure.operation });
      phase = "error";
      failure = sourceText("error.host.agentStartFailed");
      changed();
      return;
    }
    serviceInitialized = true;
    const usable = current
      .getStatus()
      .providers?.some((entry) => entry.id === "opencode" && entry.state === "available");
    if (!usable || !current.listModels().some((entry) => entry.provider === "opencode" && entry.id === model)) {
      phase = "error";
      failure = sourceText("error.host.agentStartFailed");
      changed();
      return;
    }
    phase = "ready";
    changed();
  });
  yield* start();

  const requireReady = Effect.fn("ServerAgent.requireReady")(function* (token: string | undefined) {
    yield* auth.requireSession(token);
    if (!service || state().state !== "ready") return yield* new ConsoleFailure({ code: "agent-unavailable" });
    return service;
  });
  const requireAgent = (id: string): AgentSummary => {
    const agent = storage.agents.list().find((entry) => entry.id === id);
    if (!agent) throw new ConsoleFailure({ code: "workspace-agent" });
    if (agent.provider !== "opencode" || agent.model !== selectedModel())
      throw new ConsoleFailure({ code: "agent-model" });
    if ((agent.access ?? "full") !== "full") throw new ConsoleFailure({ code: "agent-access" });
    return agent;
  };
  const createAgent = Effect.fn("ServerAgent.create")(function* (
    token: string | undefined,
    input: LocalAgentCreateInput,
  ) {
    return yield* commands.withPermit(
      Effect.gen(function* () {
        const current = yield* requireReady(token);
        const model = selectedModel();
        if (!model) return yield* new ConsoleFailure({ code: "agent-unavailable" });
        const agent = yield* current
          .createAgentProfile({ ...input, provider: "opencode", model })
          .pipe(Effect.mapError(mapFailure));
        changed();
        return { agentId: agent.id };
      }),
    );
  });
  const sendMessage = Effect.fn("ServerAgent.send")(function* (
    token: string | undefined,
    agentId: string,
    input: LocalMessageInput,
  ) {
    return yield* commands.withPermit(
      Effect.gen(function* () {
        const current = yield* requireReady(token);
        yield* Effect.try({
          try: () => requireAgent(agentId),
          catch: (cause) => (cause instanceof ConsoleFailure ? cause : new ConsoleFailure({ code: "agent-operation" })),
        });
        const receipt = yield* current
          .sendMessage({ agentId, text: input.text, clientMessageId: input.clientMessageId, attachmentDraftIds: [] })
          .pipe(Effect.mapError(mapFailure));
        changed();
        return { messageId: receipt.messageId };
      }),
    );
  });
  const stopAgent = Effect.fn("ServerAgent.stop")(function* (
    token: string | undefined,
    agentId: string,
    input: LocalStopInput,
  ) {
    yield* auth.requireSession(token);
    const current = service;
    if (!current) return yield* new ConsoleFailure({ code: "agent-unavailable" });
    yield* Effect.try({
      try: () => requireAgent(agentId),
      catch: (cause) => (cause instanceof ConsoleFailure ? cause : new ConsoleFailure({ code: "agent-operation" })),
    });
    yield* current.interrupt(agentId, input.turnId).pipe(Effect.mapError(mapFailure));
    changed();
  });
  const saveProvider = Effect.fn("ServerAgent.saveProvider")(function* (
    token: string | undefined,
    input: ProviderInput,
  ) {
    return yield* commands.withPermit(
      Effect.gen(function* () {
        yield* auth.requireSession(token);
        if (runtime && !isAgentModel(`${LOCAL_PROVIDER_ID}/${input.model.trim()}`))
          return yield* new ConsoleFailure({ code: "agent-model" });
        const activity = service?.getRuntimeSnapshot();
        if (
          runtime &&
          state().state === "ready" &&
          (activity?.activeTurns.length ||
            activity?.work.some((work) => work.status === "starting" || work.status === "running"))
        ) {
          return yield* new ConsoleFailure({ code: "agent-busy" });
        }
        // Stop the drain before changing configuration. Queued work stays in the mailbox.
        // A failed write leaves the previous profile, which the same start operation restores.
        if (runtime) yield* close();
        const saved = yield* Effect.result(provider.save(token, input));
        if (runtime) yield* start();
        changed();
        if (Result.isFailure(saved)) return yield* saved.failure;
        return saved.success;
      }).pipe(Effect.uninterruptible),
    );
  });
  return {
    enabled: Boolean(runtime),
    state,
    createAgent,
    sendMessage,
    stopAgent,
    saveProvider,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

export type ServerAgentControl = Effect.Success<ReturnType<typeof acquireServerAgent>>;
