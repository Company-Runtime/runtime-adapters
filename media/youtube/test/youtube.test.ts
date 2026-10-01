import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyReceipt, type Json } from "@runtime-protocol/sdk";
import { runProviderHarness } from "@runtime-protocol/sdk/conformance";
import { createYouTubeProvider, type YouTubeProviderOptions } from "../src/index.ts";
import type { Invocation } from "@runtime-protocol/sdk";
import { AGENT, runtimeFor } from "../../../testing/runtime.ts";
import {
  CHANNEL,
  CHANNEL_REF,
  CLIP,
  CLIP_DIGEST,
  FOREIGN,
  GRANT,
  GRANT_KEY,
  KEY,
  memoryAttachments,
  PNG,
  ref,
  SEED,
  youtube,
  type Override,
} from "./fake-youtube.ts";
import type { FakeRequest } from "../../../testing/fake-api.ts";

const CAPABILITIES = [
  "communication.publish",
  "resource.read",
  "resource.search",
  "resource.create",
  "resource.update",
  "resource.delete",
];
const CHUNK = 256 * 1024;

function setup(
  options: {
    delayMs?: number;
    override?: (request: FakeRequest) => Override | undefined;
    key?: { ref: string; value: string };
    provider?: Partial<YouTubeProviderOptions>;
  } = {},
) {
  const api = youtube({
    ...(options.delayMs ? { delayMs: options.delayMs } : {}),
    ...(options.override ? { override: options.override } : {}),
  });
  const provider = createYouTubeProvider({
    channel: CHANNEL,
    chunkSize: CHUNK,
    openAttachment: memoryAttachments,
    fetch: api.fetch,
    ...options.provider,
  });
  const { runtime, events } = runtimeFor(provider, CAPABILITIES, options.key ?? KEY);
  return { api, provider, runtime, events };
}

const upload = (extra: Json = {}) => ({
  capability: "communication.publish",
  profile: "broadcast",
  traits: ["attachments"],
  actor: AGENT,
  input: {
    audience: CHANNEL_REF,
    title: "Launch day",
    content: "Everything we shipped.",
    attachments: [
      { name: "launch.mp4", media_type: "video/mp4", uri: "https://media.example.com/clip.mp4" },
    ],
    ...extra,
  },
});

const chunkPuts = (calls: FakeRequest[]) =>
  calls.filter((c) => c.method === "PUT" && c.url.pathname === "/upload/youtube/v3/videos");

const leaks = (value: unknown, secrets: string[]) =>
  secrets.filter((s) => JSON.stringify(value).includes(s));

test("the YouTube adapter meets every provider requirement", async () => {
  const { provider } = setup({ delayMs: 20 });
  const credential = KEY;
  const mutating = { credential, abortAfterMs: 5 };
  const report = await runProviderHarness(provider, [
    {
      capability: "communication.publish",
      profile: "broadcast",
      traits: ["attachments"],
      input: upload().input,
      ...mutating,
    },
    {
      capability: "communication.publish",
      profile: "chat",
      traits: ["threading"],
      input: {
        audience: ref.video(SEED.video),
        thread: ref.video(SEED.video),
        content: "Thanks for watching!",
      },
      ...mutating,
    },
    {
      capability: "communication.publish",
      profile: "chat",
      traits: ["threading"],
      input: {
        audience: ref.video(SEED.video),
        thread: ref.comment(SEED.video, SEED.comment),
        content: "Glad you liked it.",
      },
      ...mutating,
    },
    { capability: "resource.read", input: { resource: ref.video(SEED.video) }, credential },
    { capability: "resource.read", input: { resource: CHANNEL_REF }, credential },
    { capability: "resource.search", input: { type: "video" }, credential },
    {
      capability: "resource.search",
      input: { type: "comment", filters: { video: ref.video(SEED.video) } },
      credential,
    },
    {
      capability: "resource.create",
      input: { type: "playlist", parent: CHANNEL_REF, content: { title: "Harness picks" } },
      ...mutating,
    },
    {
      capability: "resource.update",
      input: { resource: ref.video(SEED.video), patch: { title: "Seed video, remastered" } },
      ...mutating,
    },
    {
      capability: "resource.update",
      input: {
        resource: ref.comment(SEED.video, SEED.comment),
        patch: { moderation_status: "held_for_review" },
      },
      ...mutating,
    },
    {
      capability: "resource.update",
      input: {
        resource: ref.thumbnail(SEED.video),
        content: { uri: "https://media.example.com/thumb.png", media_type: "image/png" },
      },
      ...mutating,
    },
    {
      capability: "resource.delete",
      input: { resource: ref.item(SEED.playlist, SEED.spare) },
      ...mutating,
    },
  ]);
  assert.deepEqual(
    report.requirements.filter((r) => !r.passed),
    [],
  );
});

