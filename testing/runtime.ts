import {
  createRuntime,
  GrantAuthority,
  InMemoryCredentialBroker,
  InMemoryEventLog,
  type Provider,
  type Runtime,
} from "@runtime-protocol/sdk";

export const AGENT = "identity://agent/support-agent";

/** A runtime that grants AGENT the given capabilities and binds one organization key. */
export function runtimeFor(
  provider: Provider,
  capabilities: string[],
  key: { ref: string; value: string },
): { runtime: Runtime; events: InMemoryEventLog } {
  const events = new InMemoryEventLog();
  const runtime = createRuntime({
    id: "adapter-test-runtime",
    providers: [provider],
    authority: new GrantAuthority([
      { id: "agent", authority: "authority://company/operations", subjects: [AGENT], capabilities },
    ]),
    credentials: {
      bindings: [{ provider: provider.manifest.provider.id, ref: key.ref }],
      broker: new InMemoryCredentialBroker({ [key.ref]: key.value }),
    },
    events,
  });
  return { runtime, events };
}
