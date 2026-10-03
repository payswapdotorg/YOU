'use client';
// ═══════════════════════════════════════════════════════════════════════════
// YOU Studio — view-level error boundary (Worker B lane, P6.B8).
//
// Next.js convention note: route segments use error.tsx boundaries; the
// Studio is a single-route SPA that swaps views client-side, so the
// equivalent boundary is this class component wrapped around the active
// view in app/page.tsx. A render crash in ANY view degrades to this honest
// surface instead of a blank page: it names the view that crashed, shows
// the real error, and offers recovery (back to Overview). It never renders
// fabricated content on top of a crash.
// ═══════════════════════════════════════════════════════════════════════════
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { OctagonAlert, RotateCcw } from 'lucide-react';

interface ViewErrorBoundaryProps {
  /** Active view id — boundary resets when the user navigates to another view. */
  view: string;
  /** Human label for the crashed view (from VIEW_TITLES). */
  viewLabel: string;
  /** Recovery action — navigate somewhere safe (usually Overview). */
  onRecover: () => void;
  children: ReactNode;
}

interface ViewErrorBoundaryState {
  error: Error | null;
}

export class ViewErrorBoundary extends Component<ViewErrorBoundaryProps, ViewErrorBoundaryState> {
  state: ViewErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ViewErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // honest server-console trace; never swallowed
    console.error('[you/studio] view render crashed:', error, info.componentStack ?? '');
  }

  componentDidUpdate(prev: ViewErrorBoundaryProps): void {
    // navigating to a different view gives that view a fresh mount —
    // a crash in Renders must not brick Twins
    if (prev.view !== this.props.view && this.state.error) {
      this.setState({ error: null });
    }
  }

  recover = (): void => {
    this.setState({ error: null });
    this.props.onRecover();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        data-you-view-crash="true"
        className="flex flex-col items-center justify-center gap-3 rounded-xl border border-red-500/25 bg-red-500/[0.04] px-6 py-14 text-center"
      >
        <div className="flex size-11 items-center justify-center rounded-full bg-red-500/10">
          <OctagonAlert className="size-5 text-red-600 dark:text-red-400" aria-hidden />
        </div>
        <div className="space-y-1">
          <div className="flex flex-wrap items-center justify-center gap-2 font-medium">
            The {this.props.viewLabel} view crashed
            <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">
              view: {this.props.view}
            </Badge>
          </div>
          <p className="mx-auto max-w-md text-sm text-muted-foreground">
            This is a render failure in the Studio UI — your data on the backend is unaffected. The honest error is below.
          </p>
        </div>
        <pre className="you-scroll max-w-lg overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/60 px-3 py-2 text-left font-mono text-[11px] text-muted-foreground">
          {error.message || String(error)}
        </pre>
        <Button size="sm" variant="outline" className="gap-1.5" onClick={this.recover} data-you-view-crash-recover>
          <RotateCcw className="size-3.5" aria-hidden /> Back to Overview
        </Button>
      </div>
    );
  }
}
