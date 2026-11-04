import type { ProviderInput } from "@openbot/contracts/server-console";
import { ConsoleError, ProviderState, ProviderTestResult, SessionState } from "@openbot/contracts/server-console";
import {
  LocalAgentCreateResult,
  LocalConversationPage,
  LocalMessageReceipt,
  LocalWorkspaceSnapshot,
} from "@openbot/contracts/server-workspace";
import { sourceText } from "@openbot/i18n/source";
import { Schema } from "effect";
import type { LocalWorkspaceExecution } from "../renderer/src/features/web-client/local-workspace-source";

export class ConsoleRequestFailed extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<Value>(
  path: string,
  signal: AbortSignal,
  decode: (value: unknown) => Value,
  init?: RequestInit,
): Promise<Value> {
  const response = await fetch(path, {
    ...init,
    signal,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
  });
  const data = await response.json();
  if (!response.ok) {
    const failure = Schema.decodeUnknownSync(ConsoleError)(data);
    throw new ConsoleRequestFailed(response.status, failure.error);
  }
  return decode(data);
}

const execution: LocalWorkspaceExecution = {
  createAgent: (input, signal) =>
    request("/api/workspace/agents", signal, Schema.decodeUnknownSync(LocalAgentCreateResult), {
      method: "POST",
      body: JSON.stringify(input),
    }),
  sendMessage: ({ agentId, ...input }, signal) =>
    request(
      `/api/workspace/agents/${encodeURIComponent(agentId)}/messages`,
      signal,
      Schema.decodeUnknownSync(LocalMessageReceipt),
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  async stopAgent({ agentId, turnId }, signal) {
    await request(
      `/api/workspace/agents/${encodeURIComponent(agentId)}/stop`,
      signal,
      Schema.decodeUnknownSync(Schema.Struct({})),
      {
        method: "POST",
        body: JSON.stringify({ turnId }),
      },
    );
  },
  subscribe(onChange, onError) {
    const events = new EventSource("/api/workspace/events");
    const session = new AbortController();
    let checking = false;
    let disposed = false;
    events.addEventListener("change", onChange);
    events.addEventListener("session-ended", () => {
      events.close();
      if (!disposed) onError(new ConsoleRequestFailed(401, sourceText("error.provider.consoleUnauthorized")));
    });
    events.onerror = () => {
      if (checking || disposed) return;
      checking = true;
      void request("/api/session", session.signal, Schema.decodeUnknownSync(SessionState))
        .then((state) => {
          if (disposed) return;
          if (!state.authenticated) {
            events.close();
            onError(new ConsoleRequestFailed(401, sourceText("error.provider.consoleUnauthorized")));
          } else if (events.readyState !== EventSource.OPEN)
            onError(new Error(sourceText("error.host.agentUpdatesDisconnected")));
        })
        .catch((error) => {
          if (!disposed && events.readyState !== EventSource.OPEN) onError(error);
        })
        .finally(() => {
          checking = false;
        });
    };
    return () => {
      disposed = true;
      session.abort();
      events.close();
    };
  },
};

export const consoleApi = {
  execution,
  async readWorkspace(signal: AbortSignal) {
    return request("/api/workspace", signal, Schema.decodeUnknownSync(LocalWorkspaceSnapshot));
  },
  async readConversation(agentId: string, before: string | undefined, signal: AbortSignal) {
    const query = before ? `?${new URLSearchParams({ before })}` : "";
    return request(
      `/api/workspace/agents/${encodeURIComponent(agentId)}/conversation${query}`,
      signal,
      Schema.decodeUnknownSync(LocalConversationPage),
    );
  },
  async session(signal: AbortSignal) {
    return request("/api/session", signal, Schema.decodeUnknownSync(SessionState));
  },
  async login(password: string, signal: AbortSignal) {
    return request("/api/session", signal, Schema.decodeUnknownSync(SessionState), {
      method: "POST",
      body: JSON.stringify({ password }),
    });
  },
  async logout(signal: AbortSignal) {
    return request("/api/session", signal, Schema.decodeUnknownSync(SessionState), { method: "DELETE" });
  },
  async provider(signal: AbortSignal) {
    return request("/api/provider", signal, Schema.decodeUnknownSync(ProviderState));
  },
  async save(input: ProviderInput, signal: AbortSignal) {
    return request("/api/provider", signal, Schema.decodeUnknownSync(ProviderState), {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
  async test(signal: AbortSignal) {
    return request("/api/provider/test", signal, Schema.decodeUnknownSync(ProviderTestResult), {
      method: "POST",
      body: "{}",
    });
  },
};
