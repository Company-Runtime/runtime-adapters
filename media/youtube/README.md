# @runtime-protocol/adapter-youtube

Implements YouTube creator work with core capabilities: uploads and comments through
`communication.publish`, and videos, thumbnails, playlists and comments through
`resource.read`, `resource.search`, `resource.create`, `resource.update` and
`resource.delete`.

```ts
import { createYouTubeProvider } from "@runtime-protocol/adapter-youtube";

const provider = createYouTubeProvider({
  channel: "UCxxxxxxxxxxxxxxxxxxxxxx",
  attachmentHosts: ["files.example.com"],
});

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
  - `attachmentHosts`: hosts the default opener may download attachments from (see
    Attachments). Without it, and without `openAttachment`, nothing is downloaded.
  - `openAttachment(uri, signal)`: how attachment URIs are opened, instead of the
    default opener.
  - `chunkSize`: upload chunk size, a multiple of 256 KiB (default 8 MiB).
  - `defaultPrivacy`: privacy of uploads and playlists that set none (default
    `private`).
  - `defaultCategory`: category of uploads that set none (default `22`).
  - `settleAfterMs`: how long after the deadline an effect's absence counts as proof
    that it did not happen (default 15 minutes).
  - `id`, `baseUrl`, `tokenUrl`, `credentials` and `fetch`, as in the other adapters.
- **References.** Everything lives under the configured channel:
  `resource://youtube/<channel>`, `…/videos/<id>`, `…/videos/<id>/thumbnail`,
  `…/videos/<id>/comments/<id>`, `…/playlists/<id>` and `…/playlists/<id>/items/<id>`.
  - References to other channels are refused before any call.
  - A reference only names a resource, so ownership is read before anything is done:
    videos, playlists and items must belong to the channel.
  - A comment must be on a video of the channel, in a thread on that video.
  - Videos added to a playlist are the one exception: they may come from any channel.
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
- **Attachments.** Uploads and thumbnails take an attachment URI.
  - By default the adapter downloads it with a plain GET, and only over `https:` from
    the hosts in `attachmentHosts`. Redirects are followed by hand, at most five, and
    every hop is held to the same rules. With no hosts, nothing is downloaded.
  - The YouTube credential is never sent to those hosts.
  - For files kept elsewhere (a store, a local disk), pass `openAttachment(uri, signal)`.
- **Network.** The adapter contacts `www.googleapis.com`, `oauth2.googleapis.com` (only
  for OAuth grants) and the `attachmentHosts`; declare those as egress.
- **Comments.** A comment is a message in a thread: `communication.publish` with the
  `chat` profile and the `threading` trait, the video as `audience`, and as `thread`:
  - the video itself, for a top-level comment;
  - a top-level comment on that video, for a reply.

  Content is plain text. The video's owner is read before posting, and a reply's parent
  must be on that video.

- **Updates.**
  - Videos and playlists take a merge `patch` or a full `content` replacement:
    - video fields are the upload `data` fields plus `title` and `description`;
    - playlist fields are `title`, `description`, `default_language` and
      `privacy_status`.
  - Playlist items take `{ position }`.
  - Comments take `text` (your own comments) and `moderation_status` (`published`,
    `held_for_review` or `rejected`). A string `content` replaces the text. Banning a
    comment's author is not supported: it is an action whose result cannot be read.
  - A thumbnail is replaced with `content: { uri, media_type }` (`image/jpeg` or
    `image/png`, at most 2 MB).
- **Moderation.**
  - YouTube never reports a comment's moderation status, and it cannot read a held or
    rejected comment by id. Reading one fails with "not public".
  - Held comments are found with `resource.search` (`type: "comment"`,
    `filters: { video, moderation_status: "held_for_review" }`).
  - Moderation checks that the video is the channel's, since YouTube lets only its
    owner moderate. It reads the comment first only for `expected_version`, which
    therefore needs a public comment.
  - Moderation is observed, and reconciled, from what YouTube lists for the video:
    - `published` is proven by the comment being readable;
    - `held_for_review` by it being in the held list;
    - `rejected` by it being neither readable nor in the held or likely-spam lists.
  - Replies are not listed by moderation status, so their moderation stays unobserved.
  - Comments that are not public cannot be read, edited or deleted through the adapter;
    reject them instead.
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
  once per invocation and never kept. It needs the `youtube.upload` and
  `youtube.force-ssl` scopes. Accepted owners: `organization`, `workload`, `user`.
  - It must manage the configured channel. Once per invocation the adapter reads the
    credential's channel (`channels.list?mine=true`, one quota unit) and refuses any
    other with `credential_unavailable`.
  - Otherwise effects would land on another channel while references and
    reconciliation name this one.
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
  - Uploads are searched back to the earliest moment the invocation could have run.
    When there are too many recent uploads to read, the outcome stays inconclusive and
    is never reported as failed.
  - Updates and deletions are reconciled by reading the resource. Tags are compared
    as sets, and moderation as described under Moderation.
  - A thumbnail's source image cannot be read back, so an uncertain thumbnail update
    stays unknown.
  - Absence becomes a proven failure only `settleAfterMs` after the deadline
    (default 15 minutes).
- **Failures.**
  - A quota or rate-limit refusal (`quotaExceeded`, `rateLimitExceeded`, …) is a
    retryable `provider_unavailable`.
  - 401 is `credential_unavailable`.
  - Other refusals are `execution_failed`.
  - 5xx answers and interruptions after sending are `unknown`, with one exception. An
    upload interrupted before its final chunk has created nothing, since YouTube makes
    no video until the last byte arrives. It fails with a retryable `execution_failed`.
    The same goes for an OAuth exchange that went wrong.
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
