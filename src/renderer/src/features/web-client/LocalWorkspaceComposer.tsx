import { Button, Text } from "@openbot/ui";
import { ComposerEditor } from "@openbot/ui/features/conversation/ComposerEditor";
import { ComposerErrorBanner } from "@openbot/ui/features/conversation/ComposerErrorBanner";
import { ComposerNotice } from "@openbot/ui/features/conversation/ComposerNotice";
import { ComposerSendControl } from "@openbot/ui/features/conversation/ComposerSendControl";
import { useText } from "@openbot/ui/text";
import { Show } from "solid-js";
import type { createLocalWorkspaceActions } from "./local-workspace-actions";
import type { createLocalWorkspace } from "./local-workspace-context";

export function LocalWorkspaceComposer(props: {
  workspace: ReturnType<typeof createLocalWorkspace>;
  actions: ReturnType<typeof createLocalWorkspaceActions>;
}) {
  const { t } = useText();
  const busy = () => props.actions.current().sending || props.actions.current().stopping;
  const running = () => props.workspace.selectedAgentSupported() && Boolean(props.workspace.state.page?.activeTurnId);
  const ready = () =>
    props.workspace.selectedExecutionReady() &&
    !props.workspace.state.loadingHistory &&
    props.workspace.state.page !== null;
  return (
    <div class="composer-wrap local-workspace-composer">
      <div class="composer-stack">
        <Show when={props.workspace.selectedExecutionIssue()}>
          {(message) => <ComposerNotice tone="warning" body={message()} />}
        </Show>
        <Show when={props.actions.current().error}>
          {(error) => (
            <ComposerErrorBanner
              message={error()}
              conversationKey={props.workspace.state.selectedId}
              onDismiss={props.actions.dismissError}
              action={
                props.actions.current().pending && props.actions.current().text ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!ready() || busy()}
                    onClick={() => void props.actions.sendMessage()}
                  >
                    {t("common.retry")}
                  </Button>
                ) : undefined
              }
            />
          )}
        </Show>
        <div class="composer">
          <div class="composer-input-label">
            <ComposerEditor
              agentId={props.workspace.state.selectedId ?? undefined}
              agents={[]}
              value={props.actions.current().text}
              placeholder={t("settings.workspace.messagePlaceholder")}
              ariaLabel={t("settings.workspace.message")}
              disabled={!ready() || props.actions.current().sending}
              onValueChange={props.actions.changeText}
              onSubmit={() => void props.actions.sendMessage()}
            />
          </div>
          <div class="composer-toolbar">
            <Text variant="caption" tone="secondary" role="status">
              {running() ? t("settings.workspace.agentRunning") : t("settings.workspace.textOnly")}
            </Text>
            <div class="composer-primary-actions">
              <ComposerSendControl
                stop={running()}
                onStop={() => void props.actions.stopAgent()}
                label={t("settings.workspace.send")}
                disabled={!ready() || busy() || !props.actions.current().text.trim()}
                stopDisabled={busy() || !props.workspace.selectedExecutionReady()}
                busy={props.actions.current().sending}
                onSend={() => void props.actions.sendMessage()}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
