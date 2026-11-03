import { Schema } from "effect";

/** Independent Node console API. This is not part of a released Team API adapter. */
export const SessionState = Schema.Struct({ authenticated: Schema.Boolean });
export const SessionInput = Schema.Struct({ password: Schema.String.check(Schema.isMaxLength(1024)) });

export const ProviderInput = Schema.Struct({
  baseUrl: Schema.NonEmptyString.check(Schema.isMaxLength(2048)),
  model: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  apiKey: Schema.optional(Schema.String.check(Schema.isMaxLength(8192))),
});
export type ProviderInput = typeof ProviderInput.Type;

export const ProviderSummary = Schema.Struct({
  baseUrl: Schema.String,
  model: Schema.String,
  hasApiKey: Schema.Boolean,
});
export const ProviderState = Schema.Struct({
  credentialStorage: Schema.Literals(["ready", "unconfigured"]),
  provider: Schema.NullOr(ProviderSummary),
});
export type ProviderState = typeof ProviderState.Type;

export const ProviderTestResult = Schema.Struct({ status: Schema.Literal("ok"), text: Schema.String });
export const ConsoleError = Schema.Struct({ error: Schema.String });
