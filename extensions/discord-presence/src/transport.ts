import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import net from "node:net";
import { join, sep } from "node:path";
import type { ConnectError, DiscordClientId, SetActivityPayload, TransportError } from "./types.ts";
import { err, ok, type Result } from "./result.ts";

// Seam: everything the rest of the extension knows about Discord. Faked in tests.
export interface DiscordTransport {
  connect(clientId: DiscordClientId, signal?: AbortSignal): Promise<Result<void, ConnectError>>;
  setActivity(payload: SetActivityPayload): Promise<Result<void, TransportError>>;
  clearActivity(): Promise<Result<void, TransportError>>;
  onClose(listener: () => void): void;
  isConnected(): boolean;
  close(): Promise<void>;
}

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

interface RpcFrame {
  readonly cmd?: string;
  readonly evt?: string;
  readonly nonce?: string;
  readonly data?: unknown;
  readonly [key: string]: unknown;
}

interface PendingRequest {
  readonly resolve: () => void;
  readonly reject: (error: TransportError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const isBlank = (value: string): boolean => value.trim().length === 0;

const tempDir = (): string => {
  const dir = process.env.XDG_RUNTIME_DIR ?? process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP ?? `${sep}tmp`;
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
};

const ipcPaths = (): string[] => {
  const ids = Array.from({ length: 10 }, (_, index) => index);
  if (process.platform === "win32") return ids.map((id) => `\\\\?\\pipe\\discord-ipc-${id}`);

  const base = tempDir();
  const dirs = [
    base,
    // Snap and Flatpak Discord installations expose IPC sockets below these directories.
    join(base, "snap.discord"),
    join(base, "app", "com.discordapp.Discord"),
  ];
  const uniqueDirs = [...new Set(dirs)];
  return uniqueDirs.flatMap((dir) => ids.map((id) => join(dir, `discord-ipc-${id}`)));
};

const classifyConnect = (e: unknown): ConnectError => {
  const msg = e instanceof Error ? e.message : String(e);
  if (/invalid client/i.test(msg)) return { type: "InvalidClientId" };
  if (/refused|enoent|could not connect|connection|timed?\s*out|timeout|no(t)? running|aborted/i.test(msg)) {
    return { type: "DiscordNotRunning" };
  }
  return { type: "HandshakeFailed", detail: msg };
};

const encode = (op: number, payload: unknown): Buffer => {
  const body = payload === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(8);
  header.writeUInt32LE(op, 0);
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
};

const connectSocket = (path: string, signal?: AbortSignal): Promise<net.Socket> =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection(path);

    const cleanup = (): void => {
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
      socket.removeListener("timeout", onTimeout);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error): void => {
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onConnect = (): void => {
      cleanup();
      socket.setTimeout(0);
      resolve(socket);
    };
    const onError = (error: Error): void => fail(error);
    const onTimeout = (): void => fail(new Error("Connection timed out"));
    const onAbort = (): void => fail(new Error("Connection aborted"));

    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    socket.setTimeout(3_000);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });

const findDiscordSocket = async (signal?: AbortSignal): Promise<net.Socket> => {
  const paths = ipcPaths();
  let lastError: unknown;
  for (const path of paths) {
    if (signal?.aborted) throw new Error("Connection aborted");
    if (process.platform !== "win32" && !existsSync(path)) continue;
    try {
      return await connectSocket(path, signal);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("Could not connect to Discord client");
};

export const createDiscordIpcTransport = (): DiscordTransport => {
  let socket: net.Socket | undefined;
  let connected = false;
  let buffer = Buffer.alloc(0);
  let closeListener: (() => void) | undefined;
  const pending = new Map<string, PendingRequest>();

  const notifyClosed = (): void => {
    connected = false;
    for (const [nonce, request] of pending) {
      clearTimeout(request.timer);
      request.reject({ type: "SocketClosed" });
      pending.delete(nonce);
    }
    closeListener?.();
  };

  const send = (op: number, payload: unknown): void => {
    if (!socket || socket.destroyed) throw new Error("Socket closed");
    socket.write(encode(op, payload));
  };

  const handleFrame = (frame: RpcFrame): void => {
    if (frame.nonce) {
      const request = pending.get(frame.nonce);
      if (request) {
        pending.delete(frame.nonce);
        clearTimeout(request.timer);
        if (frame.evt === "ERROR") {
          const detail = typeof frame.data === "string" ? frame.data : JSON.stringify(frame.data ?? frame);
          request.reject({ type: "SetActivityFailed", detail });
        } else {
          request.resolve();
        }
      }
    }
  };

  const handleData = (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 8) {
      const op = buffer.readUInt32LE(0);
      const length = buffer.readUInt32LE(4);
      if (buffer.length < 8 + length) return;

      const raw = buffer.subarray(8, 8 + length).toString("utf8");
      buffer = buffer.subarray(8 + length);

      let payload: RpcFrame | undefined;
      try {
        payload = raw.length > 0 ? (JSON.parse(raw) as RpcFrame) : undefined;
      } catch {
        continue;
      }

      if (op === OP_FRAME && payload) handleFrame(payload);
      else if (op === OP_PING) send(OP_PONG, payload);
      else if (op === OP_CLOSE) {
        socket?.destroy();
        notifyClosed();
      }
    }
  };

  const request = (cmd: string, args: Record<string, unknown>): Promise<Result<void, TransportError>> =>
    new Promise((resolve) => {
      if (!socket || socket.destroyed || !connected) {
        resolve(err({ type: "SocketClosed" }));
        return;
      }

      const nonce = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(nonce);
        resolve(err({ type: "SetActivityFailed", detail: "Discord RPC request timed out" }));
      }, 5_000);

      pending.set(nonce, {
        timer,
        resolve: () => resolve(ok(undefined)),
        reject: (error) => resolve(err(error)),
      });

      try {
        send(OP_FRAME, { cmd, args, nonce });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(nonce);
        resolve(err({ type: "SetActivityFailed", detail: error instanceof Error ? error.message : String(error) }));
      }
    });

