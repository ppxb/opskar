import type { AvatarHue } from "@openbot/contracts/ipc";
import type { LocalConversationPage, LocalWorkspaceSnapshot } from "@openbot/contracts/server-workspace";

export interface LocalAgentDraft {
  name: string;
  description: string;
  avatarSeed: string;
  avatarHue: AvatarHue | null;
}

/** Execution is available only on a host that the operator starts with --execute. */
export interface LocalWorkspaceExecution {
  createAgent(input: LocalAgentDraft, signal: AbortSignal): Promise<{ agentId: string }>;
  sendMessage(
    input: { agentId: string; text: string; clientMessageId: string },
    signal: AbortSignal,
  ): Promise<{ messageId: string }>;
  stopAgent(input: { agentId: string; turnId: string }, signal: AbortSignal): Promise<void>;
  subscribe(onChange: () => void, onError: (error: unknown) => void): () => void;
}

/** Local HTTP operations; no cloud account, peer, or desktop bridge is required. */
export interface LocalWorkspaceSource {
  readWorkspace(signal: AbortSignal): Promise<LocalWorkspaceSnapshot>;
  readConversation(agentId: string, before: string | undefined, signal: AbortSignal): Promise<LocalConversationPage>;
  execution?: LocalWorkspaceExecution | undefined;
}
