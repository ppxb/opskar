import type { AppInfo } from "@openbot/contracts/ipc";
import { Alert, Button, Heading, Text } from "@openbot/ui";
import { ConversationHeader } from "@openbot/ui/features/conversation/ConversationHeader";
import { Sidebar } from "@openbot/ui/features/sidebar/Sidebar";
import { useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";
import { createStore, onSettled, Show } from "solid-js";
import { LayoutProvider, useLayout } from "../../layout";
import { PlatformProvider } from "../../platform";
import { WorkspaceFrame } from "../../WorkspaceFrame";
import { defaultSidebarLayout } from "../sidebar/sidebar-sections";
import { LocalWorkspaceHistory } from "./LocalWorkspaceHistory";
import { createLocalWorkspace } from "./local-workspace-context";
import type { LocalWorkspaceSource } from "./local-workspace-source";
import "./local-workspace.css";

// The existing Web workspace uses macOS frame geometry without native window controls.
const LOCAL_WEB_INFO: AppInfo = { name: "OPSKAR", version: "web", platform: "darwin", variant: "production" };

export interface LocalWebWorkspaceProps {
  source: LocalWorkspaceSource;
  onLogout: () => Promise<void>;
  onError: (error: unknown) => void;
  onOpenProviderSettings?: (() => void) | undefined;
}

/** The existing workspace frame, sidebar, header and message rows, with read operations only. */
export function LocalWebWorkspace(props: LocalWebWorkspaceProps): JSX.Element {
  return (
    <PlatformProvider appInfo={LOCAL_WEB_INFO}>
      <LayoutProvider>
        <LocalWorkspaceFrame {...props} />
      </LayoutProvider>
    </PlatformProvider>
  );
}

function LocalWorkspaceFrame(props: LocalWebWorkspaceProps): JSX.Element {
  const { t, errorMessage } = useText();
  const layout = useLayout();
  const workspace = createLocalWorkspace({ source: props.source, onError: props.onError });
  const [view, setView] = createStore<{ collapsedSections: string[]; signingOut: boolean; logoutError: string }>({
    collapsedSections: [],
    signingOut: false,
    logoutError: "",
  });
  let disposed = false;
  onSettled(() => () => {
    disposed = true;
  });

  async function logout(): Promise<void> {
    setView((draft) => {
      draft.signingOut = true;
      draft.logoutError = "";
    });
    try {
      await props.onLogout();
    } catch (error) {
      if (disposed) return;
      props.onError(error);
      if (disposed) return;
      setView((draft) => {
        draft.logoutError = errorMessage(error, t("settings.workspace.logoutFailed"));
      });
    } finally {
      if (!disposed)
        setView((draft) => {
          draft.signingOut = false;
        });
    }
  }

  return (
    <div class="web-app local-workspace">
      <WorkspaceFrame
        class="web-app-frame local-workspace-frame"
        compact={layout.leftPanelCompact()}
        serverRailVisible={false}
        blockedServer={null}
        onRetryServer={workspace.refresh}
        windowPage="agents"
        left={
          <Sidebar
            serverName={workspace.state.snapshot?.name ?? t("settings.workspace.title")}
            agents={workspace.profiles()}
            agentsConnecting={workspace.state.loading && !workspace.state.snapshot}
            activeAgentId={workspace.state.selectedId ?? ""}
            people={[]}
            showPeople={false}
            directThreads={[]}
            activeDirectMemberId={null}
            agentStates={{}}
            agentMoods={{}}
            layout={workspace.state.snapshot?.sidebarLayout ?? defaultSidebarLayout()}
            layoutMutable={false}
            collapsedSectionIds={view.collapsedSections}
            onToggleSection={(sectionId) =>
              setView((draft) => {
                draft.collapsedSections = draft.collapsedSections.includes(sectionId)
                  ? draft.collapsedSections.filter((id) => id !== sectionId)
                  : [...draft.collapsedSections, sectionId];
              })
            }
            pinnedItems={[]}
            peopleOrder={[]}
            onSelectAgent={(agentId) => void workspace.select(agentId)}
            createSupported={false}
            deleteSupported={false}
            marketplaceSupported={false}
            duplicateSupported={false}
            compact={layout.leftPanelCompact()}
            onExpand={layout.expandSidebar}
            footer={
              <Text as="p" class="local-workspace-sidebar-note" tone="secondary">
                {t("settings.workspace.readOnly")}
              </Text>
            }
          />
        }
      >
        <main class="conversation-panel local-workspace-conversation" aria-label={t("settings.workspace.historyTitle")}>
          <ConversationHeader
            agent={workspace.selected()}
            title={<Heading as="h1">{t("settings.workspace.title")}</Heading>}
            actions={
              <>
                <Button variant="ghost" onClick={() => void workspace.refresh()} disabled={workspace.state.loading}>
                  {t("settings.workspace.refresh")}
                </Button>
                <Show when={props.onOpenProviderSettings}>
                  <Button variant="ghost" onClick={() => props.onOpenProviderSettings?.()}>
                    {t("settings.workspace.providers")}
                  </Button>
                </Show>
                <Button variant="ghost" onClick={() => void logout()} disabled={view.signingOut}>
                  {t("settings.server.logout")}
                </Button>
              </>
            }
          />
          <div class="local-workspace-notices">
            <Text as="p" tone="secondary">
              {t("settings.workspace.readOnlyDescription")}
            </Text>
            <Show when={workspace.state.error || view.logoutError}>
              <Alert tone="danger" role="alert">
                {workspace.state.error || view.logoutError}
              </Alert>
            </Show>
          </div>
          <Show
            when={workspace.selected()}
            fallback={
              <div class="local-workspace-empty" role="status">
                <Heading>{workspace.state.loading ? t("common.loading") : t("settings.workspace.empty")}</Heading>
                <Show when={!workspace.state.loading}>
                  <Text as="p" tone="secondary">
                    {t("settings.workspace.emptyDescription")}
                  </Text>
                </Show>
              </div>
            }
          >
            <LocalWorkspaceHistory workspace={workspace} />
          </Show>
        </main>
      </WorkspaceFrame>
    </div>
  );
}