test("an upload is sent in resumable chunks, with the marker tag hidden from reads", async () => {
  const { api, runtime, events } = setup();
  const outcome = await runtime.execute({
    ...upload({
      data: {
        tags: ["launch"],
        privacy_status: "unlisted",
        made_for_kids: false,
        notify_subscribers: false,
      },
      attachments: [
        {
          name: "launch.mp4",
          media_type: "video/mp4",
          uri: "https://media.example.com/clip.mp4",
          size: CLIP.length,
          digest: CLIP_DIGEST,
        },
      ],
    }),
    idempotency_key: "launch-1",
    evidence: ["execution", "state"],
  });
  assert.equal(outcome.execution.state, "completed", JSON.stringify(outcome.error));
  const publication = (outcome.execution.output as Json)["publication"] as Json;
  const id = api.uploads[0]!;
  assert.equal(publication["ref"], ref.video(id));
  const video = api.videos.get(id)!;
  assert.equal(video["snippet"]["title"], "Launch day");
  assert.equal(video["snippet"]["description"], "Everything we shipped.");
  assert.equal(video["status"]["privacyStatus"], "unlisted");
  assert.equal(video["status"]["selfDeclaredMadeForKids"], false);
  assert.equal(video["snippet"]["categoryId"], "22");
  assert.equal(video["snippet"]["tags"][0], "launch");
  assert.match(video["snippet"]["tags"][1], /^rpk-[0-9a-f]{24}$/, "YouTube keeps tags sorted");
  const init = api.calls.find(
    (c) => c.method === "POST" && c.url.pathname === "/upload/youtube/v3/videos",
  )!;
  assert.equal(init.url.searchParams.get("notifySubscribers"), "false");
  assert.equal(init.headers.get("x-upload-content-length"), String(CLIP.length));
  const puts = chunkPuts(api.calls);
  assert.deepEqual(
    puts.map((c) => c.headers.get("content-range")),
    [
      `bytes 0-${CHUNK - 1}/${CLIP.length}`,
      `bytes ${CHUNK}-${2 * CHUNK - 1}/${CLIP.length}`,
      `bytes ${2 * CHUNK}-${CLIP.length - 1}/${CLIP.length}`,
    ],
  );
  assert.ok(outcome.receipt && verifyReceipt(outcome.receipt));
  assert.equal(events.ofType("communication.published").length, 1);
  const evidence = await runtime.listEvidence(outcome.execution.execution_id);
  assert.deepEqual(
    evidence.map((e) => e.claims),
    [["execution"], ["state"]],
  );

  const read = await runtime.execute({
    capability: "resource.read",
    actor: AGENT,
    input: { resource: ref.video(id) },
  });
  assert.equal(read.execution.state, "completed", JSON.stringify(read.error));
  const content = (read.execution.output as Json)["content"] as Json;
  assert.deepEqual(content["tags"], ["launch"]);
  assert.equal(content["thumbnail"], ref.thumbnail(id));
  assert.deepEqual(leaks([outcome, read, evidence, events.events], [KEY.value]), []);
});

test("an OAuth grant is exchanged once per invocation and never leaks", async () => {
  const { api, runtime, events } = setup({ key: GRANT_KEY });
  const outcome = await runtime.execute({
    capability: "resource.read",
    actor: AGENT,
    input: { resource: CHANNEL_REF },
  });
  assert.equal(outcome.execution.state, "completed", JSON.stringify(outcome.error));
  const content = (outcome.execution.output as Json)["content"] as Json;
  assert.equal(content["uploads"], ref.playlist("UUcreator"));
  assert.equal(api.oauth.calls.length, 1);
  assert.equal(
    api.oauth.calls[0]!.headers.get("content-type"),
    "application/x-www-form-urlencoded",
  );
  assert.deepEqual(
    leaks(
      [outcome, events.events],
      [GRANT.client_secret, GRANT.refresh_token, KEY.value, GRANT_KEY.value],
    ),
    [],
  );

  const revoked = setup({
    key: { ref: KEY.ref, value: JSON.stringify({ ...GRANT, refresh_token: "revoked-grant-0000" }) },
  });
  const refused = await revoked.runtime.execute({
    capability: "resource.read",
    actor: AGENT,
    input: { resource: CHANNEL_REF },
  });
  assert.equal(refused.execution.state, "failed");
  assert.equal(refused.error?.code, "credential_unavailable");
  assert.equal(revoked.api.calls.length, 0, "YouTube is never called without a token");
  assert.deepEqual(leaks(refused, ["revoked-grant-0000", GRANT.client_secret]), []);
});

