import type { DiscordTransport } from "./transport.ts";
import type { DesiredPresence, DiscordClientId, TransportError } from "./types.ts";
import { ok, type Result } from "./result.ts";
import { toPayload } from "./render.ts";

export interface PresenceLink {
  push(desired: DesiredPresence): Promise<Result<void, TransportError>>;
  disconnect(): Promise<void>;
}

// Serialize transport work so shutdown cannot race a pending connection/update.
export const createPresenceLink = (args: {
  readonly transport: DiscordTransport;
  readonly clientId: DiscordClientId;
}): PresenceLink => {
  const controller = new AbortController();
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();
  let disconnecting: Promise<void> | undefined;

  return {
    push(desired) {
      const work = queue.then(async (): Promise<Result<void, TransportError>> => {
        if (closed) return ok(undefined);
        // Clearing an absent presence must not initiate a new connection.
        if (!args.transport.isConnected()) {
          if (desired.kind === "cleared") return ok(undefined);
          const result = await args.transport.connect(args.clientId, controller.signal);
          if (!result.ok || closed) return ok(undefined);
        }
        return desired.kind === "card"
          ? args.transport.setActivity(toPayload(desired.card))
          : args.transport.clearActivity();
      });
      queue = work.catch(() => undefined);
      return work;
    },

    disconnect() {
      if (disconnecting) return disconnecting;
      closed = true;
      controller.abort();
      disconnecting = queue.then(async () => {
        try {
          if (args.transport.isConnected()) await args.transport.clearActivity();
        } finally {
          await args.transport.close();
        }
      });
      return disconnecting;
    },
  };
};
