/**
 * The platform's own mark — what a clone shows when its brand settings are empty.
 *
 * Named in ONE place because three surfaces reach for it (the tab icon, the
 * apple-touch tile, and the desktop notification shade) and a literal at each
 * end is how three ends drift. `index.html` declares the same path for the
 * pre-hydration paint; `platformBrand.spec.ts` asserts the two agree, because
 * a mismatch means the tab flickers from one mark to another on every load.
 *
 * ## Why this exists as a module rather than a default argument
 *
 * `BrandProvider` used to write the tenant's favicon and then `return` early
 * when there was none:
 *
 *     const favicon = getBrandAssetSrc(settings, 'favicon');
 *     if (!favicon) return;
 *
 * That is correct on a first load — the static `<link>` in `index.html` is
 * already the platform mark — and wrong the moment a tenant CLEARS their
 * favicon: the href written by the previous render stays on the element, so
 * the tab keeps showing a mark the workspace no longer has, until a full
 * reload. Reverting needs something to revert TO, which is this.
 */

/** The Aurixa Systems emblem. Must match the `<link rel="icon">` in `index.html`. */
export const PLATFORM_FAVICON = '/brand/aurixa-notification-192.png';

/** The same mark at tile size, for iOS home screens. */
export const PLATFORM_APPLE_TOUCH_ICON = '/icons/apple-touch-icon.png';

/**
 * The mark to paint for a workspace, given whatever its brand settings resolve
 * to. Never returns null: an unbranded clone is an Aurixa deployment, not a
 * deployment with no identity.
 */
export function faviconFor(brandFavicon: string | null | undefined): string {
  const trimmed = brandFavicon?.trim();
  return trimmed ? trimmed : PLATFORM_FAVICON;
}

/** The apple-touch tile, on the same rule. */
export function appleTouchIconFor(brandFavicon: string | null | undefined): string {
  const trimmed = brandFavicon?.trim();
  return trimmed ? trimmed : PLATFORM_APPLE_TOUCH_ICON;
}