test("comments, replies, edits and moderation", async () => {
  const { api, runtime } = setup();
  const posted = await runtime.execute({
    capability: "communication.publish",
    profile: "chat",
    traits: ["threading"],
    actor: AGENT,
    input: {
      audience: ref.video(SEED.video),
      thread: ref.video(SEED.video),
      content: "New video on Friday.",
    },
  });
  assert.equal(posted.execution.state, "completed", JSON.stringify(posted.error));
  const mine = String(((posted.execution.output as Json)["publication"] as Json)["ref"]);
  const mineId = mine.split("/").at(-1)!;
  assert.equal(mine, ref.comment(SEED.video, mineId));
  assert.equal(api.comments.get(mineId)!["snippet"]["textOriginal"], "New video on Friday.");

  const reply = await runtime.execute({
    capability: "communication.publish",
    profile: "chat",
    traits: ["threading"],
    actor: AGENT,
    input: {
      audience: ref.video(SEED.video),
      thread: ref.comment(SEED.video, SEED.comment),
      content: "Thank you!",
    },
  });
  assert.equal(reply.execution.state, "completed", JSON.stringify(reply.error));
  const replyId = String(((reply.execution.output as Json)["publication"] as Json)["ref"])
    .split("/")
    .at(-1)!;
  assert.equal(api.comments.get(replyId)!["snippet"]["parentId"], SEED.comment);

  const edited = await runtime.execute({
    capability: "resource.update",
    actor: AGENT,
    input: { resource: mine, content: "New video on Saturday." },
  });
  assert.equal(edited.execution.state, "completed", JSON.stringify(edited.error));
  assert.equal(api.comments.get(mineId)!["snippet"]["textOriginal"], "New video on Saturday.");

  const replies = await runtime.execute({
    capability: "resource.search",
    actor: AGENT,
    input: { type: "comment", filters: { parent: ref.comment(SEED.video, SEED.comment) } },
  });
  assert.equal(replies.execution.state, "completed", JSON.stringify(replies.error));
  assert.deepEqual((replies.execution.output as Json)["items"], [
    { ref: ref.comment(SEED.video, replyId), type: "comment", snippet: "Thank you!" },
  ]);

  const rejected = await runtime.execute({
    capability: "resource.update",
    actor: AGENT,
    input: {
      resource: ref.comment(SEED.video, SEED.comment),
      patch: { moderation_status: "rejected" },
    },
    evidence: ["execution", "state"],
  });
  assert.equal(rejected.execution.state, "completed", JSON.stringify(rejected.error));
  const moderation = api.calls.find((c) => c.url.pathname.endsWith("/setModerationStatus"))!;
  assert.equal(moderation.url.searchParams.get("moderationStatus"), "rejected");
  assert.equal(moderation.url.searchParams.has("banAuthor"), false);
  const proof = await runtime.listEvidence(rejected.execution.execution_id);
  assert.deepEqual(proof.at(-1)!.data, { public: false, awaiting_review: false });

  const banned = await runtime.execute({
    capability: "resource.update",
    actor: AGENT,
    input: { resource: mine, patch: { ban_author: true } },
  });
  assert.equal(banned.execution.state, "failed");
  assert.match(String(banned.error?.message), /ban_author is not an editable field/);
});

test("video metadata is patched against the version that was read", async () => {
  const { api, runtime } = setup();
  const read = await runtime.execute({
    capability: "resource.read",
    actor: AGENT,
    input: { resource: ref.video(SEED.video) },
  });
  const version = String(((read.execution.output as Json)["resource"] as Json)["version"]);
  assert.match(version, /^sha256:[0-9a-f]{64}$/);

  const patched = await runtime.execute({
    capability: "resource.update",
    actor: AGENT,
    input: {
      resource: ref.video(SEED.video),
      patch: { description: "Now with chapters.", tags: ["seed", "chapters"], publish_at: null },
      expected_version: version,
    },
    evidence: ["execution", "state"],
  });
  assert.equal(patched.execution.state, "completed", JSON.stringify(patched.error));
  const video = api.videos.get(SEED.video)!;
  assert.equal(video["snippet"]["description"], "Now with chapters.");
  assert.equal(
    video["snippet"]["title"],
    "Seed video",
    "fields outside the patch are carried over",
  );
  assert.equal(video["snippet"]["categoryId"], "22");
  assert.equal(video["status"]["license"], "youtube");
  const next = String(((patched.execution.output as Json)["resource"] as Json)["version"]);
  assert.notEqual(next, version);

  const stale = await runtime.execute({
    capability: "resource.update",
    actor: AGENT,
    input: {
      resource: ref.video(SEED.video),
      patch: { title: "Overwritten" },
      expected_version: version,
    },
  });
  assert.equal(stale.execution.state, "failed");
  assert.match(String(stale.error?.message), /changed/);
  assert.equal(video["snippet"]["title"], "Seed video");

  const replaced = await runtime.execute({
    capability: "resource.update",
    actor: AGENT,
    input: {
      resource: ref.video(SEED.video),
      content: { title: "Seed", category_id: "27", privacy_status: "private" },
      expected_version: next,
    },
  });
  assert.equal(replaced.execution.state, "completed", JSON.stringify(replaced.error));
  assert.equal(video["snippet"]["description"], "", "a replacement clears what it leaves out");
  assert.deepEqual(video["snippet"]["tags"], []);
  assert.equal(video["status"]["privacyStatus"], "private");
});

