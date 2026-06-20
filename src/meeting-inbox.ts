import type { Agent, AgentBridgeSession, ConnectResult, Message, Transport } from './transport.js';

export interface MeetingInboxOptions {
  pollIntervalMs: number;
  inboxMaxMessages: number;
  defaultReceiveTimeoutMs: number;
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

export class MeetingInbox {
  private connectedResult: ConnectResult | null = null;
  private agent: Agent | null = null;
  private queue: Message[] = [];
  private seenIds = new Set<string>();
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
    const result = await this.connectFn(capabilities);
    this.captureConnection(result);
    return result;
  }

  async join(input: JoinMeetingInput = {}): Promise<MeetingStatus & { seeded: boolean; replayed: number }> {
    const result = await this.connect(input.capabilities ?? []);
    const replayHistory = input.replayHistory ?? false;
    let replayed = 0;

    if (replayHistory) {
      const history = await this.fetchVisibleMessages();
      const accepted = this.enqueueMessages(history);
      this.cursorSeeded = true;
      replayed = accepted.length;
    } else {
      await this.seedFrom(result.backfill);
    }

    if (input.startPolling ?? true) this.startPolling();
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
      const history = await this.fetchVisibleMessages();
      this.lastPollTime = new Date(this.options.now!()).toISOString();
      this.lastError = null;

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

  private async fetchVisibleMessages(): Promise<Message[]> {
    const messages = await this.transport.getMessages(this.session, {
      limit: Math.min(DEFAULT_HISTORY_LIMIT, this.options.inboxMaxMessages),
      include_direct: true,
    });
    return this.sortAscending(messages).filter((message) => this.isVisibleInbound(message));
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

    if (this.queue.length > this.options.inboxMaxMessages) {
      this.queue = this.queue.slice(this.queue.length - this.options.inboxMaxMessages);
    }
    return accepted;
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
      this.seedCursor(await this.fetchVisibleMessages());
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
    const latest = messages[messages.length - 1];
    if (!latest || !this.options.notify) return;
    await this.options.notify({
      count: this.queue.length,
      latestId: latest.id,
      session: this.session.slug,
    });
  }
}

export function createMeetingInboxOptions(overrides: Partial<MeetingInboxOptions> = {}): MeetingInboxOptions {
  return {
    pollIntervalMs: overrides.pollIntervalMs ?? 3_000,
    inboxMaxMessages: overrides.inboxMaxMessages ?? 500,
    defaultReceiveTimeoutMs: overrides.defaultReceiveTimeoutMs ?? 30_000,
    notify: overrides.notify,
    now: overrides.now ?? Date.now,
    sleep: overrides.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}
