import { ArrowLeft, Lock, Palette, Puzzle, ShieldCheck, TriangleAlert, Upload } from "lucide-react";
import { useState } from "react";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dialog } from "@/components/ui/Dialog";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { Switch } from "@/components/ui/Switch";
import { notify, notifyError } from "@/features/notifications/store";
import { callNative, isDesktop, NativeUnavailableError } from "@/lib/native";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { type PendingInstall, type PluginInfo, runnable, usePluginAction, usePlugins } from "./api";
import { PluginFrame } from "./PluginFrame";

export default function PluginsPage() {
  const pluginPage = useUi((s) => s.pluginPage);
  const { data: plugins } = usePlugins();
  const plugin = pluginPage ? plugins?.find((p) => p.id === pluginPage.pluginId) : undefined;
  const page = plugin?.pages.find((p) => p.id === pluginPage?.pageId);
  if (plugin && page && runnable(plugin)) return <PluginPageView plugin={plugin} page={page} />;
  return <PluginList plugins={plugins ?? []} />;
}

/** A plugin's own page fills the whole content area. */
function PluginPageView({ plugin, page }: { plugin: PluginInfo; page: { id: string; title: string } }) {
  const navigate = useUi((s) => s.navigate);
  return (
    <div className="flex h-[calc(100vh-3.75rem)] flex-col px-3 pb-3">
      <div className="flex h-9 shrink-0 items-center gap-2 px-1">
        <Button size="sm" variant="ghost" icon={<ArrowLeft size={14} />} onClick={() => navigate("plugins")}>
          Plugins
        </Button>
        <span className="text-[12px] text-fg-subtle">
          {plugin.name} {plugin.version}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-[18px]">
        <PluginFrame plugin={plugin} view={`page:${page.id}`} title={page.title} />
      </div>
    </div>
  );
}

