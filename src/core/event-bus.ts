// ── Narrative AI — Central Event Bus ────────────────────
// All agents communicate through this bus. No direct agent-to-agent calls.

import { EventEmitter } from 'events';
import type { EventMap } from './types.js';
import { log } from './logger.js';

class JKEventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void {
    log.debug(`[BUS] ${String(event)}`, data);
    // Use rawListeners to preserve once() wrapper semantics
    const listeners = this.emitter.rawListeners(String(event));
    for (const listener of listeners) {
      try {
        // Call the listener — rawListeners returns once-wrappers that auto-remove themselves
        const result = (listener as (d: EventMap[K]) => unknown)(data);
        // Handle async handlers — log errors but don't block
        if (result && typeof (result as Promise<unknown>).catch === 'function') {
          (result as Promise<unknown>).catch(err => {
            log.error(`[BUS] Async handler error on ${String(event)}`, err);
          });
        }
      } catch (err) {
        log.error(`[BUS] Handler error on ${String(event)}`, err);
      }
    }
  }

  on<K extends keyof EventMap>(event: K, handler: (data: EventMap[K]) => void): void {
    this.emitter.on(String(event), handler);
  }

  off<K extends keyof EventMap>(event: K, handler: (data: EventMap[K]) => void): void {
    this.emitter.off(String(event), handler);
  }

  once<K extends keyof EventMap>(event: K, handler: (data: EventMap[K]) => void): void {
    this.emitter.once(String(event), handler);
  }

  listenerCount(event: keyof EventMap): number {
    return this.emitter.listenerCount(String(event));
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}

/** Singleton event bus — import this everywhere */
export const bus = new JKEventBus();

