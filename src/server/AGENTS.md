# Node host

This is the independent Node host entry. It currently owns storage readiness only.
Do not import Electron, `src/main`, `src/preload` or renderer modules here.
Reuse backend services through explicit dependencies. Do not use empty adapters to claim a
provider, browser or scheduler is ready.

Use a dedicated data directory. Do not adopt an existing desktop profile or change released
database migrations. Close listeners before storage, and release the directory lock last.
Keep the listener on loopback until authenticated application routes are implemented.
