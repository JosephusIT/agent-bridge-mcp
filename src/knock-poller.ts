/**
 * HTTP polling client for AgentBridge knock endpoint.
 * Used to detect when the session has new inbound messages.
 */

export interface KnockPollOptions {
  sessionLink: string;
  intervalMs?: number;
  signal?: AbortSignal;
}

export interface KnockEvent {
  hasMessages: boolean;
  checkedAt: string; // ISO-8601
}

/** Knock polling function — returns the latest KnockEvent each poll tick. */
export type KnockPoller = (
  opts: KnockPollOptions,
  onEvent: (event: KnockEvent) => void
) => void;

/**
 * Default knock poller implementation using fetch.
 * Polls the session knock endpoint every `intervalMs` milliseconds.
 */
export function createKnockPoller(): KnockPoller {
  return function poll(opts: KnockPollOptions, onEvent: (e: KnockEvent) => void): void {
    const { sessionLink, intervalMs = 2000, signal } = opts;

    const url = `${sessionLink}/knock`;

    const tick = async (): Promise<void> => {
      if (signal?.aborted) return;
      try {
        const res = await fetch(url, { signal });
        const hasMessages = res.ok && res.status === 200;
        onEvent({ hasMessages, checkedAt: new Date().toISOString() });
      } catch (err) {
        if (signal?.aborted) return;
        // Transient network errors are non-fatal: log for diagnostics and report
        // "no messages" so the caller keeps polling.
        console.debug('[knock-poller] poll failed:', err);
        onEvent({ hasMessages: false, checkedAt: new Date().toISOString() });
      }
    };

    const intervalId = setInterval(tick, intervalMs);
    signal?.addEventListener('abort', () => clearInterval(intervalId));
    tick(); // immediate first poll
  };
}