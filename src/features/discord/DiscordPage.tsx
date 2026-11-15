import { useEffect, useState } from "react";
import { Page, PageHeader } from "@/components/layout/PageHeader";
import { isDesktop } from "@/lib/native";
import { useRelayStatus } from "./api";
import { Advanced, Dashboard } from "./Dashboard";
import { Setup } from "./Setup";

const DESCRIPTION = "NOVA schreibt für dich in Kanäle und sagt Dinge im Call an, über euren eigenen Bot.";

/** The Discord tab: a short setup the first time, then an overview. */
export default function DiscordPage() {
  const { data: status } = useRelayStatus();
  // Decided once when the page opens, so saving names halfway through the setup doesn't end it.
  const [setup, setSetup] = useState<boolean | null>(null);
  useEffect(() => {
    if (status && setup === null) setSetup(!status.configured || status.aliases.length === 0);
  }, [status, setup]);

  if (!isDesktop()) {
    return (
      <Page>
        <PageHeader title="Discord" description={DESCRIPTION} />
        <p className="glass rounded-widget p-6 text-[13px] text-fg-muted">Das gibt es in der NOVA-Desktop-App.</p>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader title="Discord" description={DESCRIPTION} />
      {status && setup !== null && (
        <div className="space-y-6">
          {setup || !status.configured ? (
            <>
              <Setup status={status} onDone={() => setSetup(false)} />
              <Advanced className="mx-auto max-w-3xl" />
            </>
          ) : (
            <Dashboard status={status} onSetup={() => setSetup(true)} onDisconnected={() => setSetup(true)} />
          )}
        </div>
      )}
    </Page>
  );
}
