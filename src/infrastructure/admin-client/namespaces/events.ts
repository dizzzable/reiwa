/**
 * Events namespace — the reiwa → rezeis-admin event reporter channel.
 *
 * `EventReporter` (in `lib/event-reporter.ts`) is the only direct
 * consumer; pages and use-cases call EventReporter convenience helpers
 * (`info` / `warn` / `error`) which fan out through this namespace.
 *
 * Fire-and-forget by contract: caller swallows any rejection so a
 * down upstream never blocks the originating app turn. The namespace
 * itself does NOT swallow — it returns the promise so EventReporter
 * stays in control of error policy.
 */
import type { AdminTransport } from '../transport.js';

export type EventSeverity = 'INFO' | 'WARNING' | 'ERROR';
export type EventCategory = 'USER' | 'AUTH' | 'SYSTEM' | 'SUBSCRIPTION' | 'PAYMENT';

export interface EventInput {
  readonly type: string;
  readonly category: EventCategory;
  readonly severity: EventSeverity;
  readonly message: string;
  readonly metadata?: Record<string, unknown>;
}

export class EventsNamespace {
  constructor(private readonly transport: AdminTransport) {}

  emit(event: EventInput): Promise<unknown> {
    return this.transport.request('POST', '/api/internal/events', {
      type: event.type,
      category: event.category,
      severity: event.severity,
      message: event.message,
      metadata: {
        source: 'reiwa',
        ...(event.metadata ?? {}),
      },
    });
  }
}
