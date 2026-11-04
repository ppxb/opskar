import { sourceText } from "@openbot/i18n/source";
import { Schema } from "effect";

export class ConsoleFailure extends Schema.TaggedError<ConsoleFailure>()("ConsoleFailure", {
  code: Schema.Literals([
    "unauthorized",
    "forbidden",
    "invalid",
    "too-large",
    "rate-limit",
    "storage",
    "key-required",
    "unconfigured",
    "not-saved",
    "busy",
    "provider",
    "timeout",
    "response",
    "workspace-agent",
    "workspace-input",
    "workspace-read",
    "agent-unavailable",
    "agent-operation",
    "agent-model",
    "agent-busy",
    "agent-access",
  ]),
}) {}

export function consoleError(error: ConsoleFailure): { status: number; error: string } {
  switch (error.code) {
    case "agent-access":
      return { status: 409, error: sourceText("error.host.agentAccessUnavailable") };
    case "agent-unavailable":
      return { status: 503, error: sourceText("error.host.agentUnavailable") };
    case "agent-operation":
      return { status: 500, error: sourceText("error.host.agentOperation") };
    case "agent-model":
      return { status: 409, error: sourceText("error.host.agentModelInvalid") };
    case "agent-busy":
      return { status: 409, error: sourceText("error.host.agentBusy") };
    case "workspace-agent":
      return { status: 404, error: sourceText("error.host.localWorkspaceAgentMissing") };
    case "workspace-input":
      return { status: 400, error: sourceText("error.host.localWorkspaceInput") };
    case "workspace-read":
      return { status: 500, error: sourceText("error.host.localWorkspaceRead") };
    case "unauthorized":
      return { status: 401, error: sourceText("error.provider.consoleUnauthorized") };
    case "forbidden":
      return { status: 403, error: sourceText("error.provider.consoleForbidden") };
    case "invalid":
      return { status: 400, error: sourceText("error.provider.consoleInvalid") };
    case "too-large":
      return { status: 413, error: sourceText("error.provider.consoleTooLarge") };
    case "rate-limit":
      return { status: 429, error: sourceText("error.provider.consoleRateLimit") };
    case "key-required":
      return { status: 409, error: sourceText("error.provider.consoleKeyRequired") };
    case "unconfigured":
      return { status: 503, error: sourceText("error.provider.consoleUnconfigured") };
    case "not-saved":
      return { status: 409, error: sourceText("error.provider.consoleNotSaved") };
    case "busy":
      return { status: 409, error: sourceText("error.provider.consoleBusy") };
    case "timeout":
      return { status: 504, error: sourceText("error.provider.consoleTimeout") };
    case "response":
      return { status: 502, error: sourceText("error.provider.consoleResponse") };
    case "provider":
      return { status: 502, error: sourceText("error.provider.consoleProvider") };
    case "storage":
      return { status: 500, error: sourceText("error.provider.consoleStorage") };
  }
}