  return {
    async connect(clientId, signal) {
      if (isBlank(clientId)) return err({ type: "InvalidClientId" });
      if (connected && socket && !socket.destroyed) return ok(undefined);

      try {
        socket?.destroy();
        socket = await findDiscordSocket(signal);
        buffer = Buffer.alloc(0);

        await new Promise<void>((resolve, reject) => {
          let settled = false;
          let timer: ReturnType<typeof setTimeout>;
          const done = (error?: Error): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket?.removeListener("data", onHandshakeData);
            socket?.removeListener("error", onHandshakeError);
            socket?.removeListener("close", onHandshakeClose);
            signal?.removeEventListener("abort", onAbort);
            if (error) reject(error);
            else resolve();
          };
          const onAbort = (): void => done(new Error("Discord handshake aborted"));
          const onHandshakeError = (error: Error): void => done(error);
          const onHandshakeClose = (): void => done(new Error("Discord socket closed during handshake"));
          const onHandshakeData = (chunk: Buffer): void => {
            buffer = Buffer.concat([buffer, chunk]);
            while (buffer.length >= 8) {
              const op = buffer.readUInt32LE(0);
              const length = buffer.readUInt32LE(4);
              if (buffer.length < 8 + length) return;
              const raw = buffer.subarray(8, 8 + length).toString("utf8");
              buffer = buffer.subarray(8 + length);
              let payload: RpcFrame | undefined;
              try {
                payload = raw.length > 0 ? (JSON.parse(raw) as RpcFrame) : undefined;
              } catch {
                done(new Error("Discord sent malformed handshake data"));
                return;
              }
              if (op === OP_FRAME && payload?.evt === "READY") {
                done();
                return;
              } else if (op === OP_PING) send(OP_PONG, payload);
              else if (op === OP_CLOSE) {
                done(new Error("Discord closed RPC connection"));
                return;
              }
            }
          };

          timer = setTimeout(() => done(new Error("Discord handshake timed out")), 5_000);
          socket?.on("data", onHandshakeData);
          socket?.once("error", onHandshakeError);
          socket?.once("close", onHandshakeClose);
          if (signal) {
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          }
          send(OP_HANDSHAKE, { v: 1, client_id: clientId });
        });

        connected = true;
        socket.on("data", handleData);
        socket.once("error", notifyClosed);
        socket.once("close", notifyClosed);
        // READY may share a chunk with a subsequent RPC frame.
        handleData(Buffer.alloc(0));
        return ok(undefined);
      } catch (e) {
        socket?.destroy();
        socket = undefined;
        connected = false;
        return err(classifyConnect(e));
      }
    },

    async setActivity(payload) {
      return request("SET_ACTIVITY", {
        pid: process.pid,
        activity: {
          name: "Pi",
          type: 0,
          created_at: Date.now(),
          details: payload.details,
          state: payload.state,
          timestamps: { start: Math.floor(payload.startTimestamp / 1_000) },
          assets: {
            large_image: payload.largeImageKey,
            large_text: payload.largeImageText,
            small_image: payload.smallImageKey,
            small_text: payload.smallImageText,
          },
          instance: payload.instance,
        },
      });
    },

    async clearActivity() {
      return request("SET_ACTIVITY", { pid: process.pid, activity: null });
    },

    onClose(listener) {
      closeListener = listener;
    },

    isConnected() {
      return connected && !!socket && !socket.destroyed;
    },

    async close() {
      connected = false;
      for (const [nonce, request] of pending) {
        clearTimeout(request.timer);
        request.reject({ type: "SocketClosed" });
        pending.delete(nonce);
      }
      await new Promise<void>((resolve) => {
        if (!socket || socket.destroyed) {
          resolve();
          return;
        }
        socket.once("close", () => resolve());
        socket.destroy();
      });
      socket = undefined;
    },
  };
};