test("thumbnails are fetched over https and set from their bytes", async () => {
  const { api, runtime } = setup({
    provider: { openAttachment: undefined, attachmentHosts: ["media.example.com"] },
  });
  const outcome = await runtime.execute({
    capability: "resource.update",
    actor: AGENT,
    input: {
      resource: ref.thumbnail(SEED.video),
      content: { uri: "https://media.example.com/thumb.png", media_type: "image/png" },
    },
  });
  assert.equal(outcome.execution.state, "completed", JSON.stringify(outcome.error));
  assert.deepEqual(api.thumbnails.get(SEED.video), PNG);
  assert.equal(api.media.calls.length, 1);
  assert.equal(
    api.media.calls[0]!.headers.get("authorization"),
    null,
    "no credential leaves for the media host",
  );
  const set = api.calls.find((c) => c.url.pathname === "/upload/youtube/v3/thumbnails/set")!;
  assert.equal(set.headers.get("content-type"), "image/png");

  const local = await runtime.execute({
    capability: "resource.update",
    actor: AGENT,
    input: {
      resource: ref.thumbnail(SEED.video),
      content: { uri: "file:///etc/passwd", media_type: "image/png" },
    },
  });
  assert.equal(local.execution.state, "failed");
  assert.match(String(local.error?.message), /https only/);

  const thumbnail = (uri: string) =>
    runtime.execute({
      capability: "resource.update",
      actor: AGENT,
      input: { resource: ref.thumbnail(SEED.video), content: { uri, media_type: "image/png" } },
    });
  const moved = await thumbnail("https://media.example.com/moved.png");
  assert.equal(moved.execution.state, "completed", JSON.stringify(moved.error));
  const downgraded = await thumbnail("https://media.example.com/to-http.png");
  assert.match(String(downgraded.error?.message), /https only/);
  const elsewhere = await thumbnail("https://media.example.com/to-elsewhere.png");
  assert.match(String(elsewhere.error?.message), /not downloaded from internal\.example\.net/);

  const closed = setup({ provider: { openAttachment: undefined } });
  const refused = await closed.runtime.execute({
    capability: "resource.update",
    actor: AGENT,
    input: {
      resource: ref.thumbnail(SEED.video),
      content: { uri: "https://media.example.com/thumb.png", media_type: "image/png" },
    },
  });
  assert.match(String(refused.error?.message), /attachmentHosts/);
  assert.equal(closed.api.media.calls.length, 0);
});

test("playlists: create, add, reorder, list and remove items", async () => {
  const { api, runtime } = setup();
  const created = await runtime.execute({
    capability: "resource.create",
    actor: AGENT,
    input: {
      type: "playlist",
      parent: CHANNEL_REF,
      name: "Best of",
      content: { description: "Favourites." },
    },
  });
  assert.equal(created.execution.state, "completed", JSON.stringify(created.error));
  const playlist = String(((created.execution.output as Json)["resource"] as Json)["ref"]);
  const playlistId = playlist.split("/").at(-1)!;
  assert.equal(api.playlists.get(playlistId)!["snippet"]["title"], "Best of");
  assert.equal(api.playlists.get(playlistId)!["status"]["privacyStatus"], "private");

  const add = (position?: number) =>
    runtime.execute({
      capability: "resource.create",
      actor: AGENT,
      input: {
        type: "playlist_item",
        parent: playlist,
        content: { video: ref.video(SEED.video), ...(position !== undefined ? { position } : {}) },
      },
    });
  const first = await add();
  const second = await add(0);
  assert.equal(first.execution.state, "completed", JSON.stringify(first.error));
  assert.equal(second.execution.state, "completed", JSON.stringify(second.error));
  const firstRef = String(((first.execution.output as Json)["resource"] as Json)["ref"]);
  assert.match(firstRef, new RegExp(`^${playlist}/items/PLI`));

  const moved = await runtime.execute({
    capability: "resource.update",
    actor: AGENT,
    input: { resource: firstRef, patch: { position: 0 } },
  });
  assert.equal(moved.execution.state, "completed", JSON.stringify(moved.error));
  const listed = await runtime.execute({
    capability: "resource.search",
    actor: AGENT,
    input: { type: "playlist_item", filters: { playlist } },
  });
  const listedItems = (listed.execution.output as Json)["items"] as Json[];
  assert.equal(listedItems[0]!["ref"], firstRef);

  const removed = await runtime.execute({
    capability: "resource.delete",
    actor: AGENT,
    input: { resource: firstRef },
    evidence: ["execution", "state"],
  });
  assert.equal(removed.execution.state, "completed", JSON.stringify(removed.error));
  assert.equal(api.items.has(firstRef.split("/").at(-1)!), false);
});

