import type { ProviderInput } from "@openbot/contracts/server-console";
import { ConsoleError, ProviderState, ProviderTestResult, SessionState } from "@openbot/contracts/server-console";
import { LocalConversationPage, LocalWorkspaceSnapshot } from "@openbot/contracts/server-workspace";
import { Schema } from "effect";

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

export const consoleApi = {
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
