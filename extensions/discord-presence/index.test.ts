import assert from "node:assert/strict";
import { test } from "node:test";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyTool, initialActivityState, reduce, toActivity } from "./src/activity.ts";
import { parseGlobalConfig, resolveEnablement } from "./src/config.ts";
import { createPresenceLink } from "./src/link.ts";
import { renderCard } from "./src/render.ts";
import { ok } from "./src/result.ts";
import { createScheduler } from "./src/scheduler.ts";
import { createDiscordIpcTransport, type DiscordTransport } from "./src/transport.ts";
import { bashHead, epochNow, modelName, type DiscordClientId, type EpochMillis } from "./src/types.ts";

const clientId = "123" as DiscordClientId;
const card = renderCard({ kind: "idle" }, { model: modelName("test-model"), startedAt: epochNow() });

test("file activity never includes filenames, projects, or unknown extensions", () => {
  for (const path of ["/secret/project/password.ts", "/secret/project/file.private-client"]) {
    const activity = classifyTool("edit", { path });
    const text = JSON.stringify(renderCard(activity, { model: modelName("test"), startedAt: epochNow() }));
    for (const secret of ["secret", "project", "password", "private-client"]) assert.ok(!text.includes(secret));
  }
});

test("shell presence allows known commands but not arbitrary shell text", () => {
  assert.equal(bashHead("TOKEN=secret /usr/bin/git status"), "git");
  for (const command of ["./private-project.sh", "'private document'", "$(cat /secrets)", "TOKEN=secret", ""]) {
    assert.equal(bashHead(command), "shell");
  }
});

test("activity stays thinking between turns, then becomes idle", () => {
  let state = reduce(initialActivityState(), { type: "tool_start", toolCallId: "1", toolName: "read", input: { path: "file.ts" } });
  assert.equal(toActivity(state).kind, "reading");
  state = reduce(state, { type: "turn_end" });
  assert.equal(toActivity(state).kind, "thinking");
  assert.equal(toActivity(reduce(state, { type: "agent_end" })).kind, "idle");
});

test("parallel calls of the same tool can finish out of order", () => {
  let state = reduce(initialActivityState(), { type: "tool_start", toolCallId: "1", toolName: "read", input: { path: "file.ts" } });
  state = reduce(state, { type: "tool_start", toolCallId: "2", toolName: "read", input: { path: "file.py" } });
  state = reduce(state, { type: "tool_end", toolCallId: "1" });
  assert.deepEqual(toActivity(state), classifyTool("read", { path: "file.py" }));
  state = reduce(state, { type: "tool_end", toolCallId: "2" });
  assert.equal(toActivity(state).kind, "thinking");
});

test("runtime config overrides project, which overrides global", () => {
  const parsed = parseGlobalConfig({ enabled: false });
  assert.ok(parsed.ok);
  assert.equal(resolveEnablement({ global: parsed.value, projectOverride: { enabled: true }, runtimeToggle: undefined }), true);
  assert.equal(resolveEnablement({ global: parsed.value, projectOverride: { enabled: true }, runtimeToggle: false }), false);
  assert.equal(parseGlobalConfig({ enabled: "false" }).ok, false);
});

function fakeTransport(overrides: Partial<DiscordTransport> = {}): DiscordTransport {
  return {
    connect: async () => ok(undefined), setActivity: async () => ok(undefined),
    clearActivity: async () => ok(undefined), onClose: () => {},
    isConnected: () => false, close: async () => {}, ...overrides,
  };
}

test("clearing an absent presence never connects", async () => {
  const link = createPresenceLink({ clientId, transport: fakeTransport({ connect: async () => { assert.fail("unexpected connection"); } }) });
  await link.push({ kind: "cleared" });
  await link.disconnect();
});

test("disconnect aborts a pending connection and prevents late updates", async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let closed = 0;
  const link = createPresenceLink({ clientId, transport: fakeTransport({
    connect: async (_id, signal) => {
      started();
      await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
      return ok(undefined);
    },
    setActivity: async () => { assert.fail("late update"); },
    close: async () => { closed++; },
  }) });
  const push = link.push({ kind: "card", card });
  await ready;
  await Promise.all([link.disconnect(), push]);
  await link.push({ kind: "card", card });
  await link.disconnect();
  assert.equal(closed, 1);
});

test("shutdown clears a connected presence before closing", async () => {
  const calls: string[] = [];
  const link = createPresenceLink({ clientId, transport: fakeTransport({
    isConnected: () => true,
    clearActivity: async () => { calls.push("clear"); return ok(undefined); },
    close: async () => { calls.push("close"); },
  }) });
  await link.disconnect();
  assert.deepEqual(calls, ["clear", "close"]);
});

test("scheduler coalesces pending updates and cancels on stop", async () => {
  let now = 20_000;
  let callback: (() => void) | undefined;
  const sent: string[] = [];
  const scheduler = createScheduler({
    clock: { now: () => now as EpochMillis, schedule: (_delay, fn) => { callback = fn; return () => { callback = undefined; }; } },
    minIntervalMs: 15_000,
    push: async (value) => { sent.push(value.kind); return ok(undefined); },
  });
  scheduler.request({ kind: "card", card });
  await Promise.resolve();
  scheduler.request({ kind: "card", card });
  scheduler.request({ kind: "cleared" });
  now += 15_000;
  callback!();
  await Promise.resolve();
  assert.deepEqual(sent, ["card", "cleared"]);
  scheduler.request({ kind: "card", card });
  scheduler.stop();
  assert.equal(callback, undefined);
});

// Exercise the actual wire protocol against a local fake Discord, not a real account.
test("IPC supports fragmented READY, ping/pong, seconds timestamps, and clearing", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-discord-test-"));
  const previous = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = dir;
  const sockets = new Set<net.Socket>();
  const activities: any[] = [];
  let pong = false;
  const frame = (op: number, value: unknown) => {
    const body = Buffer.from(JSON.stringify(value));
    const header = Buffer.alloc(8);
    header.writeUInt32LE(op, 0); header.writeUInt32LE(body.length, 4);
    return Buffer.concat([header, body]);
  };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8 && buffer.length >= 8 + buffer.readUInt32LE(4)) {
        const op = buffer.readUInt32LE(0);
        const length = buffer.readUInt32LE(4);
        const payload = JSON.parse(buffer.subarray(8, 8 + length).toString());
        buffer = buffer.subarray(8 + length);
        if (op === 0) {
          const ready = frame(1, { evt: "READY" });
          socket.write(ready.subarray(0, 5));
          setImmediate(() => socket.write(Buffer.concat([ready.subarray(5), frame(3, { ping: true })])));
        } else if (op === 4) pong = true;
        else if (op === 1) {
          activities.push(payload.args.activity);
          socket.write(frame(1, { nonce: payload.nonce, cmd: payload.cmd }));
        }
      }
    });
  });
  const transport = createDiscordIpcTransport();
  try {
    await new Promise<void>((resolve) => server.listen(join(dir, "discord-ipc-0"), resolve));
    assert.equal((await transport.connect(clientId)).ok, true);
    assert.equal((await transport.setActivity({ details: "Idle", state: "Pi", startTimestamp: 1_700_000_000_123,
      largeImageKey: "pi_logo", largeImageText: "Pi", smallImageKey: "pi_logo", smallImageText: "Pi", instance: false })).ok, true);
    assert.equal(pong, true);
    assert.equal(activities[0].timestamps.start, 1_700_000_000);
    assert.equal((await transport.clearActivity()).ok, true);
    assert.equal(activities[1], null);
  } finally {
    await transport.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
