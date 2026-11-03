# Platform cleanup

This checkout now targets Web access and the Linux host. This is a source cleanup, not the
completion of private Web hosting or a replacement for the Electron host runtime.

## Removed surfaces

- The Expo/React Native application in `apps/mobile`, including native modules, assets and plugins.
- Mobile development, code generation, packaging and release scripts.
- Mobile workspace entries, dependency patches and check configuration.
- macOS and Windows distribution targets, installer resources and signing configuration.

## Retained dependencies

The Linux container currently contains an Electron release. `src/main` starts its providers,
database, task queues and workflows. It also owns the browser and the Team API. The preload and
renderer pages support its security boundary and WebRTC transport.

`apps/auth-api` imports the Web client from `src/renderer/src/features/web-client`, plus shared
application composition and `packages/ui`. These folders are active Web and host dependencies.
Removing the remaining desktop composition requires a separate host-entry change and runtime
verification.

Released account and Team API behavior remains intact. The historical mobile changelog is now
in [mobile-changelog.md](archive/mobile-changelog.md). The account service reads the same bytes
from that path. Host notification tests retain their protocol helpers in
`scripts/security-fixtures`, including the mobile log redaction fixture and its protected test.
Shared mobile message catalogs remain because the host uses them for notification payloads.

macOS and Windows package security verification scripts remain as regression references.
Shared native runtime helpers remain where the Linux or development tooling imports them.

## Checks

The mobile workspace no longer participates in install, lint, test selection or type checks.
The remaining trust-boundary, migration, secret-redaction and protocol tests stay in place.
Use focused checks, one at a time. Do not run full builds or aggregate type checks as routine
validation.

Older architecture and release documents also describe released desktop and phone clients.
Those descriptions are compatibility history. The current build targets are the Linux commands
in [README.md](../README.md#commands).

## Further work

The independent entry is now in `src/server`. It starts the existing database, AgentStore and
MailboxStore under Node with a dedicated directory, and reports storage readiness on loopback.
All new workspaces and attachment directories remain under that directory. It does not yet start
agent execution, providers, schedulers, the account service or the Web client. See
[storage bootstrap](../README.md#independent-server-storage-bootstrap).

Private Web hosting still needs local account-service storage and runtime adapters, private
authentication, local connection-service configuration and an explicit outbound-data policy.
Gitea, monitoring and CI/CD integration are separate work.
