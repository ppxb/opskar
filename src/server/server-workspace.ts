import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import type {
  AgentSummary,
  AttachmentSummary,
  ClientAgentSummary,
  ConversationMessage,
  ConversationPage,
} from "@openbot/contracts/ipc";
import { SIDEBAR_PEOPLE_SECTION_ID, SIDEBAR_UNASSIGNED_SECTION_ID } from "@openbot/contracts/ipc";
import type { LocalConversationInput, LocalWorkspaceSnapshot } from "@openbot/contracts/server-workspace";
import { sourceText } from "@openbot/i18n/source";
import { redactText } from "@openbot/logging";
import { Effect, Schema } from "effect";
import { writeJsonFileAtomically } from "../backend/atomic-json-file";
import type { ServerAgentControl } from "./server-agent";
import type { ConsoleAuth } from "./server-console-auth";
import { ConsoleFailure } from "./server-console-error";
import { ServerStartupFailed } from "./server-options";
import { ServerStorage } from "./server-storage";

const Identity = Schema.Struct({ version: Schema.Literal(1), workspaceId: Schema.String.check(Schema.isUUID()) });
const Cursor = Schema.Struct({
  version: Schema.Literal(1),
  workspaceId: Schema.String,
  agentId: Schema.String,
  threadId: Schema.String,
  cursor: Schema.NonEmptyString.check(Schema.isMaxLength(2048), Schema.isPattern(/^[A-Za-z0-9_-]+$/u)),
});
export const SERVER_WORKSPACE_FILE = "opskar-workspace-v1.json";

/** Redaction can expand a short secret. Keep the existing display-contract bounds afterward. */
function displayText(value: string, limit: number): string {
  return redactText(value).slice(0, limit);
}

function visibleAgent(agent: AgentSummary): ClientAgentSummary {
  const model = redactText(agent.model);
  const avatarSeed = redactText(agent.avatarSeed);
  return {
    id: agent.id,
    name: displayText(agent.name, INPUT_LIMITS.agentName),
    title: displayText(agent.title, INPUT_LIMITS.agentTitle),
    description: displayText(agent.description, INPUT_LIMITS.agentDescription),
    notifications: agent.notifications,
    provider: agent.provider,
    model: model === agent.model ? model : "redacted",
    reasoningEffort: agent.reasoningEffort,
    ...(agent.access === undefined ? {} : { access: agent.access }),
    threadId: agent.threadId,
    workspacePath: displayText(agent.workspacePath, INPUT_LIMITS.path),
    preview: displayText(agent.preview, INPUT_LIMITS.messageText),
    updatedAt: agent.updatedAt,
    avatarSeed: avatarSeed === agent.avatarSeed ? avatarSeed : "redacted",
    avatarHue: agent.avatarHue,
    avatarUrl: null,
  };
}

function visibleAttachment(attachment: AttachmentSummary): AttachmentSummary {
  return {
    id: attachment.id,
    name: displayText(attachment.name, INPUT_LIMITS.attachmentName),
    size: attachment.size,
    kind: attachment.kind,
    mimeType: displayText(attachment.mimeType, INPUT_LIMITS.mimeType),
    previewKind: attachment.previewKind,
    previewUrl: null,
  };
}

/** Workspace reads return text and attachment labels, not executable cards or file URLs. */
function visibleMessage(message: ConversationMessage): ConversationMessage {
  return {
    id: message.id,
    turnId: message.turnId,
    author: message.author,
    text: redactText(message.text),
    createdAt: message.createdAt,
    status: message.status,
    source: message.source,
    senderAgentId: message.senderAgentId,
    replyToMessageId: message.replyToMessageId,
    ...(message.senderMember
      ? {
          senderMember: {
            id: message.senderMember.id,
            name: displayText(message.senderMember.name, INPUT_LIMITS.accountName),
          },
        }
      : {}),
    ...(message.attachments ? { attachments: message.attachments.map(visibleAttachment) } : {}),
  };
}

