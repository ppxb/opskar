import { Schema } from "effect";
import type { ClientAgentSummary, ConversationPage, SidebarLayoutSnapshot } from "./ipc";
import {
  isClientAgentSummary,
  isConversationMessage,
  isConversationWithReadState,
  isSidebarLayoutSnapshot,
} from "./ipc";
import { isDynamicRecord } from "./runtime-values";

/** The Node workspace has its own identity. It is not a cloud account or a remote Team host. */
export const LocalWorkspaceSnapshot = Schema.Struct({
  workspaceId: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  mode: Schema.Literal("read-only"),
  agents: Schema.Array(Schema.declare<ClientAgentSummary>(isClientAgentSummary)),
  sidebarLayout: Schema.declare<SidebarLayoutSnapshot>(isSidebarLayoutSnapshot),
});
export type LocalWorkspaceSnapshot = typeof LocalWorkspaceSnapshot.Type;

function isLocalConversationPage(value: unknown): value is ConversationPage {
  if (
    !isConversationWithReadState(value) ||
    !isDynamicRecord(value) ||
    !isDynamicRecord(value.references) ||
    !isDynamicRecord(value.pageInfo)
  )
    return false;
  const info = value.pageInfo;
  return (
    Object.values(value.references).every(isConversationMessage) &&
    typeof info.hasOlder === "boolean" &&
    (info.olderCursor === null || typeof info.olderCursor === "string") &&
    (!info.hasOlder || (typeof info.olderCursor === "string" && info.olderCursor.length > 0)) &&
    (info.olderCount === undefined ||
      (typeof info.olderCount === "number" && Number.isSafeInteger(info.olderCount) && info.olderCount >= 0)) &&
    (info.oldestAt === undefined || typeof info.oldestAt === "string")
  );
}

export const LocalConversationPage = Schema.declare<ConversationPage>(isLocalConversationPage);
export type LocalConversationPage = typeof LocalConversationPage.Type;

export const LocalConversationInput = Schema.Struct({
  agentId: Schema.NonEmptyString.check(Schema.isMaxLength(128), Schema.isPattern(/^[A-Za-z0-9_-]+$/u)),
  before: Schema.optional(Schema.NonEmptyString.check(Schema.isMaxLength(4096), Schema.isPattern(/^[A-Za-z0-9_-]+$/u))),
});
export type LocalConversationInput = typeof LocalConversationInput.Type;
