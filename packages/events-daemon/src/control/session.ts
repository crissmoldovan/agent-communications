import { randomBytes, timingSafeEqual } from 'node:crypto';

export interface ControlSession {
  readonly id: string;
  readonly version: number;
  readonly expiresAt: number;
  readonly requestIds: Set<string>;
}

export class ControlSessions {
  #sessions = new Map<string, ControlSession>();
  private readonly options: { readonly now?: () => number; readonly ttlMs?: number };

  constructor(options: { readonly now?: () => number; readonly ttlMs?: number } = {}) {
    this.options = options;
  }

  create(version: number): ControlSession {
    this.prune();
    const session: ControlSession = {
      id: randomBytes(24).toString('base64url'),
      version,
      expiresAt: this.now() + (this.options.ttlMs ?? 60_000),
      requestIds: new Set(),
    };
    this.#sessions.set(session.id, session);
    return session;
  }

  get(id: string, version: number): ControlSession | null {
    const session = this.#sessions.get(id);
    if (!session || session.version !== version || session.expiresAt <= this.now()) {
      if (session) this.#sessions.delete(id);
      return null;
    }
    return session;
  }

  close(): void {
    this.#sessions.clear();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private prune(): void {
    const now = this.now();
    for (const [id, session] of this.#sessions) if (session.expiresAt <= now) this.#sessions.delete(id);
  }
}

export function matchesControlToken(expected: string, received: string): boolean {
  const expectedBytes = Buffer.from(expected, 'utf8');
  const receivedBytes = Buffer.from(received, 'utf8');
  return expectedBytes.byteLength === receivedBytes.byteLength && timingSafeEqual(expectedBytes, receivedBytes);
}