export const acquireLocalWorkspace = Effect.fn("acquireLocalWorkspace")(function* (
  auth: ConsoleAuth,
  execution: ServerAgentControl,
) {
  const { agents, database, paths } = yield* ServerStorage;
  const identityPath = join(paths.dataDirectory, SERVER_WORKSPACE_FILE);
  const saved = yield* Effect.tryPromise({
    try: async () => {
      try {
        const metadata = await lstat(identityPath);
        if (!metadata.isFile() || metadata.size > 1024) throw new Error("Invalid workspace identity file.");
        return Schema.decodeUnknownSync(Identity)(JSON.parse(await readFile(identityPath, "utf8")));
      } catch (cause) {
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
        throw cause;
      }
    },
    catch: (cause) => new ServerStartupFailed({ code: "workspace", cause }),
  });
  const identity = saved ?? { version: 1 as const, workspaceId: randomUUID() };
  if (!saved)
    yield* writeJsonFileAtomically(identityPath, identity).pipe(
      Effect.mapError((cause) => new ServerStartupFailed({ code: "workspace", cause })),
    );
  const readWorkspace = Effect.fn("LocalWorkspace.readWorkspace")(function* (token: string | undefined) {
    yield* auth.requireSession(token);
    return yield* Effect.try({
      try: (): LocalWorkspaceSnapshot => {
        const list = agents.list().map(visibleAgent);
        return {
          workspaceId: identity.workspaceId,
          name: sourceText("status.host.localWorkspace"),
          mode: execution.enabled ? "interactive" : "read-only",
          execution: execution.state(),
          agents: list,
          sidebarLayout: {
            revision: 0,
            sections: [],
            order: [SIDEBAR_PEOPLE_SECTION_ID, SIDEBAR_UNASSIGNED_SECTION_ID],
            agentAssignments: {},
            agentOrder: list.map((agent) => agent.id),
          },
        };
      },
      catch: () => new ConsoleFailure({ code: "workspace-read" }),
    });
  });
  const readConversation = Effect.fn("LocalWorkspace.readConversation")(function* (
    token: string | undefined,
    input: LocalConversationInput,
  ) {
    yield* auth.requireSession(token);
    const agent = agents.list().find((agent) => agent.id === input.agentId);
    if (!agent) return yield* new ConsoleFailure({ code: "workspace-agent" });
    let cursor: string | undefined;
    if (input.before !== undefined) {
      const decoded = yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(Cursor)(JSON.parse(Buffer.from(input.before ?? "", "base64url").toString("utf8"))),
        catch: () => new ConsoleFailure({ code: "workspace-input" }),
      });
      if (
        decoded.workspaceId !== identity.workspaceId ||
        decoded.agentId !== agent.id ||
        decoded.threadId !== agent.threadId
      ) {
        return yield* new ConsoleFailure({ code: "workspace-input" });
      }
      cursor = decoded.cursor;
    }
    return yield* Effect.try({
      try: (): ConversationPage => {
        const page = database.readConversationPage(
          agent.id,
          agent.threadId,
          cursor ? { type: "before", cursor } : { type: "latest" },
          50,
        );
        const olderCursor =
          page.pageInfo.olderCursor && agent.threadId
            ? Buffer.from(
                JSON.stringify({
                  version: 1,
                  workspaceId: identity.workspaceId,
                  agentId: agent.id,
                  threadId: agent.threadId,
                  cursor: page.pageInfo.olderCursor,
                }),
              ).toString("base64url")
            : null;
        return {
          ...page,
          messages: page.messages.map(visibleMessage),
          references: Object.fromEntries(
            Object.entries(page.references).map(([id, message]) => [id, visibleMessage(message)]),
          ),
          pageInfo: { ...page.pageInfo, olderCursor },
        };
      },
      catch: (cause) =>
        new ConsoleFailure({
          code:
            cause instanceof Error && cause.message === "The conversation page cursor is invalid."
              ? "workspace-input"
              : "workspace-read",
        }),
    });
  });
  return { readWorkspace, readConversation };
});
