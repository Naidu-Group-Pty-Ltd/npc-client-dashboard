import { useEffect, useState } from "react";
import {
  Lock,
  ExternalLink,
  LifeBuoy,
  LogOut,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useAuth } from "@/hooks/useAuth";
import { usePaymentGate } from "@/hooks/usePaymentGate";
import { startActivationCheckout } from "@/lib/paymentGate/client";
import {
  formatMoney,
  formatRemaining,
  lockedCopy,
  remainingMs,
} from "@/lib/paymentGate/state";
import { toast } from "sonner";

/**
 * What a locked workspace shows instead of the dashboard.
 *
 * ## It is a door, not a wall
 *
 * The one thing this screen exists to do is get somebody paid and back to
 * work, so the payment is a single primary button that goes straight to
 * Stripe. Everything else on the page is secondary: what the plan is, what it
 * costs, that their data is untouched, how to reach a human, and how to sign
 * out. There is no form, nothing to read before acting, and no dead end — if
 * minting the Stripe session fails the button becomes a link to the pricing
 * page, which can always take a payment.
 *
 * ## It never blames the reader
 *
 * The person looking at this may have joined last week and have no idea a
 * payment was owed. The copy is about the ACCOUNT — see `lockedCopy` — and it
 * never claims a payment failed, because this build cannot know that.
 */
export function PaymentGateScreen() {
  const { verdict, refresh } = usePaymentGate();
  const { signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);

  const copy = lockedCopy(verdict);
  const price = formatMoney(
    verdict.plan?.amountDueCents ?? null,
    verdict.plan?.currency ?? "AUD",
  );
  const planLabel = verdict.plan?.name ?? verdict.plan?.slug ?? null;

  // Returning from Stripe, the webhook may land a beat after the redirect.
  // Re-reading a few times turns "I paid and it still says locked" into a
  // screen that opens by itself.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("activation") !== "success") return;
    let cancelled = false;
    let attempts = 0;
    const tick = () => {
      if (cancelled || attempts >= 10) return;
      attempts += 1;
      void refresh().then(() => {
        if (!cancelled) setTimeout(tick, 3000);
      });
    };
    tick();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  async function pay() {
    setBusy(true);
    try {
      const result = await startActivationCheckout(window.location.origin);
      switch (result.ok) {
        case true:
          // Same tab: this IS the task. A new tab leaves a dead lock screen
          // behind that the customer comes back to and reads as "it didn't work".
          window.location.assign(result.url);
          return;
        case false:
          if (result.pricingUrl) {
            setFallbackUrl(result.pricingUrl);
            toast.error(
              "Could not open the payment page automatically — use the link below.",
            );
          } else {
            toast.error(
              "Could not start the payment. Please try again, or contact support.",
            );
          }
          return;
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background p-4">
      <div className="w-full max-w-lg space-y-6 rounded-lg border border-border bg-card p-6 shadow-sm sm:p-8">
        <div className="flex items-start gap-4">
          <span
            aria-hidden
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"
          >
            <Lock className="h-5 w-5" />
          </span>
          <div className="min-w-0 space-y-1">
            <h1 className="text-xl font-semibold tracking-tight">
              {copy.headline}
            </h1>
            <p className="text-sm text-muted-foreground">{copy.body}</p>
          </div>
        </div>

        {(planLabel || price) && verdict.reason !== "operator_locked" && (
          <dl className="space-y-2 rounded-md border border-border bg-muted/40 p-4 text-sm">
            {planLabel && (
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-muted-foreground">Plan</dt>
                <dd className="font-medium">{planLabel}</dd>
              </div>
            )}
            {price && (
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-muted-foreground">Amount</dt>
                <dd className="font-medium">
                  {price}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    per month
                  </span>
                </dd>
              </div>
            )}
          </dl>
        )}

        {verdict.reason !== "operator_locked" && (
          <div className="space-y-3">
            <Button size="lg" className="w-full" onClick={pay} disabled={busy}>
              {busy ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Opening secure checkout…
                </>
              ) : (
                <>
                  <ShieldCheck className="mr-2 h-4 w-4" />
                  {price
                    ? `Pay ${price} and unlock`
                    : "Complete payment and unlock"}
                </>
              )}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              Payment is taken by Aurixa Systems through Stripe. Your workspace
              unlocks the moment it clears — usually within a few seconds.
            </p>
          </div>
        )}

        {fallbackUrl && (
          <Alert>
            <ExternalLink className="h-4 w-4" />
            <AlertDescription>
              <a
                href={fallbackUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium underline underline-offset-4"
              >
                Open the Aurixa Systems payment page
              </a>{" "}
              to complete your activation.
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 text-sm">
          <div className="flex flex-wrap gap-3">
            <a
              href="mailto:support@aurixasystems.com.au"
              className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
            >
              <LifeBuoy className="h-3.5 w-3.5" />
              Contact support
            </a>
            <button
              type="button"
              onClick={() => void refresh()}
              className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
            >
              <RefreshCw className="h-3.5 w-3.5" />I have already paid
            </button>
          </div>
          <button
            type="button"
            onClick={() => void signOut()}
            className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The countdown, shown INSIDE a working dashboard while the window is open.
 *
 * A lock that arrives with no warning is the failure this prevents: by the
 * time the screen above appears the customer has already lost access, and
 * nobody told them it was coming. It is dismissible for the session — a banner
 * that cannot be closed is one people stop reading.
 */
export function PaymentGateBanner() {
  const { verdict, warning } = usePaymentGate();
  const [dismissed, setDismissed] = useState(false);
  const [, setTick] = useState(0);

  // Re-render each minute so the countdown is the time now, not the time the
  // verdict was fetched.
  useEffect(() => {
    if (!warning) return;
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [warning]);

  if (!warning || dismissed) return null;

  const left = formatRemaining(remainingMs(verdict));
  const price = formatMoney(
    verdict.plan?.amountDueCents ?? null,
    verdict.plan?.currency ?? "AUD",
  );

  return (
    <Alert className="mb-4 border-warning/40 bg-warning/5">
      <Lock className="h-4 w-4" />
      <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm">
          <span className="font-medium">Activate your workspace</span>
          {left && left !== "none" ? ` — ${left} left` : ""}
          {price ? `. ${price} per month.` : "."}
        </span>
        <span className="flex shrink-0 gap-2">
          <ActivateNowButton />
          <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
            Later
          </Button>
        </span>
      </AlertDescription>
    </Alert>
  );
}

function ActivateNowButton() {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const result = await startActivationCheckout(window.location.href);
        switch (result.ok) {
          case true:
            window.location.assign(result.url);
            break;
          case false:
            setBusy(false);
            if (result.pricingUrl)
              window.open(result.pricingUrl, "_blank", "noopener,noreferrer");
            else toast.error("Could not start the payment. Please try again.");
            break;
        }
      }}
    >
      {busy ? <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
      Activate now
    </Button>
  );
}
