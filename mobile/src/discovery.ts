// Finds NOVA on the local network: the PC announces `_nova-companion._tcp` with its
// PC id in the TXT record. Used to find the paired PC again when its address changed,
// and during pairing to tell the user whether a PC with NOVA is in reach at all.
import Zeroconf from "react-native-zeroconf";

const SERVICE = { type: "nova-companion", protocol: "tcp", domain: "local." } as const;

/** The addresses of the PC with this id, or none if it didn't answer in time. */
export function discover(pcId: string, timeoutMs = 4000): Promise<string[]> {
  return new Promise((resolve) => {
    const zeroconf = new Zeroconf();
    const finish = (hosts: string[]) => {
      clearTimeout(timer);
      zeroconf.stop();
      zeroconf.removeDeviceListeners();
      resolve(hosts);
    };
    const timer = setTimeout(() => finish([]), timeoutMs);
    zeroconf.on("resolved", (service) => {
      if (service.txt?.pc === pcId && service.ipv4.length) finish(service.ipv4.map((ip) => `${ip}:${service.port}`));
    });
    zeroconf.on("error", () => finish([]));
    zeroconf.scan(SERVICE);
  });
}

/**
 * Watches for any PC running NOVA and reports each PC id once. Pairing still needs
 * the code on the PC's screen (it carries the PC's key); this only answers "is one
 * there". Returns the function that stops watching.
 */
export function watchForNova(onFound: (pcId: string) => void): () => void {
  const zeroconf = new Zeroconf();
  const seen = new Set<string>();
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    zeroconf.stop();
    zeroconf.removeDeviceListeners();
  };
  zeroconf.on("resolved", (service) => {
    const pcId = service.txt?.pc;
    if (!pcId || seen.has(pcId) || !service.ipv4.length) return;
    seen.add(pcId);
    onFound(pcId);
  });
  zeroconf.on("error", stop);
  zeroconf.scan(SERVICE);
  return stop;
}
