import type { ConversationMessage } from "@openbot/contracts/ipc";
import { Button, Text } from "@openbot/ui";
import type { AgentMessage } from "@openbot/ui/data";
import { ChatActionMarker } from "@openbot/ui/features/conversation/ChatActionMarker";
import { ChatMessageRow } from "@openbot/ui/features/conversation/ChatMessageRow";
import { TaskList } from "@openbot/ui/features/conversation/TaskList";
import { useText } from "@openbot/ui/text";
import { createMemo, createProjection, For, Show } from "solid-js";
import { planItems, planTitle, toAgentMessage } from "../../app-message-projection";
import type { createLocalWorkspace } from "./local-workspace-context";

/** Only the active turn can stream; a saved snapshot never loads desktop attachment URLs. */
function historyMessage(message: ConversationMessage, agentId: string, activeTurnId?: string | null): AgentMessage {
  const row = toAgentMessage(message, agentId);
  return {
    ...row,
    streaming: Boolean(activeTurnId && row.turnId === activeTurnId && row.streaming),
    attachments: row.attachments?.map((attachment) => ({ ...attachment, previewUrl: null })),
  };
}

export function LocalWorkspaceHistory(props: { workspace: ReturnType<typeof createLocalWorkspace> }) {
  const { t } = useText();
  const rows = createProjection<AgentMessage[]>(
    () =>
      props.workspace.state.page?.messages.map((message) =>
        historyMessage(
          message,
          props.workspace.state.page?.agentId ?? "",
          props.workspace.selectedExecutionReady() ? props.workspace.state.page?.activeTurnId : null,
        ),
      ) ?? [],
    [],
    { key: "id" },
  );
  const references = createMemo(() => {
    const page = props.workspace.state.page;
    return new Map(
      Object.entries(page?.references ?? {}).map(([id, message]) => [id, historyMessage(message, page?.agentId ?? "")]),
    );
  });
  function openLink(value: string): void {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" || url.protocol === "http:") window.open(url.href, "_blank", "noopener,noreferrer");
    } catch {
      // Local file and application schemes have no action in this reader.
    }
  }
  return (
    <div class="conversation-scroll local-workspace-history" ref={props.workspace.bindScroll}>
      <Show when={props.workspace.state.loadingHistory}>
        <Text as="p" class="conversation-history-status" role="status">
          {t("common.loading")}
        </Text>
      </Show>
      <Show when={props.workspace.state.historyError}>
        <div class="conversation-history-status" role="alert">
          <Text>{props.workspace.state.historyError}</Text>
          <Button
            variant="ghost"
            onClick={() => {
              if (props.workspace.state.page) void props.workspace.older();
              else if (props.workspace.state.selectedId) void props.workspace.select(props.workspace.state.selectedId);
            }}
          >
            {t("common.retry")}
          </Button>
        </div>
      </Show>
      <Show when={props.workspace.state.page?.pageInfo.hasOlder}>
        <div class="conversation-history-status">
          <Button
            variant="ghost"
            disabled={props.workspace.state.loadingOlder}
            onClick={() => void props.workspace.older()}
          >
            {t("settings.workspace.loadEarlier")}
          </Button>
        </div>
      </Show>
      <Show when={!props.workspace.state.loadingHistory && props.workspace.state.page && rows.length === 0}>
        <Text as="p" class="local-workspace-empty" role="status">
          {t("settings.workspace.noMessages")}
        </Text>
      </Show>
      <div class="virtual-chat-list virtual-chat-list-static">
        <For each={rows}>
          {(message) => (
            <div class="virtual-chat-row">
              <Show
                when={message.actionMarker}
                fallback={
                  <Show
                    when={message.plan}
                    fallback={
                      <ChatMessageRow
                        message={message}
                        author={
                          message.author === "you"
                            ? { kind: "you", name: "" }
                            : {
                                kind: "agent",
                                name: props.workspace.selected()?.name ?? "",
                                agent: props.workspace.selected(),
                              }
                        }
                        agents={props.workspace.profiles()}
                        animate={false}
                        imagesAsLinks
                        linkFavicons={false}
                        referencedMessage={
                          message.replyToMessageId
                            ? (references().get(message.replyToMessageId) ??
                              rows.find((row) => row.id === message.replyToMessageId))
                            : undefined
                        }
                        onSelectAgent={(id) => void props.workspace.select(id)}
                        onOpenLink={openLink}
                      />
                    }
                  >
                    {(plan) => (
                      <TaskList items={planItems(plan(), message.streaming === true)} title={planTitle(plan())} />
                    )}
                  </Show>
                }
              >
                {(marker) => (
                  <ChatActionMarker
                    marker={marker()}
                    agents={props.workspace.profiles()}
                    announce={false}
                    onSelectAgent={(id) => void props.workspace.select(id)}
                  />
                )}
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
