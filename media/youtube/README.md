# @runtime-protocol/adapter-youtube

Implements YouTube creator work with core capabilities: uploads and comments through
`communication.publish`, and videos, thumbnails, playlists and comments through
`resource.read`, `resource.search`, `resource.create`, `resource.update` and
`resource.delete`.

```ts
import { createYouTubeProvider } from "@runtime-protocol/adapter-youtube";

const provider = createYouTubeProvider({ channel: "UCxxxxxxxxxxxxxxxxxxxxxx" });

await runtime.execute({
  capability: "communication.publish",
  profile: "broadcast",
  traits: ["attachments"],
  actor: "identity://agent/studio",
  constraints: { timeout_ms: 3_600_000 },
  input: {
    audience: "resource://youtube/UCxxxxxxxxxxxxxxxxxxxxxx",
    title: "Launch day",
    content: "Everything we shipped.",
    data: { tags: ["launch"], privacy_status: "unlisted" },
    attachments: [
      { name: "launch.mp4", media_type: "video/mp4", uri: "https://files.example.com/launch.mp4" },
    ],
  },
});
```

| Capability              | Profiles / traits                                | Reconciliation | Evidence claims      |
| ----------------------- | ------------------------------------------------ | -------------- | -------------------- |
| `communication.publish` | `broadcast`, `chat` · `attachments`, `threading` | supported      | `execution`, `state` |
| `resource.read`         |                                                  | —              | `execution`          |
| `resource.search`       |                                                  | —              | `execution`          |
| `resource.create`       |                                                  | supported      | `execution`, `state` |
| `resource.update`       |                                                  | supported      | `execution`, `state` |
| `resource.delete`       |                                                  | supported      | `execution`, `state` |

- **Options.**
  - `channel` (required): the `UC…` id of the channel the credential manages.
  - `openAttachment(uri, signal)`: how attachment URIs are opened (see Attachments).
  - `chunkSize`: upload chunk size, a multiple of 256 KiB (default 8 MiB).
  - `defaultPrivacy`: privacy of uploads and playlists that set none (default
    `private`).
  - `defaultCategory`: category of uploads that set none (default `22`).
  - `settleAfterMs`: how long after the deadline an effect's absence counts as proof
    that it did not happen (default 15 minutes).
  - `id`, `baseUrl`, `tokenUrl`, `credentials` and `fetch`, as in the other adapters.
- **References.** Everything lives under the configured channel:
  `resource://youtube/<channel>`, `…/videos/<id>`, `…/videos/<id>/thumbnail`,
  `…/playlists/<id>`, `…/playlists/<id>/items/<id>` and `…/comments/<id>`. References
  to other channels, and videos or playlists that belong to one, are refused before
  anything is changed.
- **Uploads.** `communication.publish` with the `broadcast` profile, the channel as
  `audience` and exactly one `video/*` attachment. `title` and `content` are the title
  and description. `data` holds `tags`, `category_id` (default `22`), `privacy_status`
  (default `private`), `publish_at`, `made_for_kids`, `default_language`, `embeddable`,
  `license`, `public_stats_viewable` and `notify_subscribers`.
  - The file is sent with YouTube's resumable protocol in `chunkSize` pieces (default
    8 MiB). An interrupted chunk is resumed from what YouTube holds.
  - The final chunk is sent only once the file matches its declared `size` and `digest`.
  - An upload must finish within the invocation, so set `timeout_ms`; the protocol
    allows at most one hour.
- **Attachments.** By default the adapter downloads `https:` URIs with a plain GET and
  refuses every other scheme. It never sends the YouTube credential to that host. If
  your files live elsewhere, or callers may pass untrusted URIs, pass
  `openAttachment(uri, signal)` and enforce your own allowlist there.
- **Comments.** `communication.publish` with the `chat` profile and a video as
  `audience`. With `thread` (a top-level comment, and the `threading` trait) it posts a
  reply. Content is plain text.
- **Updates.**
  - Videos and playlists take a merge `patch` or a full `content` replacement:
    - video fields are the upload `data` fields plus `title` and `description`;
    - playlist fields are `title`, `description`, `default_language` and
      `privacy_status`.
  - Playlist items take `{ position }`.
  - Comments take `text` (your own comments) and `moderation_status` (`published`,
    `held_for_review`, `rejected`, with `ban_author` when rejecting). A string
    `content` replaces the text.
  - A thumbnail is replaced with `content: { uri, media_type }` (`image/jpeg` or
    `image/png`, at most 2 MB).
- **Moderation.**
  - YouTube never reports a comment's moderation status, and it cannot read a held or
    rejected comment by id. Reading one fails with "not public".
  - Held comments are found with `resource.search` (`type: "comment"`,
    `filters: { video, moderation_status: "held_for_review" }`).
  - Moderation is sent without reading the comment first, unless `expected_version`
    is given; that needs the comment to be readable, so only public comments qualify.
  - What the adapter can observe, and reconcile on, is whether the comment is public.
    `published` means public; `held_for_review` and `rejected` mean hidden.
  - `ban_author` cannot be observed at all.
