import type { LocalConversationPage, LocalWorkspaceSnapshot } from "@openbot/contracts/server-workspace";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createStore, onSettled } from "solid-js";
import { toAgentProfile } from "../../app-message-projection";
import { mergeConversationPage } from "../conversation/conversation-merge";
import type { LocalWorkspaceSource } from "./local-workspace-source";

interface LocalWorkspaceState {
  snapshot: LocalWorkspaceSnapshot | null;
  selectedId: string | null;
  page: LocalConversationPage | null;
  loading: boolean;
  loadingHistory: boolean;
  loadingOlder: boolean;
  error: string | null;
  historyError: string | null;
  updatesError: string | null;
}

const selectionKey = (workspaceId: string) => `opskar.local-workspace:${workspaceId}:selected-agent`;

function readSelection(workspaceId: string): string | null {
  try {
    return sessionStorage.getItem(selectionKey(workspaceId));
  } catch {
    return null;
  }
}

/** Stores only the selected id. Message text stays in memory until this view closes. */
function saveSelection(workspaceId: string, agentId: string): void {
  try {
    sessionStorage.setItem(selectionKey(workspaceId), agentId);
  } catch {
    // Selection still works when browser storage is unavailable.
  }
}

export function createLocalWorkspace(options: { source: LocalWorkspaceSource; onError: (error: unknown) => void }) {
  const { t, errorMessage } = useText();
  const [state, setState] = createStore<LocalWorkspaceState>({
    snapshot: null,
    selectedId: null,
    page: null,
    loading: true,
    loadingHistory: false,
    loadingOlder: false,
    error: null,
    historyError: null,
    updatesError: null,
  });
  let disposed = false;
  let workspaceRequest: AbortController | null = null;
  let historyRequest: AbortController | null = null;
  let scrollElement: HTMLDivElement | undefined;
  let scrollFrame: number | undefined;
  let historyGeneration = 0;
  let updateRequested = false;
  let updateRequest: AbortController | null = null;
  const profiles = createMemo(
    () => state.snapshot?.agents.map((agent) => toAgentProfile({ ...agent, avatarUrl: null })) ?? [],
  );
  const selected = createMemo(() => profiles().find((agent) => agent.id === state.selectedId));
  const interactive = () => state.snapshot?.mode === "interactive" && options.source.execution !== undefined;
  const executionReady = () => interactive() && state.snapshot?.execution.state === "ready";
  const selectedAgentSupported = () => {
    const agent = selected();
    const model = state.snapshot?.execution.model;
    return Boolean(
      agent && model && agent.provider === "opencode" && agent.model === model && (agent.access ?? "full") === "full",
    );
  };
  const selectedExecutionReady = () => executionReady() && selectedAgentSupported();
  const selectedExecutionIssue = () => {
    const agent = selected();
    const model = state.snapshot?.execution.model;
    if (executionReady() && agent && (agent.access ?? "full") !== "full") return t("error.host.agentAccessUnavailable");
    return executionReady() && agent && model && !selectedAgentSupported()
      ? t("settings.workspace.agentModelUnavailable", {
          provider: agent.provider,
          model: agent.model,
          available: model,
        })
      : null;
  };

  /** One read at a time. A second event records one more read instead of replacing the active one. */
  async function syncUpdates(): Promise<void> {
    if (disposed || updateRequest || workspaceRequest || historyRequest || !updateRequested) return;
    updateRequested = false;
    const request = new AbortController();
    updateRequest = request;
    const currentHistory = historyGeneration;
    const agentId = state.selectedId;
    try {
      const snapshot = await options.source.readWorkspace(request.signal);
      if (disposed || request.signal.aborted) return;
      setState((draft) => {
        draft.snapshot = snapshot;
        draft.updatesError = null;
      });
      if (!agentId || !snapshot.agents.some((agent) => agent.id === agentId)) return;
      const page = await options.source.readConversation(agentId, undefined, request.signal);
      if (disposed || request.signal.aborted || historyGeneration !== currentHistory) return;
      const current = state.page;
      const sameThread = current?.agentId === page.agentId && current.threadId === page.threadId;
      const previousIds = new Set(current?.messages.map((message) => message.id));
      // A long disconnection can leave a gap. Show the new page instead of joining disjoint history.
      const continuous =
        sameThread && (current.messages.length === 0 || page.messages.some((message) => previousIds.has(message.id)));
      const stayAtLatest =
        !scrollElement || scrollElement.scrollHeight - scrollElement.clientHeight - scrollElement.scrollTop < 48;
      setState((draft) => {
        draft.page =
          continuous && current
            ? {
                ...page,
                messages: mergeConversationPage(current.messages, page.messages, "latest"),
                references: { ...current.references, ...page.references },
                pageInfo: current.pageInfo,
              }
            : page;
      });
      if (stayAtLatest) {
        if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
        scrollFrame = requestAnimationFrame(() => {
          scrollFrame = undefined;
          if (!disposed && historyGeneration === currentHistory && scrollElement)
            scrollElement.scrollTop = scrollElement.scrollHeight;
        });
      }
    } catch (error) {
      if (disposed || request.signal.aborted) return;
      options.onError(error);
      if (disposed) return;
      setState((draft) => {
        draft.updatesError = errorMessage(error, t("settings.workspace.updatesFailed"));
      });
    } finally {
      if (updateRequest === request) updateRequest = null;
      if (!disposed && updateRequested) queueMicrotask(() => void syncUpdates());
    }
  }

  function invalidate(): void {
    if (disposed) return;
    updateRequested = true;
    queueMicrotask(() => void syncUpdates());
  }

  async function readHistory(agentId: string, before?: string): Promise<void> {
    const currentHistory = ++historyGeneration;
    historyRequest?.abort();
    const request = new AbortController();
    historyRequest = request;
    const height = scrollElement?.scrollHeight ?? 0;
    const top = scrollElement?.scrollTop ?? 0;
    setState((draft) => {
      draft.selectedId = agentId;
      draft.loadingHistory = before === undefined;
      draft.loadingOlder = before !== undefined;
      draft.historyError = null;
      if (before === undefined) draft.page = null;
    });
    try {
      const page = await options.source.readConversation(agentId, before, request.signal);
      if (disposed || request.signal.aborted || historyRequest !== request) return;
      setState((draft) => {
        const previous = draft.page;
        draft.page =
          before && previous?.agentId === agentId && previous.threadId === page.threadId
            ? {
                ...page,
                messages: mergeConversationPage(previous.messages, page.messages, "older"),
                references: { ...previous.references, ...page.references },
              }
            : page;
      });
      if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = undefined;
        if (disposed || currentHistory !== historyGeneration || !scrollElement) return;
        scrollElement.scrollTop = before ? top + scrollElement.scrollHeight - height : scrollElement.scrollHeight;
      });
    } catch (error) {
      if (disposed || request.signal.aborted || historyRequest !== request) return;
      options.onError(error);
      if (disposed) return;
      setState((draft) => {
        draft.historyError = errorMessage(error, t("settings.workspace.historyFailed"));
      });
    } finally {
      if (!disposed && historyRequest === request) {
        historyRequest = null;
        setState((draft) => {
          draft.loadingHistory = false;
          draft.loadingOlder = false;
        });
        if (updateRequested) queueMicrotask(() => void syncUpdates());
      }
    }
  }

  async function select(agentId: string): Promise<void> {
    const snapshot = state.snapshot;
    if (!snapshot?.agents.some((agent) => agent.id === agentId)) return;
    saveSelection(snapshot.workspaceId, agentId);
    await readHistory(agentId);
  }

  async function refresh(): Promise<void> {
    updateRequest?.abort();
    workspaceRequest?.abort();
    historyRequest?.abort();
    const request = new AbortController();
    workspaceRequest = request;
    setState((draft) => {
      draft.loading = true;
      draft.error = null;
    });
    try {
      const snapshot = await options.source.readWorkspace(request.signal);
      if (disposed || request.signal.aborted || workspaceRequest !== request) return;
      const wanted = state.selectedId ?? readSelection(snapshot.workspaceId);
      const agent = snapshot.agents.find((candidate) => candidate.id === wanted) ?? snapshot.agents[0];
      setState((draft) => {
        draft.snapshot = snapshot;
        if (!agent) {
          draft.selectedId = null;
          draft.page = null;
          draft.historyError = null;
          draft.loadingHistory = false;
          draft.loadingOlder = false;
        }
      });
      if (agent) {
        saveSelection(snapshot.workspaceId, agent.id);
        await readHistory(agent.id);
      }
    } catch (error) {
      if (disposed || request.signal.aborted || workspaceRequest !== request) return;
      options.onError(error);
      if (disposed) return;
      setState((draft) => {
        draft.error = errorMessage(error, t("settings.workspace.loadFailed"));
      });
    } finally {
      if (!disposed && workspaceRequest === request) {
        workspaceRequest = null;
        setState((draft) => {
          draft.loading = false;
        });
        if (updateRequested) queueMicrotask(() => void syncUpdates());
      }
    }
  }

  async function older(): Promise<void> {
    const page = state.page;
    if (!page?.pageInfo.hasOlder || !page.pageInfo.olderCursor || state.loadingHistory || state.loadingOlder) return;
    await readHistory(page.agentId, page.pageInfo.olderCursor);
  }

  createEffect(
    () => interactive(),
    (enabled) => {
      const execution = options.source.execution;
      if (!enabled || !execution) return;
      return execution.subscribe(invalidate, (error) => {
        if (disposed) return;
        options.onError(error);
        if (!disposed)
          setState((draft) => {
            draft.updatesError = t("settings.workspace.updatesFailed");
          });
      });
    },
  );

  onSettled(() => {
    void refresh();
    return () => {
      disposed = true;
      workspaceRequest?.abort();
      historyRequest?.abort();
      updateRequest?.abort();
      if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
    };
  });

  return {
    state,
    profiles,
    selected,
    select,
    refresh,
    older,
    invalidate,
    interactive,
    executionReady,
    selectedAgentSupported,
    selectedExecutionReady,
    selectedExecutionIssue,
    bindScroll: (element: HTMLDivElement) => {
      scrollElement = element;
    },
  };
}
