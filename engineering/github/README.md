# @runtime-protocol/adapter-github

Implements `work.create`, `work.assign` and `work.complete` with GitHub issues.

```ts
import { createGitHubProvider } from "@runtime-protocol/adapter-github";

const provider = createGitHubProvider({
  repository: "acme/support",
  users: { "identity://user/ana": "ana-dev" },
});
```

| Capability      | Reconciliation | Evidence claims      |
| --------------- | -------------- | -------------------- |
| `work.create`   | supported      | `execution`, `state` |
| `work.assign`   | supported      | `execution`, `state` |
| `work.complete` | supported      | `execution`, `state` |

- **References.** Repositories are `resource://github/<owner>/<repo>` (the `container`
  of `work.create`, or the `repository` option); issues are
  `resource://github/<owner>/<repo>/issues/<number>`.
- **Mapping.** `priority` becomes the label `priority: <level>`; `due` and `parent` are
  recorded in the issue body; `assignee` maps to a login through `users` — unmapped
  identities are refused before any call. `work.complete` posts `resolution` and
  `evidence` references as a comment, then closes the issue as completed.
- **Credentials.** A token, `Authorization: Bearer` from `ctx.credential()`. Accepted
  owners: `organization`, `workload`, `user`. Works with GitHub Enterprise Server
  through `baseUrl`.
- **Evidence.** A `provider_receipt` for the created issue and `state_observation`s of
  the issue as GitHub returned it.
- **Uncertain outcomes.** GitHub has no idempotency keys, so the issue body carries a
  hidden marker with the invocation's idempotency key. Reconciliation finds the issue by
  that marker, or reads the issue's assignees or state; the absence of the change is a
  proven failure only `settleAfterMs` after the deadline.
- **Refusals.** GitHub silently ignores users who cannot be assigned; the adapter
  checks the answer and fails instead of reporting an assignment that did not happen.
