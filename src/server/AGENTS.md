# Node host

This is the independent Node host entry. It owns storage readiness and an optional local Web console.
`ServerStorage` owns the directory lock, shared database, AgentStore and MailboxStore. Run store
operations through the process-owned ManagedRuntime; disposal must wait for storage writes.
The existing store initialization includes recovery and attachment maintenance. It is not
read-only. Keep raw store methods internal until authenticated domain operations are added.
Do not import Electron, `src/main`, `src/preload` or renderer modules here.
Reuse backend services through explicit dependencies. Do not use empty adapters to claim a
provider, browser or scheduler is ready.

Use a dedicated data directory. Do not adopt an existing desktop profile or change released
database migrations. Close listeners before storage, and release the directory lock last.
Keep the listener on loopback until authenticated application routes are implemented.

The `--web` development entry serves `src/server-web` with Vite and authenticated console routes.
Its browser entry reuses the renderer's local workspace view. Node code still must not import the
renderer: only Vite serves those source assets. `server-workspace` reads existing records without
starting AgentService or changing read state. Keep its stable identity and workspace/Agent/thread
cursor checks. Redact display fields before enforcing their output length limits.
Keep its loopback binding and exact Host/Origin checks. Provider operations must validate the
operator session in the domain. Never return saved secrets or raw upstream errors. Keep both
configured and physical secret/data paths outside Vite file serving. Dispose requests before keys
and stores. This console does not provide agent execution or a production asset server.

`ServerCredentials` reads an external operator key file and owns the server cipher. Never generate
a default key, store the master key in the data directory, or expose plaintext through status or
HTTP replies. An unreadable credential store must fail startup before its write methods become
available. Do not clear persisted credentials during shutdown. Provider ciphertext is bound to the
provider identifier; other future stores need a separate context namespace.
