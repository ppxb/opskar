import type { LocalConversationPage, LocalWorkspaceSnapshot } from "@openbot/contracts/server-workspace";

/** The local history view has no account, peer, browser, or execution adapter. */
export interface LocalWorkspaceSource {
  readWorkspace(signal: AbortSignal): Promise<LocalWorkspaceSnapshot>;
  readConversation(agentId: string, before: string | undefined, signal: AbortSignal): Promise<LocalConversationPage>;
}
