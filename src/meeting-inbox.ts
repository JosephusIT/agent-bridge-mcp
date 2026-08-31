import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Agent, AgentBridgeSession, ConnectResult, Message, Transport } from './transport.js';

export interface MeetingInboxOptions {
  pollIntervalMs: number;
  inboxMaxMessages: number;
  defaultReceiveTimeoutMs: number;
  /** Max `before=` pages when catching up (default 200). */
  maxCatchupPages?: number;
  /** Directory for durable cursor/seen state (default ~/.agentbridge). */
  stateDir?: string;
  notify?: (event: InboxNotification) => Promise<void> | void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface InboxNotification {
  count: number;
  latestId: string;
  session: string;
}

export interface JoinMeetingInput {
  capabilities?: string[];
  replayHistory?: boolean;
  startPolling?: boolean;
}

export interface ReceiveMessagesInput {
  timeoutMs?: number;
}

export interface AckMessagesInput {
  messageIds: string[];
}

export interface PollOnceInput {
  seedOnly?: boolean;
}

export interface MeetingStatus {
  connected: boolean;
  agent: Agent | null;
  polling: boolean;
  lastPollTime: string | null;
  queuedMessageCount: number;
  lastError: string | null;
  receiveInProgress: boolean;
  cursor: MessageCursor | null;
}

export interface MessageCursor {
  id: string;
  createdAt: string;
}

export interface InboxResult {
  messages: Message[];
  count: number;
  cursor: MessageCursor | null;
}

export interface ReceiveResult extends InboxResult {
  timedOut: boolean;
}

export interface LeaveMeetingResult extends InboxResult {
  pollingStopped: boolean;
}

type ConnectFn = (capabilities: string[]) => Promise<ConnectResult>;

const DEFAULT_HISTORY_LIMIT = 100;
/** Default safety cap when walking `before=` pages to catch up to the local cursor.
 * Override with AGENTBRIDGE_INBOX_CATCHUP_MAX_PAGES (or MeetingInboxOptions.maxCatchupPages). */
const DEFAULT_MAX_CATCHUP_PAGES = 200;

export class MeetingInbox {
  private connectedResult: ConnectResult | null = null;
  private agent: Agent | null = null;
  private queue: Message[] = [];
  private readonly seenIds = new Set<string>();
  private cursor: MessageCursor | null = null;
  private cursorSeeded = false;
  private lastPollTime: string | null = null;
  private lastError: string | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private pollInFlight: Promise<InboxResult> | null = null;
  private receiveInProgress = false;

  constructor(
    private readonly session: AgentBridgeSession,
    private readonly transport: Transport,
    private readonly connectFn: ConnectFn,
    private readonly options: MeetingInboxOptions
  ) {}

  async connect(capabilities: string[] = []): Promise<ConnectResult> {
    // Idempotent: once active, reuse the cached connection. A second /connect can
    // re-enter the knock/approval path (e.g. with a single-use token) and time
    // out, so callers like diagnose_continuous_listening followed by join_meeting
    // must not trigger a fresh handshake.
    if (this.connectedResult?.status === 'active') return this.connectedResult;
    const result = await this.connectFn(capabilities);
    this.captureConnection(result);
    this.loadCursorState();
    return result;
  }

  /**
   * Clear the cached active connection so the next `connect` / poll re-handshakes.
   * Used after auth failures that the transport could not recover from.
   */
  invalidateConnection(): void {
    this.connectedResult = null;
  }

  async join(input: JoinMeetingInput = {}): Promise<MeetingStatus & { seeded: boolean; replayed: number }> {
    const result = await this.connect(input.capabilities ?? []);
    const replayHistory = input.replayHistory ?? false;
    let replayed = 0;

    if (replayHistory) {
      const history = await this.fetchVisibleMessages({ catchUp: false });
      const accepted = this.enqueueMessages(history);
      this.cursorSeeded = true;
      replayed = accepted.length;
    } else {
      await this.seedFrom(result.backfill);
    }

    // Default false: safe with agentbridge-listen / Cursor skill (avoids dual pollers).
    // Tool-loop-only agents should pass startPolling: true.
    if (input.startPolling ?? false) this.startPolling();
    return { ...this.status(), seeded: !replayHistory, replayed };
  }

