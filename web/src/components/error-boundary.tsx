import { Component, type ErrorInfo, type ReactNode } from 'react';

import { i18n } from '@/i18n/i18n';
import { reportClientError } from '@/lib/client-error-reporter';

interface Props {
  readonly children: ReactNode;
}

interface State {
  readonly hasError: boolean;
}

/**
 * App-level React error boundary.
 *
 * Catches render/lifecycle crashes anywhere in the cabinet tree, forwards
 * them (with the React componentStack) to the client-error reporter so the
 * operator sees them in the rezeis firehose, and shows a minimal recovery
 * screen instead of a white page. The narrow `EffectErrorBoundary` around
 * the WebGL card effect stays as-is; this is the global net.
 */
export class AppErrorBoundary extends Component<Props, State> {
  public state: State = { hasError: false };

  public static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  public componentDidCatch(error: unknown, info: ErrorInfo): void {
    reportClientError({
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      componentStack: info.componentStack ?? undefined,
      kind: 'react.errorBoundary',
    });
  }

  private readonly handleReload = (): void => {
    if (typeof window !== 'undefined') window.location.reload();
  };

  public render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-(--brand-bg-primary) px-6 text-center">
        <div className="text-lg font-semibold text-white">{i18n.t('errorBoundary.title')}</div>
        <p className="max-w-sm text-sm text-white/70">{i18n.t('errorBoundary.body')}</p>
        <button
          type="button"
          onClick={this.handleReload}
          className="rounded-xl bg-(--brand-primary) px-5 py-2.5 text-sm font-medium text-white"
        >
          {i18n.t('errorBoundary.reload')}
        </button>
      </div>
    );
  }
}
