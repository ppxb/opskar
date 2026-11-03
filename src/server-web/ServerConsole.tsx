import type { ProviderState } from "@openbot/contracts/server-console";
import { Alert, Button, Checkbox, Field, Heading, Input, Label, Text } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";
import { createStore, Loading, lazy, onSettled, Show } from "solid-js";
import { ConsoleRequestFailed, consoleApi } from "./console-api";

interface ConsoleState {
  page: "loading" | "login" | "settings" | "workspace";
  busy: "load" | "login" | "save" | "test" | "logout" | null;
  password: string;
  saved: ProviderState | null;
  draft: { baseUrl: string; model: string; apiKey: string; noKey: boolean };
  error: string;
  notice: string;
  result: string | null;
}

const LocalWebWorkspace = lazy(() =>
  import("../renderer/src/features/web-client/LocalWebWorkspace").then((module) => ({
    default: module.LocalWebWorkspace,
  })),
);

export function ServerConsole(): JSX.Element {
  const { t, sourceText } = useText();
  const providerSettings = window.location.pathname === "/settings/providers";
  const [state, setState] = createStore<ConsoleState>({
    page: "loading",
    busy: null,
    password: "",
    saved: null,
    draft: { baseUrl: "https://api.openai.com/v1", model: "", apiKey: "", noKey: false },
    error: "",
    notice: "",
    result: null,
  });
  let active: AbortController | null = null;
  let disposed = false;

  const dirty = () => {
    const saved = state.saved?.provider;
    return (
      !saved ||
      state.draft.baseUrl.trim() !== saved.baseUrl ||
      state.draft.model.trim() !== saved.model ||
      state.draft.apiKey.length > 0 ||
      (state.draft.noKey && saved.hasApiKey)
    );
  };
  const storageReady = () => state.saved?.credentialStorage === "ready";

  async function showAuthenticated(signal: AbortSignal): Promise<void> {
    if (providerSettings) showProvider(await consoleApi.provider(signal));
    else
      setState((draft) => {
        draft.page = "workspace";
      });
  }

  function showProvider(saved: ProviderState): void {
    setState((draft) => {
      draft.page = "settings";
      draft.saved = saved;
      draft.draft.baseUrl = saved.provider?.baseUrl ?? "https://api.openai.com/v1";
      draft.draft.model = saved.provider?.model ?? "";
      draft.draft.apiKey = "";
      draft.draft.noKey = false;
    });
  }

  function showLogin(): void {
    setState((draft) => {
      draft.page = "login";
      draft.password = "";
      draft.saved = null;
      draft.draft.baseUrl = "https://api.openai.com/v1";
      draft.draft.model = "";
      draft.draft.apiKey = "";
      draft.draft.noKey = false;
      draft.result = null;
      draft.notice = "";
    });
  }

  async function run(busy: NonNullable<ConsoleState["busy"]>, operation: (signal: AbortSignal) => Promise<void>) {
    if (active) return;
    const controller = new AbortController();
    active = controller;
    setState((draft) => {
      draft.busy = busy;
      draft.error = "";
      draft.notice = "";
    });
    try {
      await operation(controller.signal);
    } catch (error) {
      if (disposed) return;
      if (controller.signal.aborted) {
        setState((draft) => {
          draft.notice = t("settings.server.testCancelled");
        });
      } else {
        if (error instanceof ConsoleRequestFailed && error.status === 401) showLogin();
        setState((draft) => {
          draft.error =
            error instanceof ConsoleRequestFailed ? sourceText(error.message) : t("settings.server.requestFailed");
        });
      }
    } finally {
      active = null;
      if (!disposed) {
        setState((draft) => {
          draft.busy = null;
        });
      }
    }
  }

  function load(): void {
    void run("load", async (signal) => {
      const session = await consoleApi.session(signal);
      if (!session.authenticated) showLogin();
      else await showAuthenticated(signal);
    });
  }

  onSettled(() => {
    document.title = providerSettings ? t("settings.server.title") : t("status.host.localWorkspace");
    load();
    return () => {
      disposed = true;
      active?.abort();
    };
  });

  function login(event: SubmitEvent): void {
    event.preventDefault();
    const password = state.password;
    void run("login", async (signal) => {
      setState((draft) => {
        draft.password = "";
      });
      await consoleApi.login(password, signal);
      await showAuthenticated(signal);
    });
  }

  function save(event: SubmitEvent): void {
    event.preventDefault();
    const input = {
      baseUrl: state.draft.baseUrl.trim(),
      model: state.draft.model.trim(),
      ...(state.draft.noKey || !state.saved?.provider?.hasApiKey || state.draft.apiKey
        ? { apiKey: state.draft.noKey ? "" : state.draft.apiKey }
        : {}),
    };
    void run("save", async (signal) => {
      const saved = await consoleApi.save(input, signal);
      showProvider(saved);
      setState((draft) => {
        draft.notice = t("settings.server.saved");
        draft.result = null;
      });
    });
  }

  function test(): void {
    if (dirty()) return;
    void run("test", async (signal) => {
      setState((draft) => {
        draft.result = null;
      });
      const result = await consoleApi.test(signal);
      setState((draft) => {
        draft.result = result.text;
        draft.notice = t("settings.server.testPassed");
      });
    });
  }

  function logout(): void {
    void run("logout", async (signal) => {
      await consoleApi.logout(signal);
      showLogin();
    });
  }

  return (
    <Show
      when={state.page !== "workspace"}
      fallback={
        <Loading fallback={<Text role="status">{t("common.loading")}</Text>}>
          <LocalWebWorkspace
            source={consoleApi}
            onError={(error) => {
              if (error instanceof ConsoleRequestFailed && error.status === 401) showLogin();
            }}
            onLogout={async () => {
              const controller = new AbortController();
              active = controller;
              try {
                await consoleApi.logout(controller.signal);
                showLogin();
              } finally {
                active = null;
              }
            }}
            onOpenProviderSettings={() => window.location.assign("/settings/providers")}
          />
        </Loading>
      }
    >
      <main class="server-console">
        <header class="server-console-header">
          <div class="server-console-intro">
            <Text variant="label" tone="secondary">
              {t("settings.server.localConsole")}
            </Text>
            <Heading as="h1" size="lg">
              {providerSettings ? t("settings.server.title") : t("status.host.localWorkspace")}
            </Heading>
            <Text as="p" tone="secondary">
              {providerSettings ? t("settings.server.description") : t("settings.server.loginDescription")}
            </Text>
          </div>
          <Show when={state.page === "settings"}>
            <Button variant="outline" disabled={state.busy !== null} onClick={() => window.location.assign("/")}>
              {t("status.host.localWorkspace")}
            </Button>
            <Button variant="outline" disabled={state.busy !== null} onClick={logout}>
              {t("settings.server.logout")}
            </Button>
          </Show>
        </header>

        <Show when={state.error}>
          <Alert tone="danger" role="alert">
            {state.error}
          </Alert>
        </Show>
        <Show when={state.notice}>
          <Alert tone="neutral" role="status">
            {state.notice}
          </Alert>
        </Show>

        <Show when={state.page === "loading"}>
          <section class="server-console-card">
            <Show when={state.busy} fallback={<Button onClick={load}>{t("common.retry")}</Button>}>
              <Text role="status">{t("common.loading")}</Text>
            </Show>
          </section>
        </Show>

        <Show when={state.page === "login"}>
          <section class="server-console-card server-console-login">
            <Heading>{t("settings.server.loginTitle")}</Heading>
            <Text as="p" tone="secondary">
              {t("settings.server.loginDescription")}
            </Text>
            <form class="server-console-form" onSubmit={login}>
              <Field label={t("settings.server.password")} required>
                <Input
                  type="password"
                  name="password"
                  autocomplete="current-password"
                  maxlength={1024}
                  value={state.password}
                  disabled={state.busy !== null}
                  onValueChange={(value) =>
                    setState((draft) => {
                      draft.password = value;
                    })
                  }
                />
              </Field>
              <Button type="submit" loading={state.busy === "login"} disabled={state.busy !== null}>
                {t("settings.server.login")}
              </Button>
            </form>
          </section>
        </Show>

        <Show when={state.page === "settings"}>
          <div class="server-console-columns">
            <section class="server-console-card">
              <Heading>{t("settings.server.providerTitle")}</Heading>
              <Text as="p" tone="secondary">
                {t("settings.server.providerDescription")}
              </Text>
              <Text as="p" tone={storageReady() ? "success" : "warning"} role="status">
                {storageReady() ? t("settings.server.storageReady") : t("settings.server.storageMissing")}
              </Text>
              <form class="server-console-form" onSubmit={save}>
                <Field label={t("settings.server.baseUrl")} description={t("settings.server.baseUrlHelp")} required>
                  <Input
                    type="url"
                    name="baseUrl"
                    autocomplete="off"
                    maxlength={2048}
                    value={state.draft.baseUrl}
                    disabled={state.busy !== null || !storageReady()}
                    onValueChange={(value) =>
                      setState((draft) => {
                        draft.draft.baseUrl = value;
                      })
                    }
                  />
                </Field>
                <Field label={t("settings.server.model")} description={t("settings.server.modelHelp")} required>
                  <Input
                    name="model"
                    autocomplete="off"
                    maxlength={256}
                    value={state.draft.model}
                    disabled={state.busy !== null || !storageReady()}
                    onValueChange={(value) =>
                      setState((draft) => {
                        draft.draft.model = value;
                      })
                    }
                  />
                </Field>
                <Field
                  label={t("settings.server.apiKey")}
                  description={
                    state.saved?.provider?.hasApiKey ? t("settings.server.keySaved") : t("settings.server.keyMissing")
                  }
                >
                  <Input
                    type="password"
                    name="apiKey"
                    autocomplete="new-password"
                    maxlength={8192}
                    value={state.draft.apiKey}
                    disabled={state.busy !== null || !storageReady() || state.draft.noKey}
                    onValueChange={(value) =>
                      setState((draft) => {
                        draft.draft.apiKey = value;
                      })
                    }
                  />
                </Field>
                <Label class="server-console-checkbox">
                  <Checkbox
                    checked={state.draft.noKey}
                    disabled={state.busy !== null || !storageReady()}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setState((draft) => {
                        draft.draft.noKey = checked;
                        draft.draft.apiKey = "";
                      });
                    }}
                  />
                  {t("settings.server.noKey")}
                </Label>
                <Text as="p" tone="secondary" variant="caption">
                  {t("settings.server.endpointChange")}
                </Text>
                <div class="server-console-actions">
                  <Button
                    type="submit"
                    loading={state.busy === "save"}
                    disabled={state.busy !== null || !storageReady() || !dirty()}
                  >
                    {t("common.save")}
                  </Button>
                  <Show when={dirty() && state.saved?.provider}>
                    <Text tone="secondary" variant="caption">
                      {t("settings.server.unsaved")}
                    </Text>
                  </Show>
                </div>
              </form>
            </section>

            <section class="server-console-card server-console-test">
              <Heading>{t("settings.server.testTitle")}</Heading>
              <Text as="p" tone="secondary">
                {t("settings.server.testDescription")}
              </Text>
              <Text as="p" tone="secondary" variant="caption">
                {t("settings.server.testScope")}
              </Text>
              <div class="server-console-actions">
                <Button
                  onClick={test}
                  loading={state.busy === "test"}
                  disabled={state.busy !== null || !storageReady() || dirty()}
                >
                  {t("settings.server.test")}
                </Button>
                <Show when={state.busy === "test"}>
                  <Button variant="outline" onClick={() => active?.abort()}>
                    {t("common.cancel")}
                  </Button>
                </Show>
              </div>
              <Show when={state.result !== null}>
                <div class="server-console-result" role="status">
                  <Text as="strong" variant="label">
                    {t("settings.server.response")}
                  </Text>
                  <Text as="p" class="server-console-response">
                    {state.result}
                  </Text>
                </div>
              </Show>
            </section>
          </div>
        </Show>
      </main>
    </Show>
  );
}