  leave(): LeaveMeetingResult {
    const wasPolling = this.isPolling();
    this.stopPolling();
    const inbox = this.getInbox();
    return { ...inbox, pollingStopped: wasPolling };
  }

  status(): MeetingStatus {
    return {
      connected: this.connectedResult?.status === 'active',
      agent: this.agent,
      polling: this.isPolling(),
      lastPollTime: this.lastPollTime,
      queuedMessageCount: this.queue.length,
      lastError: this.lastError,
      receiveInProgress: this.receiveInProgress,
      cursor: this.cursor,
    };
  }

  getInbox(): InboxResult {
    return { messages: [...this.queue], count: this.queue.length, cursor: this.cursor };
  }

  ack(input: AckMessagesInput): InboxResult {
    const ids = new Set(input.messageIds);
    this.queue = this.queue.filter((message) => !ids.has(message.id));
    return this.getInbox();
  }

  async pollOnce(input: PollOnceInput = {}): Promise<InboxResult> {
    if (this.pollInFlight) return this.pollInFlight;

    this.pollInFlight = this.pollOnceInternal(input).finally(() => {
      this.pollInFlight = null;
    });
    return this.pollInFlight;
  }

  async receive(input: ReceiveMessagesInput = {}): Promise<ReceiveResult> {
    if (this.queue.length > 0) return { ...this.getInbox(), timedOut: false };
    if (this.receiveInProgress) {
      throw new Error('RECEIVE_IN_PROGRESS: receive_messages is already waiting for messages.');
    }

    this.receiveInProgress = true;
    const timeoutMs = Math.max(0, input.timeoutMs ?? this.options.defaultReceiveTimeoutMs);
    const deadline = this.options.now!() + timeoutMs;

    try {
      do {
        const inbox = await this.pollOnce();
        if (inbox.count > 0) return { ...inbox, timedOut: false };

        const remainingMs = deadline - this.options.now!();
        if (remainingMs <= 0) break;
        await this.options.sleep!(Math.min(this.options.pollIntervalMs, remainingMs));
      } while (this.options.now!() < deadline);

      return { ...this.getInbox(), timedOut: true };
    } finally {
      this.receiveInProgress = false;
    }
  }

  startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.pollOnce().catch(() => {
        // pollOnce records the error; background polling must not crash stdio.
      });
    }, this.options.pollIntervalMs);
    void this.pollOnce().catch(() => undefined);
  }

  stopPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private isPolling(): boolean {
    return this.pollTimer !== null;
  }

  private async pollOnceInternal(input: PollOnceInput): Promise<InboxResult> {
    try {
      if (!this.connectedResult) await this.connect();
      if (!this.cursorSeeded) {
        await this.seedFrom(this.connectedResult?.backfill);
        return this.getInbox();
      }
      this.lastPollTime = new Date(this.options.now!()).toISOString();
      this.lastError = null;
      const history = await this.fetchVisibleMessages({ catchUp: true });

      if (input.seedOnly) {
        this.seedCursor(history);
        return this.getInbox();
      }

      const accepted = this.enqueueMessages(history);
      if (accepted.length > 0) {
        await this.emitNotification(accepted);
      }
      return this.getInbox();
    } catch (err) {
      this.lastPollTime = new Date(this.options.now!()).toISOString();
      this.lastError = err instanceof Error ? err.message : String(err);
      return this.getInbox();
    }
  }

  /**
   * Fetch inbound history. When `catchUp` is set, walk `before=` pages until:
   * - the oldest page is at/before the local cursor, or
   * - there is no cursor and older pages are exhausted, or
   * - the page-safety cap is hit (surfaced as INBOX_CATCHUP_GAP).
   * Seed/replay uses `catchUp: false` (single newest page).
   */

  private maxCatchupPages(): number {
    if (this.options.maxCatchupPages && this.options.maxCatchupPages > 0) return this.options.maxCatchupPages;
    const fromEnv = Number(process.env.AGENTBRIDGE_INBOX_CATCHUP_MAX_PAGES ?? '');
    if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
    return DEFAULT_MAX_CATCHUP_PAGES;
  }

  private stateFile(): string {
    const base = this.options.stateDir ?? process.env.AGENTBRIDGE_STATE_DIR ?? join(homedir(), '.agentbridge');
    mkdirSync(base, { recursive: true });
    const key = `${this.session.slug}__${this.session.agentName}`.replace(/[^a-zA-Z0-9._-]+/g, '_');
    return join(base, `inbox-cursor-${key}.json`);
  }

  private loadCursorState(): void {
    try {
      const path = this.stateFile();
      if (!existsSync(path)) return;
      const raw = JSON.parse(readFileSync(path, 'utf8')) as {
        cursor?: MessageCursor | null;
        seenIds?: string[];
        cursorSeeded?: boolean;
      };
      if (raw.cursor) this.cursor = raw.cursor;
      if (Array.isArray(raw.seenIds)) {
        for (const id of raw.seenIds) this.seenIds.add(id);
      }
      if (raw.cursorSeeded) this.cursorSeeded = true;
    } catch {
      // ignore corrupt state
    }
  }

  private saveCursorState(): void {
    try {
      const path = this.stateFile();
      writeFileSync(
        path,
        JSON.stringify({
          cursor: this.cursor,
          seenIds: [...this.seenIds].slice(-5000),
          cursorSeeded: this.cursorSeeded,
        })
      );
    } catch {
      // best-effort
    }
  }

  private async fetchVisibleMessages(options: { catchUp: boolean }): Promise<Message[]> {
    const pageSize = Math.min(DEFAULT_HISTORY_LIMIT, this.options.inboxMaxMessages);
    const collected: Message[] = [];
    const seenInFetch = new Set<string>();
    let before: string | undefined;
    let pages = 0;
    let hitGap = false;

    while (pages < this.maxCatchupPages()) {
      pages += 1;
      const batch = await this.transport.getMessages(this.session, {
        limit: pageSize,
        before,
        include_direct: true,
      });
      if (batch.length === 0) break;

      const sorted = this.sortAscending(batch);
      for (const message of sorted) {
        if (seenInFetch.has(message.id)) continue;
        seenInFetch.add(message.id);
        collected.push(message);
      }

      const oldest = sorted[0];
      const reachedCursor =
        Boolean(this.cursor) && oldest !== undefined && !this.isAfterCursor(oldest);

      // Seed/replay: one newest page is enough.
      if (!options.catchUp) break;

      // Catch-up with a cursor: stop once this page reaches it.
      if (this.cursor && reachedCursor) break;

      // No more older rows on the relay.
      if (batch.length < pageSize) {
        // Cursor still newer than retained history → gap.
        if (this.cursor && !reachedCursor) hitGap = true;
        break;
      }

      // No progress (e.g. unknown `before` ignored by a buggy relay) → stop.
      if (before === oldest.id) {
        hitGap = Boolean(this.cursor);
        break;
      }
      before = oldest.id;
      if (pages >= this.maxCatchupPages()) {
        hitGap = true;
      }
    }

    if (hitGap && this.cursor) {
      this.lastError =
        `INBOX_CATCHUP_GAP: stopped after ${pages} page(s) (max ${this.maxCatchupPages()}) without reaching cursor ${this.cursor.id}; ` +
        `some messages may be missing. Raise AGENTBRIDGE_INBOX_CATCHUP_MAX_PAGES or pass maxCatchupPages to continue walking.`;
    }

    return this.sortAscending(collected).filter((message) => this.isVisibleInbound(message));
  }

  private enqueueMessages(messages: Message[]): Message[] {
    const accepted: Message[] = [];
    for (const message of messages) {
      if (this.seenIds.has(message.id)) continue;
      if (!this.isAfterCursor(message)) {
        this.seenIds.add(message.id);
        continue;
      }

      this.queue.push(message);
      accepted.push(message);
      this.seenIds.add(message.id);
      this.advanceCursor(message);
    }

    this.applyInboxCap();
    this.saveCursorState();
    return accepted;
  }

  /**
   * When the local queue exceeds the cap, drop the oldest unacked messages,
   * remove them from `seenIds`, rewind the cursor so they can be re-fetched, and
   * surface `INBOX_OVERFLOW` (never silent).
   */
  private applyInboxCap(): void {
    const max = this.options.inboxMaxMessages;
    if (this.queue.length <= max) return;

    const overflow = this.queue.length - max;
    const dropped = this.queue.splice(0, overflow);
    for (const message of dropped) {
      this.seenIds.delete(message.id);
    }

    // Rewind cursor to just before the first dropped message so the next poll
    // can re-fetch them (messages still in the queue remain in seenIds).
    const firstDropped = dropped[0];
    const droppedAt = Date.parse(firstDropped.created_at);
    if (Number.isNaN(droppedAt)) {
      this.cursor = null;
    } else {
      this.cursor = {
        id: `overflow-before:${firstDropped.id}`,
        createdAt: new Date(droppedAt - 1).toISOString(),
      };
    }

    this.lastError =
      `INBOX_OVERFLOW: dropped ${overflow} unacked message(s); inbox capped at ${max}. ` +
      `Dropped ids will be retried on the next poll if still present on the relay.`;
  }

  private seedCursor(messages: Message[] | undefined): void {
    const visible = this.sortAscending(messages ?? []).filter((message) => this.isVisibleInbound(message));
    for (const message of visible) {
      this.seenIds.add(message.id);
      this.advanceCursor(message);
    }
  }

  private async seedFrom(messages: Message[] | undefined): Promise<void> {
    if (messages && messages.length > 0) {
      this.seedCursor(messages);
    } else {
      this.seedCursor(await this.fetchVisibleMessages({ catchUp: false }));
    }
    this.cursorSeeded = true;
  }

  private isVisibleInbound(message: Message): boolean {
    if (this.agent?.id && message.from_agent_id === this.agent.id) return false;
    if (this.agent?.id && message.to_agent_id && message.to_agent_id !== this.agent.id) return false;
    return true;
  }

  private isAfterCursor(message: Message): boolean {
    if (!this.cursor) return true;
    const messageTime = Date.parse(message.created_at);
    const cursorTime = Date.parse(this.cursor.createdAt);
    if (Number.isNaN(messageTime) || Number.isNaN(cursorTime)) return message.id !== this.cursor.id;
    if (messageTime !== cursorTime) return messageTime > cursorTime;
    return message.id !== this.cursor.id && !this.seenIds.has(message.id);
  }

  private advanceCursor(message: Message): void {
    if (!this.cursor || this.compareMessages(message, { id: this.cursor.id, created_at: this.cursor.createdAt } as Message) > 0) {
      this.cursor = { id: message.id, createdAt: message.created_at };
    }
  }

  private compareMessages(a: Message, b: Message): number {
    const aTime = Date.parse(a.created_at);
    const bTime = Date.parse(b.created_at);
    if (!Number.isNaN(aTime) && !Number.isNaN(bTime) && aTime !== bTime) return aTime - bTime;
    return a.id.localeCompare(b.id);
  }

  private sortAscending(messages: Message[]): Message[] {
    return [...messages].sort((a, b) => this.compareMessages(a, b));
  }

  private captureConnection(result: ConnectResult): void {
    this.connectedResult = result;
    if (result.agent) this.agent = result.agent;
  }

  private async emitNotification(messages: Message[]): Promise<void> {
    const latest = messages.at(-1);
    if (!latest || !this.options.notify) return;
    await this.options.notify({
      count: this.queue.length,
      latestId: latest.id,
      session: this.session.slug,
    });
  }
}

// Defaults mirror loadTimingConfig() in config.ts so both entry points behave
// the same when no overrides are provided.
export function createMeetingInboxOptions(overrides: Partial<MeetingInboxOptions> = {}): MeetingInboxOptions {
  return {
    pollIntervalMs: overrides.pollIntervalMs ?? 1_500,
    inboxMaxMessages: overrides.inboxMaxMessages ?? 500,
    defaultReceiveTimeoutMs: overrides.defaultReceiveTimeoutMs ?? 120_000,
    maxCatchupPages: overrides.maxCatchupPages,
    stateDir: overrides.stateDir,
    notify: overrides.notify,
    now: overrides.now ?? Date.now,
    sleep: overrides.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}