test("search: uploads, text search and comments awaiting review", async () => {
  const { api, runtime } = setup();
  api.comments.get(SEED.comment)!["snippet"]["moderationStatus"] = "heldForReview";
  const uploads = await runtime.execute({
    capability: "resource.search",
    actor: AGENT,
    input: { type: "video", limit: 10 },
  });
  assert.deepEqual((uploads.execution.output as Json)["items"], [
    { ref: ref.video(SEED.video), type: "video", title: "Seed video", snippet: "The first video." },
  ]);
  const text = await runtime.execute({
    capability: "resource.search",
    actor: AGENT,
    input: { query: "Seed" },
  });
  assert.equal(((text.execution.output as Json)["items"] as Json[]).length, 1);
  assert.equal(api.calls.at(-1)!.url.searchParams.get("forMine"), "true");
  const held = await runtime.execute({
    capability: "resource.search",
    actor: AGENT,
    input: {
      type: "comment",
      filters: { video: ref.video(SEED.video), moderation_status: "held_for_review" },
    },
  });
  assert.deepEqual((held.execution.output as Json)["items"], [
    { ref: ref.comment(SEED.video, SEED.comment), type: "comment", snippet: "Great video!" },
  ]);
});

test("deleting a video observes that it is gone", async () => {
  const { api, runtime } = setup();
  const outcome = await runtime.execute({
    capability: "resource.delete",
    actor: AGENT,
    input: { resource: ref.video(SEED.video), reason: "Re-uploaded." },
    evidence: ["execution", "state"],
  });
  assert.equal(outcome.execution.state, "completed", JSON.stringify(outcome.error));
  assert.equal(api.videos.has(SEED.video), false);
  const evidence = await runtime.listEvidence(outcome.execution.execution_id);
  assert.deepEqual(
    evidence.map((e) => e.data),
    [{ id: SEED.video, status: 204 }, { found: false }],
  );
});

test("failures map to what they prove about effects", async () => {
  const wrong = setup({ key: { ref: KEY.ref, value: "canary-wrong-token-0000" } });
  const read = {
    capability: "resource.read",
    actor: AGENT,
    input: { resource: ref.video(SEED.video) },
  };
  const unauthorized = await wrong.runtime.execute(read);
  assert.equal(unauthorized.error?.code, "credential_unavailable");
  assert.deepEqual(leaks(unauthorized, ["canary-wrong-token-0000"]), []);

  const quota = setup({
    override: () => ({
      before: {
        status: 403,
        body: {
          error: {
            code: 403,
            message: "The request cannot be completed because you have exceeded your quota.",
            errors: [{ reason: "quotaExceeded" }],
          },
        },
      },
    }),
  });
  const limited = await quota.runtime.execute(read);
  assert.equal(limited.execution.state, "failed");
  assert.equal(limited.error?.code, "provider_unavailable");
  assert.equal(limited.error?.retryable, true);

  const { api, runtime } = setup();
  const missing = await runtime.execute({ ...read, input: { resource: ref.video("nope") } });
  assert.equal(missing.execution.state, "failed");
  assert.match(String(missing.error?.message), /does not exist/);

  const before = api.calls.length;
  const foreign = await runtime.execute({
    ...read,
    input: { resource: "resource://youtube/UCsomeoneelse/videos/x" },
  });
  assert.equal(foreign.execution.state, "failed");
  assert.match(String(foreign.error?.message), /not on the YouTube channel/);
  const audio = await runtime.execute(
    upload({
      attachments: [
        { name: "a.mp3", media_type: "audio/mpeg", uri: "https://media.example.com/a.mp3" },
      ],
    }),
  );
  assert.equal(audio.execution.state, "failed");
  assert.equal(api.calls.length, before, "refusals are made before any call");

  api.down = true;
  const down = await runtime.execute(read);
  assert.equal(down.error?.code, "provider_unavailable");
});

