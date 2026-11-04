import { Schema } from "effect";
import { INPUT_LIMITS } from "./input-limits";
import type { AvatarHue, ClientAgentSummary, ConversationPage, SidebarLayoutSnapshot } from "./ipc";
import {
  isAvatarHue,
  isClientAgentSummary,
  isConversationMessage,
  isConversationWithReadState,
  isSidebarLayoutSnapshot,
} from "./ipc";
import { isDynamicRecord } from "./runtime-values";

/** The Node workspace has its own identity. It is not a cloud account or a remote Team host. */
export const LocalExecutionState = Schema.Struct({
  state: Schema.Literals(["disabled", "unconfigured", "starting", "ready", "error"]),
  message: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
});
export type LocalExecutionState = typeof LocalExecutionState.Type;

export const LocalWorkspaceSnapshot = Schema.Struct({
  workspaceId: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  mode: Schema.Literals(["read-only", "interactive"]),
  execution: LocalExecutionState,
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

const Identifier = Schema.NonEmptyString.check(Schema.isMaxLength(128), Schema.isPattern(/^[A-Za-z0-9_-]+$/u));
export const LocalAgentCreateInput = Schema.Struct({
  name: Schema.NonEmptyString.check(Schema.isMaxLength(INPUT_LIMITS.agentName), Schema.isPattern(/\S/u)),
  description: Schema.String.check(Schema.isMaxLength(INPUT_LIMITS.agentDescription)),
  avatarSeed: Schema.NonEmptyString.check(Schema.isPattern(/^[a-z0-9:-]{1,128}$/u)),
  avatarHue: Schema.NullOr(Schema.declare<AvatarHue>(isAvatarHue)),
});
export type LocalAgentCreateInput = typeof LocalAgentCreateInput.Type;
export const LocalAgentCreateResult = Schema.Struct({ agentId: Identifier });
export const LocalMessageInput = Schema.Struct({
  text: Schema.NonEmptyString.check(Schema.isMaxLength(INPUT_LIMITS.messageText), Schema.isPattern(/\S/u)),
  clientMessageId: Identifier,
});
export type LocalMessageInput = typeof LocalMessageInput.Type;
export const LocalMessageReceipt = Schema.Struct({ messageId: Identifier });
export const LocalStopInput = Schema.Struct({ turnId: Identifier });
export type LocalStopInput = typeof LocalStopInput.Type;
