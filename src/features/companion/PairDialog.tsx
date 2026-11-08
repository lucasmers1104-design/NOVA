import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { notifyError } from "@/features/notifications/store";
import { callNative } from "@/lib/native";

interface PairRequest {
  deviceName: string;
  platform: "android" | "ios";
}

/**
 * "Pair this phone?": a phone scanned the code shown by the NOVA Companion plugin.
 * SECURITY: the answer comes from NOVA's own window, never from the plugin's frame,
 * so the plugin can't let a phone in by itself (companion_pair_decide in Rust).
 */
export function PairDialog() {
  const [request, setRequest] = useState<PairRequest | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    const stop = listen<PairRequest>("companion://pair-request", (event) => setRequest(event.payload));
    return () => void stop.then((unlisten) => unlisten()).catch(() => {});
  }, []);

  const decide = (approved: boolean) => {
    setRequest(null);
    callNative("companion_pair_decide", { approved }).catch((error: unknown) => {
      if (approved) notifyError("The phone couldn't be paired", error);
    });
  };

  return (
    <Dialog
      open={request !== null}
      onClose={() => decide(false)}
      title={`Pair “${request?.deviceName ?? ""}”?`}
      description="This phone scanned your pairing code. Once paired, it can ask NOVA AI and start the apps you allowed; changes need your fingerprint on the phone."
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={() => decide(false)} data-autofocus>
            Don't pair
          </Button>
          <Button size="sm" variant="primary" onClick={() => decide(true)}>
            Pair
          </Button>
        </>
      }
    >
      {null}
    </Dialog>
  );
}