test("a digest mismatch publishes nothing: the final chunk is never sent", async () => {
  const { api, runtime } = setup();
  const outcome = await runtime.execute(
    upload({
      attachments: [
        {
          name: "launch.mp4",
          media_type: "video/mp4",
          uri: "https://media.example.com/clip.mp4",
          digest: `sha256:${"0".repeat(64)}`,
        },
      ],
    }),
  );
  assert.equal(outcome.execution.state, "failed");
  assert.match(String(outcome.error?.message), /digest/);
  assert.equal(chunkPuts(api.calls).length, 2);
  assert.equal(api.uploads.length, 1, "only the seed video exists");
});

test("an interrupted chunk is resumed from what YouTube holds", async () => {
  let dropped = false;
  const { api, runtime } = setup({
    override: (r) => {
      if (
        !dropped &&
        r.method === "PUT" &&
        r.headers.get("content-range")?.startsWith(`bytes ${CHUNK}-`)
      ) {
        dropped = true;
        return { after: { drop: true } };
      }
      return undefined;
    },
  });
  const outcome = await runtime.execute(upload());
  assert.equal(outcome.execution.state, "completed", JSON.stringify(outcome.error));
  const ranges = chunkPuts(api.calls).map((c) => c.headers.get("content-range"));
  assert.deepEqual(ranges, [
    `bytes 0-${CHUNK - 1}/${CLIP.length}`,
    `bytes ${CHUNK}-${2 * CHUNK - 1}/${CLIP.length}`,
    `bytes */${CLIP.length}`,
    `bytes ${2 * CHUNK}-${CLIP.length - 1}/${CLIP.length}`,
  ]);
  assert.equal(api.uploads.length, 2);
});

test("a lost upload answer is reconciled from the marker tag without re-uploading", async () => {
  let drop = true;
  const { api, runtime } = setup({
    override: (r) =>
      drop &&
      r.method === "PUT" &&
      r.headers.get("content-range")?.startsWith(`bytes ${2 * CHUNK}-`)
        ? { after: { drop: true } }
        : undefined,
  });
  const request = { ...upload(), request_id: "req_launch" };
  const first = await runtime.execute(request);
  assert.equal(first.execution.state, "unknown");
  assert.equal(api.uploads.length, 2, "the video exists; only the answer was lost");
  drop = false;
  const settled = await runtime.reconcile(first.execution.execution_id);
  assert.equal(settled.execution.state, "completed", JSON.stringify(settled.error));
  const publication = (settled.execution.output as Json)["publication"] as Json;
  assert.equal(publication["ref"], ref.video(api.uploads[0]!));
  assert.equal(api.uploads.length, 2);
  assert.equal(chunkPuts(api.calls).length, 3);
});

test("lost comment and playlist answers are reconciled without repeating them", async () => {
  let drop = true;
  const { api, runtime } = setup({
    override: (r) =>
      drop && r.method === "POST" && /\/(commentThreads|playlists)$/.test(r.url.pathname)
        ? { after: { drop: true } }
        : undefined,
  });
  const comment = await runtime.execute({
    capability: "communication.publish",
    profile: "chat",
    actor: AGENT,
    traits: ["threading"],
    input: {
      audience: ref.video(SEED.video),
      thread: ref.video(SEED.video),
      content: "Pinned: links below.",
    },
  });
  const playlist = await runtime.execute({
    capability: "resource.create",
    actor: AGENT,
    input: { type: "playlist", content: { title: "Tutorials" } },
  });
  assert.equal(comment.execution.state, "unknown");
  assert.equal(playlist.execution.state, "unknown");
  drop = false;
  const commentSettled = await runtime.reconcile(comment.execution.execution_id);
  const playlistSettled = await runtime.reconcile(playlist.execution.execution_id);
  assert.equal(commentSettled.execution.state, "completed", JSON.stringify(commentSettled.error));
  assert.equal(playlistSettled.execution.state, "completed", JSON.stringify(playlistSettled.error));
  assert.equal(
    [...api.comments.values()].filter(
      (c) => c["snippet"]["textOriginal"] === "Pinned: links below.",
    ).length,
    1,
  );
  assert.equal(
    [...api.playlists.values()].filter((p) => p["snippet"]["title"] === "Tutorials").length,
    1,
  );
});

test("reconciliation proves an upload absent only after the settle window", async () => {
  const failing = (r: FakeRequest): Override | undefined =>
    r.method === "PUT" && r.headers.get("content-range")?.startsWith(`bytes ${2 * CHUNK}-`)
      ? { before: { status: 502, body: {} } }
      : undefined;
  const pending = setup({ override: failing });
  const unknown = await pending.runtime.execute(upload());
  assert.equal(unknown.execution.state, "unknown");
  assert.equal(
    (await pending.runtime.reconcile(unknown.execution.execution_id)).execution.state,
    "unknown",
  );

  const settled = setup({ override: failing, provider: { settleAfterMs: -60_000 } });
  const second = await settled.runtime.execute(upload());
  assert.equal(second.execution.state, "unknown");
  const final = await settled.runtime.reconcile(second.execution.execution_id);
  assert.equal(final.execution.state, "failed");
  assert.equal(final.error?.detail, "reconciled_not_applied");
});

