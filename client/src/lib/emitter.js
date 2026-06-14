/**
 * Minimal synchronous event emitter. The transfer engine (signaling, peer,
 * sender, receiver) is built on this rather than the DOM's EventTarget so it
 * stays dependency-free and trivial to consume from React hooks or tests.
 */
export class Emitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(handler);
    // Return an unsubscribe function for ergonomic cleanup in effects.
    return () => this.off(event, handler);
  }

  off(event, handler) {
    this._listeners.get(event)?.delete(handler);
  }

  emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set) return;
    // Iterate a copy so handlers can unsubscribe during emission safely.
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (err) {
        // A misbehaving listener must not break the engine.
        console.error(`listener for "${event}" threw:`, err);
      }
    }
  }

  removeAllListeners() {
    this._listeners.clear();
  }
}
