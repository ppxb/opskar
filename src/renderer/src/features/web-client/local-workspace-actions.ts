import { useText } from "@openbot/ui/text";
import { createStore, onSettled } from "solid-js";
import type { createLocalWorkspace } from "./local-workspace-context";
import type { LocalAgentDraft, LocalWorkspaceSource } from "./local-workspace-source";

interface MessageDraft {
  text: string;
  pending: { text: string; clientMessageId: string } | null;
  sending: boolean;
  stopping: boolean;
  error: string | null;
}

const emptyDraft = (): MessageDraft => ({ text: "", pending: null, sending: false, stopping: false, error: null });
const EMPTY_DRAFT = emptyDraft();

/** Drafts remain local to this view; a failed send keeps both text and its idempotency key. */
export function createLocalWorkspaceActions(options: {
  source: LocalWorkspaceSource;
  workspace: ReturnType<typeof createLocalWorkspace>;
  onError: (error: unknown) => void;
}) {
  const { t, errorMessage } = useText();
  const [state, setState] = createStore<{
    drafts: Record<string, MessageDraft>;
    creating: boolean;
    createError: string | null;
  }>({ drafts: {}, creating: false, createError: null });
  const sending = new Map<string, AbortController>();
  const stopping = new Map<string, AbortController>();
  let creation: AbortController | null = null;
  let disposed = false;
  const current = () => state.drafts[options.workspace.state.selectedId ?? ""] ?? EMPTY_DRAFT;

  function changeText(text: string): void {
    const agentId = options.workspace.state.selectedId;
    if (!agentId || sending.has(agentId)) return;
    setState((draft) => {
      draft.drafts[agentId] ??= emptyDraft();
      const message = draft.drafts[agentId];
      message.text = text;
      message.error = null;
    });
  }

  async function createAgent(input: LocalAgentDraft): Promise<boolean> {
    const execution = options.source.execution;
    if (!execution || !options.workspace.executionReady() || creation) return false;
    const request = new AbortController();
    creation = request;
    setState((draft) => {
      draft.creating = true;
      draft.createError = null;
    });
    try {
      const result = await execution.createAgent(input, request.signal);
      if (disposed) return false;
      await options.workspace.refresh();
      if (disposed) return false;
      await options.workspace.select(result.agentId);
      return true;
    } catch (error) {
      if (disposed || request.signal.aborted) return false;
      options.onError(error);
      if (disposed) return false;
      setState((draft) => {
        draft.createError = `${errorMessage(error, t("settings.workspace.createFailed"))} ${t("settings.workspace.checkCreatedAgent")}`;
      });
      // Creation has no retry key in this version. Read the list so the user can check it before retrying.
      await options.workspace.refresh();
      return false;
    } finally {
      creation = null;
      if (!disposed)
        setState((draft) => {
          draft.creating = false;
        });
    }
  }

  async function sendMessage(): Promise<void> {
    const execution = options.source.execution;
    const agentId = options.workspace.state.selectedId;
    if (
      !execution ||
      !options.workspace.selectedExecutionReady() ||
      !agentId ||
      sending.has(agentId) ||
      stopping.has(agentId)
    )
      return;
    const previous = state.drafts[agentId];
    if (!previous?.text.trim()) return;
    const retry = previous.pending?.text === previous.text ? previous.pending : null;
    if (options.workspace.state.page?.activeTurnId && !retry) return;
    const pending = { text: previous.text, clientMessageId: retry?.clientMessageId ?? crypto.randomUUID() };
    const request = new AbortController();
    sending.set(agentId, request);
    setState((draft) => {
      draft.drafts[agentId] ??= emptyDraft();
      const message = draft.drafts[agentId];
      message.pending = pending;
      message.sending = true;
      message.error = null;
    });
    try {
      await execution.sendMessage({ agentId, ...pending }, request.signal);
      if (disposed) return;
      setState((draft) => {
        const message = draft.drafts[agentId];
        if (!message) return;
        if (message.text === pending.text) message.text = "";
        message.pending = null;
        message.error = null;
      });
      options.workspace.invalidate();
    } catch (error) {
      if (disposed || request.signal.aborted) return;
      options.onError(error);
      if (disposed) return;
      setState((draft) => {
        const message = draft.drafts[agentId];
        if (message) message.error = errorMessage(error, t("settings.workspace.sendFailed"));
      });
    } finally {
      sending.delete(agentId);
      if (!disposed)
        setState((draft) => {
          const message = draft.drafts[agentId];
          if (message) message.sending = false;
        });
    }
  }

  async function stopAgent(): Promise<void> {
    const execution = options.source.execution;
    const agentId = options.workspace.state.selectedId;
    const turnId = options.workspace.state.page?.activeTurnId;
    if (
      !execution ||
      !options.workspace.interactive() ||
      !options.workspace.selectedAgentSupported() ||
      !agentId ||
      !turnId ||
      stopping.has(agentId) ||
      sending.has(agentId)
    )
      return;
    const request = new AbortController();
    stopping.set(agentId, request);
    setState((draft) => {
      draft.drafts[agentId] ??= emptyDraft();
      const message = draft.drafts[agentId];
      message.stopping = true;
      message.error = null;
    });
    try {
      await execution.stopAgent({ agentId, turnId }, request.signal);
      if (!disposed) options.workspace.invalidate();
    } catch (error) {
      if (disposed || request.signal.aborted) return;
      options.onError(error);
      if (disposed) return;
      setState((draft) => {
        const message = draft.drafts[agentId];
        if (message) message.error = errorMessage(error, t("settings.workspace.stopFailed"));
      });
    } finally {
      stopping.delete(agentId);
      if (!disposed)
        setState((draft) => {
          const message = draft.drafts[agentId];
          if (message) message.stopping = false;
        });
    }
  }

  function dismissError(): void {
    const agentId = options.workspace.state.selectedId;
    if (agentId)
      setState((draft) => {
        const message = draft.drafts[agentId];
        if (message) message.error = null;
      });
  }

  function clearCreateError(): void {
    setState((draft) => {
      draft.createError = null;
    });
  }

  onSettled(() => () => {
    disposed = true;
    creation?.abort();
    for (const request of sending.values()) request.abort();
    for (const request of stopping.values()) request.abort();
  });

  return { state, current, changeText, createAgent, sendMessage, stopAgent, dismissError, clearCreateError };
}
