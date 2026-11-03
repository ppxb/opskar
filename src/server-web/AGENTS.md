# Local server console

This SolidJS console talks only to the same-origin Node console API. Reuse `@openbot/ui` controls
and catalog text. The entry reuses `features/web-client/LocalWebWorkspace` from the renderer through
its typed source props. Keep this import narrow; do not import the desktop App, main, preload or
backend code. Decode API replies through `@openbot/contracts/server-console` and `server-workspace`.
Saved API keys stay on the server; do not put them in browser
storage, logs or URLs. Abort active requests when the page closes. Keep test actions explicit.