function PluginList({ plugins }: { plugins: PluginInfo[] }) {
  const [pending, setPending] = useState<PendingInstall | null>(null);
  const pick = usePluginAction<void>(async () => {
    const found = await callNative<PendingInstall | null>("plugins_pick");
    setPending(found);
  });
  const confirm = usePluginAction<void>(() => callNative("plugins_install_confirm"));

  const install = () => {
    if (!pending) return;
    const { name } = pending;
    setPending(null);
    confirm.mutate(undefined, {
      onSuccess: () => notify(`${name} is installed`, { kind: "success" }),
      onError: (error) => notifyError(`Couldn't install ${name}`, error),
    });
  };

  return (
    <Page>
      <PageHeader
        title="Plugins"
        description="Add features to NOVA. Plugins run isolated from the rest of the app and only get what you allow."
        actions={
          <Button variant="primary" size="sm" icon={<Upload size={14} />} disabled={!isDesktop() || pick.isPending} onClick={() => pick.mutate(undefined, { onError: (error) => notifyError("That plugin can't be installed", error) })}>
            Install from file
          </Button>
        }
      />
      {!isDesktop() ? (
        <StatusMessage error={new NativeUnavailableError("plugins_list")} subject="plugins" />
      ) : plugins.length === 0 ? (
        <section className="glass flex flex-col items-center gap-2 rounded-widget p-10 text-center">
          <Puzzle size={26} className="text-accent-text" aria-hidden />
          <p className="text-[14px] font-semibold text-fg">No plugins yet</p>
          <p className="max-w-md text-[13px] text-fg-muted">Choose a .novaplugin file to install one. NOVA checks its signature and shows what it asks for before anything is installed.</p>
        </section>
      ) : (
        <ul className="space-y-3">
          {plugins.map((plugin) => (
            <PluginCard key={plugin.id} plugin={plugin} />
          ))}
        </ul>
      )}
      <Dialog
        open={pending !== null}
        onClose={() => {
          setPending(null);
          void callNative("plugins_install_cancel");
        }}
        title={pending ? `Install ${pending.name}?` : ""}
        description={pending ? (pending.replaces ? `Updates version ${pending.replaces} to ${pending.version}.` : `Version ${pending.version}${pending.author ? ` by ${pending.author}` : ""}.`) : undefined}
        footer={
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setPending(null);
                void callNative("plugins_install_cancel");
              }}
            >
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={install}>
              {pending?.replaces ? "Update" : "Install"}
            </Button>
          </>
        }
      >
        {pending && (
          <div className="space-y-3 text-[13px]">
            <p className="text-fg-muted">{pending.description}</p>
            {!pending.signed && (
              <p className="flex items-start gap-2 rounded-[12px] border border-warning/30 bg-warning/10 p-3 text-fg">
                <TriangleAlert size={15} className="mt-0.5 shrink-0 text-warning" aria-hidden /> Not signed. Only development builds of NOVA accept this.
              </p>
            )}
            <div>
              <p className="mb-1.5 font-medium text-fg">{pending.replaces ? "New permissions" : "It may"}</p>
              {(pending.replaces ? pending.addedPermissions : pending.permissions).length === 0 ? (
                <p className="text-fg-muted">{pending.replaces ? "Nothing new." : "Nothing beyond showing its own page."}</p>
              ) : (
                <ul className="space-y-1 text-fg-muted">
                  {(pending.replaces ? pending.addedPermissions : pending.permissions).map((permission) => (
                    <li key={permission} className="flex gap-2">
                      <ShieldCheck size={14} className="mt-0.5 shrink-0 text-accent-text" aria-hidden /> {permission}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </Dialog>
    </Page>
  );
}

function PluginCard({ plugin }: { plugin: PluginInfo }) {
  const openPage = useUi((s) => s.openPluginPage);
  const setAccent = useSettings((s) => s.setAccent);
  const [removing, setRemoving] = useState(false);
  const setEnabled = usePluginAction<boolean>((enabled) => callNative("plugins_set_enabled", { id: plugin.id, enabled }));
  const setPermission = usePluginAction<{ permission: string; granted: boolean }>(({ permission, granted }) => callNative("plugins_set_permission", { id: plugin.id, permission, granted }));
  const remove = usePluginAction<void>(() => callNative("plugins_uninstall", { id: plugin.id }));
  const onError = (error: unknown) => notifyError(`Couldn't change ${plugin.name}`, error);

  return (
    <li className="glass rounded-widget p-5">
      <div className="flex items-start gap-3.5">
        <span className="accent-gradient flex size-11 shrink-0 items-center justify-center rounded-[13px] text-on-accent">
          <Puzzle size={20} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[14.5px] font-semibold text-fg">{plugin.name}</h2>
            <span className="text-[12px] text-fg-subtle tabular-nums">{plugin.version}</span>
            {plugin.channel === "private" && (
              <Badge tone="accent">
                <Lock size={11} aria-hidden /> Private
              </Badge>
            )}
            {!plugin.signed && <Badge tone="warning">Not signed</Badge>}
          </div>
          <p className="mt-0.5 text-[12.5px] text-fg-muted">{plugin.description}</p>
          {plugin.author && <p className="mt-0.5 text-[11.5px] text-fg-subtle">by {plugin.author}</p>}
          {plugin.problem && <p className="mt-1.5 text-[12px] text-warning">{plugin.problem}</p>}
          {plugin.lastError && <p className="mt-1.5 text-[12px] text-warning">{plugin.lastError}</p>}
        </div>
        <Switch label={`Enable ${plugin.name}`} checked={plugin.enabled} disabled={setEnabled.isPending} onChange={(enabled) => setEnabled.mutate(enabled, { onError })} />
      </div>

      {runnable(plugin) && plugin.pages.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2 pl-[58px]">
          {plugin.pages.map((page) => (
            <Button key={page.id} size="sm" variant="secondary" onClick={() => openPage({ pluginId: plugin.id, pageId: page.id })}>
              Open {page.title}
            </Button>
          ))}
        </div>
      )}

      {plugin.enabled && plugin.themes.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2 pl-[58px]">
          {plugin.themes.map((theme) => (
            <Button key={theme.id} size="sm" variant="secondary" icon={<span className="size-3 rounded-full" style={{ background: theme.accent }} aria-hidden />} onClick={() => setAccent({ kind: "custom", color: theme.accent })}>
              {theme.name}
            </Button>
          ))}
          <span className="flex items-center gap-1.5 text-[11.5px] text-fg-subtle">
            <Palette size={12} aria-hidden /> Sets the accent color
          </span>
        </div>
      )}

      {plugin.permissions.length > 0 && (
        <div className="mt-4 space-y-2 border-t border-line pt-3 pl-[58px]">
          {plugin.permissions.map((permission) => (
            <div key={permission.key} className="flex items-center justify-between gap-4">
              <span className="text-[12.5px] text-fg-muted">{permission.label}</span>
              <Switch label={permission.label} checked={permission.granted} disabled={setPermission.isPending} onChange={(granted) => setPermission.mutate({ permission: permission.key, granted }, { onError })} />
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex justify-end">
        <Button size="sm" variant="ghost" onClick={() => setRemoving(true)}>
          Uninstall
        </Button>
      </div>
      <ConfirmDialog
        open={removing}
        title={`Uninstall ${plugin.name}?`}
        description="Its files and the data it kept on this PC are deleted. Widgets it added stay in your layouts as empty placeholders until you remove them."
        confirmLabel="Uninstall"
        danger
        onClose={() => setRemoving(false)}
        onConfirm={() => remove.mutate(undefined, { onError })}
      />
    </li>
  );
}