test("a lost tag patch is reconciled although YouTube sorts tags", async () => {
  let drop = true;
  const { api, runtime } = setup({
    override: (r) =>
      drop && r.method === "PUT" && r.url.pathname === "/youtube/v3/videos"
        ? { after: { drop: true } }
        : undefined,
  });
  const patched = await runtime.execute({
    capability: "resource.update",
    actor: AGENT,
    input: { resource: ref.video(SEED.video), patch: { tags: ["zeta", "alpha"] } },
  });
  assert.equal(patched.execution.state, "unknown");
  assert.deepEqual(api.videos.get(SEED.video)!["snippet"]["tags"], ["alpha", "zeta"]);
  drop = false;
  const settled = await runtime.reconcile(patched.execution.execution_id);
  assert.equal(settled.execution.state, "completed", JSON.stringify(settled.error));
});

test("a held comment can be published again, and lost moderation answers are reconciled", async () => {
  let drop = true;
  const { api, runtime } = setup({
    override: (r) =>
      drop && r.url.pathname.endsWith("/setModerationStatus")
        ? { after: { drop: true } }
        : undefined,
  });
  const moderate = (moderation_status: string) =>
    runtime.execute({
      capability: "resource.update",
      actor: AGENT,
      input: { resource: ref.comment(SEED.video, SEED.comment), patch: { moderation_status } },
      evidence: ["execution", "state"],
    });
  const held = await moderate("held_for_review");
  assert.equal(held.execution.state, "unknown");
  assert.equal(api.comments.get(SEED.comment)!["snippet"]["moderationStatus"], "heldForReview");
  drop = false;
  const settled = await runtime.reconcile(held.execution.execution_id);
  assert.equal(settled.execution.state, "completed", JSON.stringify(settled.error));

  const unreadable = await runtime.execute({
    capability: "resource.read",
    actor: AGENT,
    input: { resource: ref.comment(SEED.video, SEED.comment) },
  });
  assert.match(String(unreadable.error?.message), /not public/);

  const published = await moderate("published");
  assert.equal(published.execution.state, "completed", JSON.stringify(published.error));
  assert.equal(api.comments.get(SEED.comment)!["snippet"]["moderationStatus"], "published");
  const evidence = await runtime.listEvidence(published.execution.execution_id);
  assert.equal(evidence.at(-1)!.data!["public"], true);
});

/** Adds uploads newer than everything else, as other invocations would. */
function uploadMore(api: ReturnType<typeof youtube>, count: number) {
  for (let i = 0; i < count; i++) {
    const id = `newer${String(i).padStart(4, "0")}`;
    api.videos.set(id, {
      id,
      snippet: {
        channelId: CHANNEL,
        title: id,
        description: "",
        tags: [],
        publishedAt: new Date().toISOString(),
      },
      status: { privacyStatus: "private", uploadStatus: "uploaded" },
    });
    api.uploads.unshift(id);
  }
}

test("upload reconciliation pages back to the invocation, and never fails what it cannot search", async () => {
  const lose = (r: FakeRequest): Override | undefined =>
    r.method === "PUT" && r.headers.get("content-range")?.startsWith(`bytes ${2 * CHUNK}-`)
      ? { after: { drop: true } }
      : undefined;
  let losing = true;
  const busy = setup({
    override: (r) => (losing ? lose(r) : undefined),
    provider: { settleAfterMs: -60_000 },
  });
  const lost = await busy.runtime.execute(upload());
  assert.equal(lost.execution.state, "unknown");
  const uploaded = busy.api.uploads[0]!;
  losing = false;
  uploadMore(busy.api, 60);
  const found = await busy.runtime.reconcile(lost.execution.execution_id);
  assert.equal(found.execution.state, "completed", JSON.stringify(found.error));
  assert.equal(
    ((found.execution.output as Json)["publication"] as Json)["ref"],
    ref.video(uploaded),
  );

  losing = true;
  const flooded = setup({
    override: (r) => (losing ? lose(r) : undefined),
    provider: { settleAfterMs: -60_000 },
  });
  const second = await flooded.runtime.execute(upload());
  losing = false;
  uploadMore(flooded.api, 1001);
  const unsearchable = await flooded.runtime.reconcile(second.execution.execution_id);
  assert.equal(
    unsearchable.execution.state,
    "unknown",
    "too many uploads is inconclusive, not failed",
  );
});

