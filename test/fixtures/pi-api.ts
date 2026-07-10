import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function captureProviderRegistration() {
  const registrations: Array<{ name: string; config: Record<string, unknown> }> = [];
  const pi = {
    registerProvider(name: string, config: Record<string, unknown>) {
      registrations.push({ name, config });
    },
  } as unknown as ExtensionAPI;
  return { pi, registrations };
}
