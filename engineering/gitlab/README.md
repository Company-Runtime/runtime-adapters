# @runtime-protocol/adapter-gitlab

Implements `work.create`, `work.assign` and `work.complete` with GitLab issues
(gitlab.com or self-managed through `baseUrl`).

```ts
import { createGitLabProvider } from "@runtime-protocol/adapter-gitlab";

const provider = createGitLabProvider({
  project: "acme/support",
  users: { "identity://user/ana": 101 },
});
```

| Capability      | Reconciliation | Evidence claims      |
| --------------- | -------------- | -------------------- |
| `work.create`   | supported      | `execution`, `state` |
| `work.assign`   | supported      | `execution`, `state` |
| `work.complete` | supported      | `execution`, `state` |

- **References.** Projects are `resource://gitlab/<path>` (nested groups allowed);
  issues are `resource://gitlab/<path>/issues/<iid>`.
- **Mapping.** `priority` becomes the scoped label `priority::<level>`; `due` becomes
  `due_date` (the UTC date); `parent` is recorded in the description; `assignee` maps
  to a user ID through `users`. `work.assign` adds an assignee and keeps existing ones.
  `work.complete` posts `resolution` and `evidence` references as a note, then closes
  the issue.
- **Credentials.** A personal, project or group access token, `Authorization: Bearer`
  from `ctx.credential()`. Accepted owners: `organization`, `workload`, `user`.
- **Evidence.** A `provider_receipt` for the created issue and `state_observation`s of
  the issue as GitLab returned it.
- **Uncertain outcomes.** The description carries a hidden marker with the invocation's
  idempotency key; reconciliation finds the issue by that marker, or reads assignees or
  state, and proves a failure only `settleAfterMs` after the deadline.
