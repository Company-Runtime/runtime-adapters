# Contributing an adapter

Official adapters are few on purpose. Before adding one, check that the capabilities it
implements already exist in the
[registry](https://github.com/Company-Runtime/runtime-protocol/tree/main/registry): an
adapter never invents vocabulary. When a system offers something the core cannot
express, first try a profile, a trait or a recipe; otherwise implement it under
`vendor.<vendor>.*` and propose the intent through an RFC in runtime-protocol.

## Checklist

- [ ] Directory `<area>/<system>` (`ai`, `communication`, `engineering`, `storage`, …) and
      package `@runtime-protocol/adapter-<system>`, with the SDK as a peer dependency.
- [ ] Built with `defineProvider`; vendor calls go through `fetchJson` (or classify
      failures the same way: never sent → `ProviderUnreachableError`, refused →
      `ProviderFailure`, anything uncertain → a plain error).
- [ ] Credentials only through `ctx.credential()`; declared owners in `credentials.accepts`;
      the key is passed to `redact`.
- [ ] Evidence for every claim the manifest declares, from what the vendor answered or
      from state read back.
- [ ] Mutating capabilities declare `idempotency` (the vendor deduplicates by key) or
      implement `reconcile` with evidence, including a proven `failed` after a settle
      window.
- [ ] Identities are mapped through configuration (identity reference → vendor ID);
      unmapped identities are refused, never guessed.
- [ ] Tests against a simulated API: the provider harness (all of `PC-001`–`PC-010`
      pass), a run through a runtime, failure mapping, and reconciliation of a lost
      answer. No test calls a real vendor.
- [ ] A README with capabilities, profiles, traits, configuration, credentials,
      evidence and failure mapping, and a row in the root README.

`pnpm run ci` must pass. Merges are decided by humans.
