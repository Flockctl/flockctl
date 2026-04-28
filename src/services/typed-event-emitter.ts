import { EventEmitter } from "node:events";

/**
 * Thin typed wrapper around Node's EventEmitter.
 *
 * Models a single-channel emitter where every event carries the same
 * payload shape `T`. Listeners are invoked synchronously, in the order
 * they were registered, just like the underlying `EventEmitter`.
 */
export class TypedEventEmitter<T> {
  private readonly emitter = new EventEmitter();
  private static readonly EVENT = "event";

  emit(payload: T): boolean {
    return this.emitter.emit(TypedEventEmitter.EVENT, payload);
  }

  on(listener: (payload: T) => void): this {
    this.emitter.on(TypedEventEmitter.EVENT, listener);
    return this;
  }

  once(listener: (payload: T) => void): this {
    this.emitter.once(TypedEventEmitter.EVENT, listener);
    return this;
  }

  off(listener: (payload: T) => void): this {
    this.emitter.off(TypedEventEmitter.EVENT, listener);
    return this;
  }

  removeAllListeners(): this {
    this.emitter.removeAllListeners(TypedEventEmitter.EVENT);
    return this;
  }

  listenerCount(): number {
    return this.emitter.listenerCount(TypedEventEmitter.EVENT);
  }
}