test("comments stay within the channel: other channels' videos and comments are refused", async () => {
  const { api, runtime } = setup();
  const foreignVideo = ref.video(FOREIGN.video);
  const posted = await runtime.execute({
    capability: "communication.publish",
    profile: "chat",
    traits: ["threading"],
    actor: AGENT,
    input: { audience: foreignVideo, thread: foreignVideo, content: "Hello" },
  });
  assert.equal(posted.execution.state, "failed");
  assert.match(String(posted.error?.message), /belongs to another channel/);

  const smuggled = ref.comment(SEED.video, FOREIGN.comment);
  const replied = await runtime.execute({
    capability: "communication.publish",
    profile: "chat",
    traits: ["threading"],
    actor: AGENT,
    input: { audience: ref.video(SEED.video), thread: smuggled, content: "Hello" },
  });
  assert.equal(replied.execution.state, "failed");
  assert.match(String(replied.error?.message), /not on that video/);

  const deleted = await runtime.execute({
    capability: "resource.delete",
    actor: AGENT,
    input: { resource: smuggled },
  });
  assert.equal(deleted.execution.state, "failed");

  const missingThread = await runtime.execute({
    capability: "communication.publish",
    profile: "chat",
    actor: AGENT,
    input: { audience: ref.video(SEED.video), content: "Hello" },
  });
  assert.match(String(missingThread.error?.message), /needs a thread/);
  assert.equal(
    api.calls.filter((c) => c.method !== "GET").length,
    0,
    "nothing was written anywhere",
  );
  assert.equal(api.comments.size, 2);
});

test("a credential for another channel is refused, and reconciliation will not search with it", async () => {
  const fake = { mine: "UCsomeoneelse" as string | undefined };
  const api = youtube(fake);
  const provider = createYouTubeProvider({ channel: CHANNEL, fetch: api.fetch });
  const { runtime } = runtimeFor(provider, CAPABILITIES, KEY);
  const refused = await runtime.execute({
    capability: "resource.read",
    actor: AGENT,
    input: { resource: CHANNEL_REF },
  });
  assert.equal(refused.execution.state, "failed");
  assert.equal(refused.error?.code, "credential_unavailable");
  assert.match(String(refused.error?.message), /does not manage the configured channel/);

  const settled = createYouTubeProvider({
    channel: CHANNEL,
    settleAfterMs: -60_000,
    fetch: api.fetch,
  });
  const reconciliation = await settled.reconcile!(
    {
      protocol: "runtime/0.1",
      invocation_id: "inv_mismatch",
      execution_id: "exec_mismatch",
      request_id: "req_mismatch",
      capability: { id: "resource.delete", version: "0.1.0" },
      traits: [],
      input: { resource: ref.video(SEED.video) },
      idempotency_key: "mismatch",
      deadline: new Date().toISOString(),
      actor: { ref: AGENT, type: "agent" },
      evidence: { require: ["execution"] },
    } as Invocation,
    {
      signal: new AbortController().signal,
      now: () => new Date(),
      credential: async () => KEY.value,
    },
  );
  assert.equal(reconciliation.status, "inconclusive");
});

test("moderation is proven from YouTube's lists, not inferred from visibility", async () => {
  let failing = true;
  const { api, runtime } = setup({
    override: (r) =>
      failing && r.url.pathname.endsWith("/setModerationStatus")
        ? { before: { status: 502, body: {} } }
        : undefined,
    provider: { settleAfterMs: -60_000 },
  });
  api.comments.get(SEED.comment)!["snippet"]["moderationStatus"] = "heldForReview";
  const reject = () =>
    runtime.execute({
      capability: "resource.update",
      actor: AGENT,
      input: {
        resource: ref.comment(SEED.video, SEED.comment),
        patch: { moderation_status: "rejected" },
      },
      evidence: ["execution", "state"],
    });
  const lost = await reject();
  assert.equal(lost.execution.state, "unknown");
  const still = await runtime.reconcile(lost.execution.execution_id);
  assert.equal(still.execution.state, "failed", "a comment still held is not rejected");
  assert.equal(still.error?.detail, "reconciled_not_applied");

  failing = false;
  const done = await reject();
  assert.equal(done.execution.state, "completed", JSON.stringify(done.error));
  assert.equal(api.comments.get(SEED.comment)!["snippet"]["moderationStatus"], "rejected");
});

test("an upload interrupted before its final chunk fails as retryable, with nothing published", async () => {
  const { api, runtime } = setup({
    override: (r) =>
      r.method === "PUT" && r.headers.get("content-range")?.startsWith("bytes 0-")
        ? { before: { status: 502, body: {} } }
        : undefined,
  });
  const outcome = await runtime.execute(upload());
  assert.equal(outcome.execution.state, "failed");
  assert.equal(outcome.error?.code, "execution_failed");
  assert.equal(outcome.error?.retryable, true);
  assert.equal(api.uploads.length, 1);
});
