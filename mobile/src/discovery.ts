// Finds the paired PC again on the local network when its address changed: NOVA
// announces `_nova-companion._tcp` with its PC id in the TXT record.
import Zeroconf from "react-native-zeroconf";

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
    zeroconf.scan({ type: "nova-companion", protocol: "tcp", domain: "local." });
  });
}
