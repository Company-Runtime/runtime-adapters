/**
 * Smoke test against a real YouTube channel. Not part of CI: it needs a real credential
 * and spends API quota. Everything it creates is private and deleted at the end.
 *
 *   export RUNTIME_SECRET_ORGANIZATION_PROVIDERS_YOUTUBE='<access token or OAuth grant JSON>'
 *   export YOUTUBE_CHANNEL=UC…
 *   node media/youtube/scripts/smoke.ts <video.mp4> [thumbnail.png|jpg]
 *
 * Comments need a video people can see, and uploads from an unaudited API project stay
 * private: set YOUTUBE_SMOKE_COMMENT_VIDEO to the id of a public or unlisted video on the
 * channel to test comments on it (the comments are deleted, the video is left alone).
 *
 * Reconciliation is checked by running the read-only reconcile handlers on effects that
 * did happen: each must find what its invocation created.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  createRuntime,
  EnvCredentialBroker,
  GrantAuthority,
  ProviderFailure,
  type Invocation,
  type Json,
} from "@runtime-protocol/sdk";
import { createYouTubeProvider } from "../src/index.ts";

const channel = process.env["YOUTUBE_CHANNEL"];
const secret = process.env["RUNTIME_SECRET_ORGANIZATION_PROVIDERS_YOUTUBE"];
const commentVideo = process.env["YOUTUBE_SMOKE_COMMENT_VIDEO"];
const [videoPath, thumbnailPath] = process.argv.slice(2);
if (!channel || !secret || !videoPath) {
  console.error(
    "usage: YOUTUBE_CHANNEL=… RUNTIME_SECRET_ORGANIZATION_PROVIDERS_YOUTUBE=… node smoke.ts <video> [thumbnail]",
  );
  process.exit(2);
}

const AGENT = "identity://agent/youtube-smoke";
const CHANNEL_REF = `resource://youtube/${channel}`;
const CAPABILITIES = [
  "communication.publish",
  "resource.read",
  "resource.search",
  "resource.create",
  "resource.update",
  "resource.delete",
];

const files = new Map<string, string>();
const fileUri = (path: string) => {
  const uri = pathToFileURL(path).href;
  files.set(uri, path);
  return uri;
};

const provider = createYouTubeProvider({
  channel,
  chunkSize: 256 * 1024,
  openAttachment: async (uri) => {
    const path = files.get(uri);
    if (!path) throw new ProviderFailure("the smoke test serves only its own files");
    const bytes = new Uint8Array(await readFile(path));
    return { size: bytes.length, body: bytes };
  },
});
const runtime = createRuntime({
  id: "youtube-smoke",
  providers: [provider],
  authority: new GrantAuthority([
    {
      id: "smoke",
      authority: "authority://smoke/operator",
      subjects: [AGENT],
      capabilities: CAPABILITIES,
    },
  ]),
  credentials: {
    bindings: [{ provider: "youtube", ref: "secret://organization/providers/youtube" }],
    broker: new EnvCredentialBroker(),
  },
});

let failures = 0;
const created: string[] = [];

async function step<T>(name: string, run: () => Promise<T>): Promise<T | undefined> {
  const started = Date.now();
  try {
    const result = await run();
    console.log(`✔ ${name} (${Date.now() - started} ms)`);
    return result;
  } catch (error) {
    failures++;
    console.log(`✖ ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

interface Done {
  output: Json;
  key: string;
  executionId: string;
}

async function execute(request: {
  capability: string;
  input: Json;
  profile?: string;
  traits?: string[];
  timeoutMs?: number;
  /** Settle an unknown outcome through the runtime's reconciliation instead of failing. */
  settle?: boolean;
}): Promise<Done> {
  const key = `smoke-${randomUUID()}`;
  const mutating = !["resource.read", "resource.search"].includes(request.capability);
  const outcome = await runtime.execute({
    capability: request.capability,
    actor: AGENT,
    input: request.input,
    ...(request.profile ? { profile: request.profile } : {}),
    ...(request.traits ? { traits: request.traits } : {}),
    ...(mutating ? { idempotency_key: key, evidence: ["execution", "state"] } : {}),
    ...(request.timeoutMs ? { constraints: { timeout_ms: request.timeoutMs } } : {}),
  });
  let execution = outcome.execution;
  let error = outcome.error;
  for (let i = 0; request.settle && execution.state === "unknown" && i < 6; i++) {
    console.log(`    unknown (${error?.message}); reconciling…`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    ({ execution, error } = await runtime.reconcile(execution.execution_id));
  }
  if (execution.state !== "completed")
    throw new Error(`${execution.state} (${error?.code}): ${error?.message}`);
  return { output: execution.output as Json, key, executionId: execution.execution_id };
}

/** Runs a reconcile handler as if the answer to that invocation had been lost. */
async function reconcile(
  capability: string,
  input: Json,
  key: string,
  extra: { profile?: string; traits?: string[] } = {},
) {
  const invocation = {
    protocol: "runtime/0.1",
    invocation_id: `inv_smoke_${randomUUID()}`,
    execution_id: `exec_smoke_${randomUUID()}`,
    request_id: `req_smoke_${randomUUID()}`,
    capability: { id: capability, version: "0.1.0" },
    traits: extra.traits ?? [],
    ...(extra.profile ? { profile: extra.profile } : {}),
    input,
    idempotency_key: key,
    deadline: new Date().toISOString(),
    actor: { ref: AGENT, type: "agent" },
    evidence: { require: ["execution"] },
  } as Invocation;
  return provider.reconcile!(invocation, {
    signal: new AbortController().signal,
    now: () => new Date(),
    credential: async () => secret,
  });
}

/** Retries a reconciliation while YouTube has not caught up yet. */
async function reconciled(
  what: string,
  expected: string | undefined,
  attempt: () => ReturnType<typeof reconcile>,
  tries = 7,
) {
  for (let i = 0; ; i++) {
    const result = await attempt();
    if (result.status === "completed") {
      const output = JSON.stringify(result.output);
      if (expected && !output.includes(expected))
        throw new Error(`${what} reconciled to something else: ${output}`);
      return result;
    }
    if (result.status === "failed" || i >= tries - 1)
      throw new Error(`${what} reconciled ${result.status}: ${result.reason}`);
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
}

const refIn = (done: Done | undefined, member: "publication" | "resource") =>
  done ? String((done.output[member] as Json)["ref"]) : undefined;
const show = (label: string, value: unknown) =>
  console.log(`    ${label}: ${JSON.stringify(value)}`);

const stamp = new Date().toISOString().replace(/\..*/, "");
console.log(`YouTube smoke test on ${CHANNEL_REF} at ${stamp}\n`);

try {
  // --- Read side --------------------------------------------------------------------
  const channelRead = await step("read the channel", () =>
    execute({ capability: "resource.read", input: { resource: CHANNEL_REF } }),
  );
  if (channelRead) show("channel", channelRead.output["content"]);
  if (!channelRead) throw new Error("the channel cannot be read; nothing else will work");

  const uploads = await step("list uploads", () =>
    execute({ capability: "resource.search", input: { type: "video", limit: 5 } }),
  );
  if (uploads) show("uploads", (uploads.output["items"] as Json[]).length);

  // --- Upload -----------------------------------------------------------------------
  const bytes = await readFile(videoPath);
  const uploadInput = {
    audience: CHANNEL_REF,
    title: `Adapter smoke ${stamp}`,
    content: "Uploaded by the runtime adapter smoke test. Deleted at the end of the run.",
    data: {
      tags: ["runtime-adapter-smoke"],
      privacy_status: "private",
      made_for_kids: false,
      notify_subscribers: false,
    },
    attachments: [
      {
        name: "smoke.mp4",
        media_type: "video/mp4",
        uri: fileUri(videoPath),
        size: bytes.length,
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      },
    ],
  };
  const upload = await step(`upload a private video (${bytes.length} bytes, resumable)`, () =>
    execute({
      capability: "communication.publish",
      profile: "broadcast",
      traits: ["attachments"],
      input: uploadInput,
      timeoutMs: 600_000,
    }),
  );
  const video = refIn(upload, "publication");
  if (video) {
    created.push(video);
    show("video", video);
  }

  if (upload && video) {
    await step("reconcile the upload from its marker tag", () =>
      reconciled("upload", video, () =>
        reconcile("communication.publish", uploadInput, upload.key, {
          profile: "broadcast",
          traits: ["attachments"],
        }),
      ),
    );

    const read = await step("read the video back", async () => {
      const done = await execute({ capability: "resource.read", input: { resource: video } });
      const content = done.output["content"] as Json;
      if (JSON.stringify(content["tags"]) !== JSON.stringify(["runtime-adapter-smoke"]))
        throw new Error(`tags should hide the marker: ${JSON.stringify(content["tags"])}`);
      return done;
    });
    if (read) {
      const content = read.output["content"] as Json;
      show("video", {
        title: content["title"],
        privacy_status: content["privacy_status"],
        upload_status: content["upload_status"],
      });
    }

    const patch = {
      description: "Patched by the smoke test.",
      tags: ["runtime-adapter-smoke", "patched"],
    };
    const version = read ? String((read.output["resource"] as Json)["version"]) : undefined;
    const patched = await step("patch the description and tags at the version read", () =>
      execute({
        capability: "resource.update",
        input: { resource: video, patch, ...(version ? { expected_version: version } : {}) },
      }),
    );
    if (patched)
      await step("reconcile the patch by reading it back", () =>
        reconciled(
          "patch",
          video,
          () => reconcile("resource.update", { resource: video, patch }, patched.key),
          13,
        ),
      );
    if (version)
      await step("refuse a stale expected_version", async () => {
        const stale = await execute({
          capability: "resource.update",
          input: { resource: video, patch: { title: "Never applied" }, expected_version: version },
        }).then(
          () => undefined,
          (error: Error) => error,
        );
        if (!stale || !/changed/.test(stale.message))
          throw new Error("the stale update was not refused");
      });

    if (thumbnailPath)
      await step("set a custom thumbnail", () =>
        execute({
          capability: "resource.update",
          input: {
            resource: `${video}/thumbnail`,
            content: {
              uri: fileUri(thumbnailPath),
              media_type: thumbnailPath.endsWith(".png") ? "image/png" : "image/jpeg",
            },
          },
        }),
      );

    // --- Comments ---------------------------------------------------------------------
    const commented = commentVideo ? `${CHANNEL_REF}/videos/${commentVideo}` : video;
    // A comment is a message in the video's thread.
    const commentInput = {
      audience: commented,
      thread: commented,
      content: `Smoke comment ${stamp}`,
    };
    const comment = await step(
      `comment on ${commentVideo ? "the comment video" : "the upload"}`,
      () =>
        execute({
          capability: "communication.publish",
          profile: "chat",
          traits: ["threading"],
          input: commentInput,
        }),
    );
    const commentRef = refIn(comment, "publication");
    if (comment && commentRef) {
      created.push(commentRef);
      await step("reconcile the comment by author, text and time", () =>
        reconciled("comment", commentRef, () =>
          reconcile("communication.publish", commentInput, comment.key, {
            profile: "chat",
            traits: ["threading"],
          }),
        ),
      );
      const reply = await step("reply to the comment", () =>
        execute({
          capability: "communication.publish",
          profile: "chat",
          traits: ["threading"],
          input: { audience: commented, thread: commentRef, content: "Smoke reply" },
        }),
      );
      const replyRef = refIn(reply, "publication");
      if (replyRef) {
        created.push(replyRef);
        await step("edit the reply", () =>
          execute({
            capability: "resource.update",
            input: { resource: replyRef, content: "Smoke reply, edited" },
          }),
        );
        await step("list the replies", async () => {
          const done = await execute({
            capability: "resource.search",
            input: { type: "comment", filters: { parent: commentRef } },
          });
          if (!JSON.stringify(done.output).includes(replyRef))
            throw new Error("the reply is not listed");
        });
      }
      await step("read the comment (moderation status visible?)", async () => {
        const done = await execute({
          capability: "resource.read",
          input: { resource: commentRef },
        });
        show("comment", done.output["content"]);
      });
    }

    // --- Playlists --------------------------------------------------------------------
    const playlistInput = {
      type: "playlist",
      parent: CHANNEL_REF,
      content: { title: `Smoke playlist ${stamp}`, privacy_status: "private" },
    };
    const playlist = await step("create a private playlist", () =>
      execute({ capability: "resource.create", input: playlistInput }),
    );
    const playlistRef = refIn(playlist, "resource");
    if (playlist && playlistRef) {
      created.push(playlistRef);
      await step("reconcile the playlist by title and time", () =>
        reconciled("playlist", playlistRef, () =>
          reconcile("resource.create", playlistInput, playlist.key),
        ),
      );
      const itemInput = { type: "playlist_item", parent: playlistRef, content: { video } };
      const item = await step("add the video to the playlist", () =>
        execute({ capability: "resource.create", input: itemInput }),
      );
      const itemRef = refIn(item, "resource");
      if (item && itemRef) {
        created.push(itemRef);
        await step("reconcile the item by video and time", () =>
          reconciled("item", itemRef, () => reconcile("resource.create", itemInput, item.key)),
        );
        await step("read the item", () =>
          execute({ capability: "resource.read", input: { resource: itemRef } }),
        );
      }
    }
  }
} catch (error) {
  console.log(`\nstopped: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  // --- Cleanup: newest first, so items go before their playlist and replies before comments.
  if (created.length) console.log("\ncleanup");
  for (const ref of created.reverse()) {
    const deleted = await step(`delete ${ref.replace(CHANNEL_REF, "")}`, () =>
      execute({ capability: "resource.delete", input: { resource: ref }, settle: true }),
    );
    if (deleted && /\/videos\/[^/]+(\/comments\/[^/]+)?$/.test(ref))
      await step("reconcile the deletion", () =>
        reconciled("delete", ref, () =>
          reconcile("resource.delete", { resource: ref }, deleted.key),
        ),
      );
  }
  console.log(failures ? `\n${failures} step(s) failed` : "\nall steps passed");
  process.exitCode = failures ? 1 : 0;
}
