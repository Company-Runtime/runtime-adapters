# Changelog

## Unreleased — 0.1.0

First official adapters for Runtime Protocol `runtime/0.1`:

- `@runtime-protocol/adapter-openai` — `reasoning.generate` (conversational profile,
  structured output) and `reasoning.classify` (batch) on OpenAI-compatible APIs.
- `@runtime-protocol/adapter-anthropic` — the same capabilities on the Anthropic
  Messages API.
- `@runtime-protocol/adapter-slack` — `communication.send` (chat profile, delivery
  receipts, markdown, threads) with reconciliation from message metadata.
- `@runtime-protocol/adapter-github` and `@runtime-protocol/adapter-gitlab` —
  `work.create`, `work.assign` and `work.complete` on issues, with reconciliation.
- `@runtime-protocol/adapter-youtube` — `communication.publish` (broadcast uploads with
  resumable chunks, chat comments and replies) and `resource.read`, `search`, `create`,
  `update` and `delete` on videos, thumbnails, playlists and comments, with
  reconciliation.
- Simulated vendor APIs for tests, the provider harness for every adapter, and
  substitution tests across interchangeable adapters.
