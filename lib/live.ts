import "server-only";
import { EventEmitter } from "node:events";

/**
 * In-process pub/sub that feeds the server-sent-event streams, so the staff
 * counter and the customer's phone update the moment money or state moves.
 * One web instance is enough for a shop; a multi-instance deployment would
 * swap this for Postgres LISTEN/NOTIFY.
 */
export type LiveEvent = { rentalId: string; type: string; at: string };

const globalForBus = globalThis as unknown as { handbackBus?: EventEmitter };
const bus = (globalForBus.handbackBus ??= (() => {
  const e = new EventEmitter();
  e.setMaxListeners(0);
  return e;
})());

export function publish(rentalId: string, type: string): void {
  const event: LiveEvent = { rentalId, type, at: new Date().toISOString() };
  bus.emit(`rental:${rentalId}`, event);
  bus.emit("shop", event);
}

/** channel is "shop" for every rental, or a rental id. Returns an unsubscribe function. */
export function subscribe(channel: string, fn: (e: LiveEvent) => void): () => void {
  const name = channel === "shop" ? "shop" : `rental:${channel}`;
  bus.on(name, fn);
  return () => bus.off(name, fn);
}