- **Versions.** `version` is a digest of a resource's editable state. `expected_version`
  is checked before writing, but YouTube has no conditional writes, so a change made
  between that check and the write can still be overwritten.
- **Create.** `type: "playlist"` (title from `content.title` or `name`) and
  `type: "playlist_item"` (`parent` playlist, `content: { video, position? }`).
- **Read and search.**
  - `resource.read` covers the channel (with statistics and its uploads playlist),
    videos (with statistics), thumbnails, playlists, items and comments.
  - `resource.search` lists `video` (the uploads, or `search.list` when there is a
    `query`), `playlist`, `playlist_item` (`filters.playlist`) and `comment`
    (`filters.video` with optional `query` and `moderation_status`, or
    `filters.parent` for replies). `moderation_status` is `published` (the default),
    `held_for_review` or `likely_spam`.
- **Credentials.** Either an access token, or a JSON OAuth grant
  `{"client_id","client_secret","refresh_token"}`. A grant is exchanged at `tokenUrl`
  once per invocation and never kept. The credential must belong to the configured
  channel, with the `youtube.upload` and `youtube.force-ssl` scopes: comments are
  reconciled by their author, so they must be posted as the configured channel.
  Accepted owners: `organization`, `workload`, `user`.
- **Getting a credential.** No billing account or Cloud trial is needed.
  1. Create a Google Cloud project and enable **YouTube Data API v3**.
  2. In **Google Auth Platform**, set the audience to _External_ and keep it in
     _Testing_. Add the channel's Google account as a test user.
  3. Under **Data access**, add both scopes.
  4. Under **Clients**, create a _Web application_ client with the redirect URI
     `https://developers.google.com/oauthplayground`. Keep its secret, since it is
     shown in full only once.
  5. In the [OAuth Playground](https://developers.google.com/oauthplayground), choose
     _Use your own OAuth credentials_ and authorize both scopes as that account,
     picking the channel when asked.
  6. Exchange the code and keep the refresh token. The response's `scope` must list
     both scopes.

  While the app is in _Testing_, refresh tokens expire after 7 days.

- **Evidence.**
  - Mutating calls return a `provider_receipt` and a `state_observation` of the
    resource as YouTube returned it.
  - Deletions and comment moderation take a moment to show. Their read back is retried
    for a few seconds, and they are observed only once YouTube shows the result.
  - When a request requires `state` and the change is not visible yet, the outcome is
    `unknown` and reconciliation settles it.
- **Uncertain outcomes.**
  - Uploads carry a hidden marker tag (`rpk-…`, derived from the idempotency key).
    Reconciliation looks for it among the channel's recent uploads. Reads never show
    it, and later tag edits keep it.
  - Comments are matched by author, text and time.
  - New playlists are matched by title, description and time; new items by video and
    time. When more than one candidate matches, the outcome stays inconclusive.
  - Updates and deletions are reconciled by reading the resource. Tags are compared
    as sets, and moderation by whether the comment is public.
  - A thumbnail's source image cannot be read back, so an uncertain thumbnail update
    stays unknown.
  - Absence becomes a proven failure only `settleAfterMs` after the deadline
    (default 15 minutes).
- **Failures.**
  - A quota or rate-limit refusal (`quotaExceeded`, `rateLimitExceeded`, …) is a
    retryable `provider_unavailable`.
  - 401 is `credential_unavailable`.
  - Other refusals are `execution_failed`.
  - 5xx answers and interruptions after sending are `unknown`, except during an upload
    before its final chunk: no video exists yet, so those fail with a retryable
    `provider_unavailable`.
- **Quota.** Most calls cost one unit. Text search (`search.list`) costs 100, and an
  upload costs far more, so prefer listing over searching.
- **Propagation.** Seen on a real channel:
  - New uploads take seconds to a minute to appear in the uploads list.
  - Tag changes take 10–30 seconds to show; YouTube keeps tags sorted, so views list
    them sorted.
  - Deleted playlists and items can be listed for a second or two longer.
  - A published comment becomes readable within a second. A held one stays readable
    for more than six seconds.
  - New replies are listed under their comment a few seconds after posting.
- **Smoke test.** [`scripts/smoke.ts`](scripts/smoke.ts) runs the adapter against a real
  channel. It is not part of CI. Everything it creates is private and deleted at the
  end. Set `RUNTIME_SECRET_ORGANIZATION_PROVIDERS_YOUTUBE` and `YOUTUBE_CHANNEL`, then
  run `node media/youtube/scripts/smoke.ts <video.mp4> [thumbnail]`. Comments need a
  public or unlisted video, so set `YOUTUBE_SMOKE_COMMENT_VIDEO` to one already on the
  channel.
- **Unverified apps.** YouTube says videos uploaded through an API project that has not
  passed its audit are restricted to private. On a test channel an unlisted upload
  stayed unlisted, but check `privacy_status` with `resource.read` rather than
  assuming. Custom thumbnails also need a phone-verified channel; without one, YouTube
  refuses them with HTTP 403.
- **Not declared.**
  - Liking comments: the YouTube API has no way to do it.
  - Rating videos (`videos.rate`), captions, live streams, community posts, channel
    settings and the YouTube Analytics API.
