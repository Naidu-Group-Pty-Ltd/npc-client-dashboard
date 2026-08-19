/**
 * What the login page says when Cloudflare refuses.
 *
 * The classifier is unit-tested next door; this file proves the widget actually
 * WIRES it — that the code reaches the page, and that the retry button appears
 * only where trying again can work. Both were the defect: `error-callback`
 * ignored its argument, so a hostname Cloudflare will never accept rendered
 * "check your ad/script blocker" beside a Retry button that could only ever
 * fail the same way.
 */
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TurnstileWidget } from './TurnstileWidget';

vi.mock('@/contexts/WhiteLabelContext', () => ({
  useWhiteLabel: () => ({ currentTheme: 'light' }),
}));

/** The options Turnstile was rendered with, captured from the fake global. */
let renderedOptions: Record<string, any> | null = null;

beforeEach(() => {
  renderedOptions = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  (window as any).turnstile = {
    render: (_el: HTMLElement, options: Record<string, any>) => {
      renderedOptions = options;
      return 'widget-1';
    },
    reset: () => {},
    remove: () => {},
  };
  // A script tag already present is the "Turnstile is loaded" path, which is
  // what every login page after the first one sees.
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
  document.head.appendChild(script);
});

afterEach(() => {
  document.querySelectorAll('script[src*="turnstile"]').forEach((s) => s.remove());
  delete (window as any).turnstile;
  vi.restoreAllMocks();
});

function fireErrorCallback(code: unknown) {
  act(() => {
    renderedOptions?.['error-callback']?.(code);
  });
}

describe('TurnstileWidget', () => {
  it('renders with the sitekey and reports nothing before a failure', () => {
    render(<TurnstileWidget onVerify={() => {}} />);
    expect(renderedOptions?.sitekey).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('110200 names the hostname, and offers no retry', () => {
    render(<TurnstileWidget onVerify={() => {}} />);
    fireErrorCallback('110200');

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/not authorised/i);
    expect(alert.textContent).toMatch(/Hostname Management/i);
    expect(alert.textContent).toContain(window.location.hostname);
    expect(alert.textContent).toContain('110200');
    // The fix is in the Cloudflare dashboard. A retry button here is a lie.
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    // And it must not tell the visitor to go looking at their ad blocker.
    expect(alert.textContent).not.toMatch(/blocker/i);
  });

  it('200500 keeps the blocked-script advice and the retry', () => {
    render(<TurnstileWidget onVerify={() => {}} />);
    fireErrorCallback('200500');

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/blocker/i);
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('an unknown code is still shown rather than swallowed', () => {
    render(<TurnstileWidget onVerify={() => {}} />);
    fireErrorCallback('987654');
    expect(screen.getByRole('alert').textContent).toContain('987654');
  });

  it('says so when Cloudflare reported no code at all', () => {
    render(<TurnstileWidget onVerify={() => {}} />);
    fireErrorCallback(undefined);
    expect(screen.getByRole('alert').textContent).toMatch(/no error code/i);
  });

  it('tells the parent to drop the token on every failure', () => {
    const onError = vi.fn();
    render(<TurnstileWidget onVerify={() => {}} onError={onError} />);
    fireErrorCallback('110200');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('logs the code, the hostname and the sitekey once per code', () => {
    render(<TurnstileWidget onVerify={() => {}} />);
    fireErrorCallback('110200');
    // Cloudflare re-fires on its own retry schedule; one log per code is enough.
    fireErrorCallback('110200');

    expect(console.error).toHaveBeenCalledTimes(1);
    const logged = String((console.error as any).mock.calls[0][0]);
    expect(logged).toContain('110200');
    expect(logged).toContain(window.location.hostname);
  });

  it('clears the alert once a token arrives', () => {
    const onVerify = vi.fn();
    render(<TurnstileWidget onVerify={onVerify} />);
    fireErrorCallback('300030');
    expect(screen.getByRole('alert')).toBeTruthy();

    act(() => { renderedOptions?.callback?.('token-abc'); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onVerify).toHaveBeenCalledWith('token-abc');
  });
});
