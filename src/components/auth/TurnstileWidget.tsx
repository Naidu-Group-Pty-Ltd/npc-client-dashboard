import { useEffect, useRef, useState, useCallback } from 'react';
import { useWhiteLabel } from '@/contexts/WhiteLabelContext';
import { AlertCircle, RefreshCw } from 'lucide-react';
import {
  TURNSTILE_SITE_KEY,
  TURNSTILE_SCRIPT_UNREACHABLE,
  classifyTurnstileFault,
  type TurnstileFault,
} from '@/lib/security/turnstile';

const TURNSTILE_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad';

// How long to wait for challenges.cloudflare.com before telling the user.
// A blocked request often does not fail — it hangs — so `onerror` alone never
// fires and the widget silently never appears.
const TURNSTILE_LOAD_TIMEOUT_MS = 12000;

declare global {
  interface Window {
    turnstile?: {
      render: (element: HTMLElement, options: Record<string, any>) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
    };
    onTurnstileLoad?: () => void;
  }
}

interface TurnstileWidgetProps {
  onVerify: (token: string) => void;
  onExpire?: () => void;
  onError?: () => void;
}

export function TurnstileWidget({ onVerify, onExpire, onError }: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const { currentTheme } = useWhiteLabel();

  // The Sign In button is disabled until this widget produces a token, and the
  // server refuses a login without one — so when the widget cannot load, the
  // page looks fine and simply cannot be used. Saying WHICH failure this is (and
  // offering a retry only where one can help) is the difference between a fault
  // somebody can act on and "the login page is broken". The requirement itself
  // is never relaxed.
  const [fault, setFault] = useState<TurnstileFault | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Cloudflare re-fires `error-callback` on its own retry schedule, so log a
  // given code once rather than once every eight seconds.
  const loggedCodeRef = useRef<string | null>(null);

  const reportFault = useCallback((next: TurnstileFault) => {
    setFault(next);
    if (loggedCodeRef.current !== next.code) {
      loggedCodeRef.current = next.code;
      const host = typeof window !== 'undefined' ? window.location.hostname : '(no window)';
      console.error(
        `[Turnstile] ${next.code || 'no code'} on ${host} (sitekey ${TURNSTILE_SITE_KEY}) — ${next.remedy}`,
      );
    }
  }, []);

  // Keep latest callbacks in refs so the widget never re-renders when parent
  // passes inline arrow functions (which change identity on every keystroke).
  const onVerifyRef = useRef(onVerify);
  const onExpireRef = useRef(onExpire);
  const onErrorRef = useRef(onError);
  useEffect(() => { onVerifyRef.current = onVerify; }, [onVerify]);
  useEffect(() => { onExpireRef.current = onExpire; }, [onExpire]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  const renderWidget = useCallback(() => {
    if (!containerRef.current || !window.turnstile) return;
    // Remove existing widget if any
    if (widgetIdRef.current) {
      try { window.turnstile.remove(widgetIdRef.current); } catch {}
      widgetIdRef.current = null;
    }
    widgetIdRef.current = window.turnstile.render(containerRef.current, {
      sitekey: TURNSTILE_SITE_KEY,
      callback: (token: string) => {
        setFault(null);
        loggedCodeRef.current = null;
        onVerifyRef.current?.(token);
      },
      'expired-callback': () => onExpireRef.current?.(),
      // Cloudflare passes its error code here. Dropping it is what made every
      // failure — a hostname it will never accept, a disabled key, a blocked
      // script — read as the same "check your ad blocker" on the page.
      'error-callback': (code?: unknown) => {
        reportFault(
          classifyTurnstileFault(
            code,
            typeof window !== 'undefined' ? window.location.hostname : undefined,
          ),
        );
        onErrorRef.current?.();
      },
      theme: currentTheme === 'dark' ? 'dark' : 'light',
    });
  }, [currentTheme, reportFault]);

  useEffect(() => {
    const existing = document.querySelector<HTMLScriptElement>('script[src*="turnstile"]');

    const loadScript = () => {
      const script = document.createElement('script');
      script.src = TURNSTILE_SCRIPT_SRC;
      script.async = true;
      script.onerror = () => reportFault(TURNSTILE_SCRIPT_UNREACHABLE);
      window.onTurnstileLoad = renderWidget;
      document.head.appendChild(script);
    };

    if (!existing) {
      loadScript();
    } else if (window.turnstile) {
      renderWidget();
    } else if (attempt > 0) {
      // A retry after the previous script tag never produced `window.turnstile`:
      // that tag will not fire again, so replace it rather than waiting on it.
      existing.remove();
      loadScript();
    } else {
      window.onTurnstileLoad = renderWidget;
    }

    // `onerror` does not fire for a request that is merely hanging, and a
    // proxy or extension that swallows the script produces no event at all.
    const timer = window.setTimeout(() => {
      if (!widgetIdRef.current) reportFault(TURNSTILE_SCRIPT_UNREACHABLE);
    }, TURNSTILE_LOAD_TIMEOUT_MS);

    return () => {
      window.clearTimeout(timer);
      if (widgetIdRef.current && window.turnstile) {
        try { window.turnstile.remove(widgetIdRef.current); } catch {}
        widgetIdRef.current = null;
      }
    };
  }, [renderWidget, attempt, reportFault]);

  const retry = () => {
    setFault(null);
    loggedCodeRef.current = null;
    onErrorRef.current?.();
    setAttempt(a => a + 1);
  };

  return (
    <div className="flex flex-col items-center gap-2 py-2">
      <div
        ref={containerRef}
        className="rounded-lg border border-border bg-card p-1 shadow-sm ring-1 ring-primary/10"
      />
      {fault && (
        <div className="flex flex-col items-center gap-2 text-center" role="alert">
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden="true" />
            <span>
              <span className="font-medium text-foreground">{fault.summary}</span>{' '}
              <span>{fault.remedy}</span>
            </span>
          </p>
          {/* Carried on the page so a screenshot is enough to diagnose it. */}
          <p className="select-text text-[11px] text-muted-foreground/80">
            Turnstile {fault.code ? `error ${fault.code}` : 'reported no error code'}
            {typeof window !== 'undefined' ? ` · ${window.location.hostname}` : ''}
          </p>
          {/* Offered only where trying again can succeed. A hostname Cloudflare
              refuses, or a disabled key, fails identically for ever. */}
          {fault.retryable && (
            <button
              type="button"
              onClick={retry}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <RefreshCw className="h-3 w-3" aria-hidden="true" />
              Retry security check
            </button>
          )}
        </div>
      )}
    </div>
  );
}
