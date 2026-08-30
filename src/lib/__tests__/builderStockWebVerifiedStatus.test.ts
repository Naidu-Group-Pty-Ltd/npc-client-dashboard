/**
 * BUILDER STOCK — THE COLUMN REFUSED THE ONLY DISPLAYABLE WEB STATE.
 *
 * `isVerifiedWebImage` will show a web result only in the state
 * `WEB_VERIFIED_VERIFICATION`, and the table's CHECK constraint listed three
 * values that did not include it. Every write of a verified web image — from
 * the search path and from the re-judgement path alike — was rejected by
 * Postgres.
 *
 * 439 stored candidates in production, every one `unverified`, not one ever
 * shown. It is the fault that made the other three invisible: with it in
 * place, fixing the veto ordering and re-judging stale verdicts changes
 * nothing anybody can see.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { WEB_VERIFIED_VERIFICATION } from '../../../supabase/functions/_shared/builderStock/imagePriority.pure';

const MIGRATION = readFileSync(
  'supabase/migrations/20261029000000_builder_stock_web_verified_status.sql', 'utf8');

describe('what the code writes, the column accepts', () => {
  it('the constraint names the constant the code uses', () => {
    // Written from the constant rather than beside it, so the two cannot drift.
    expect(MIGRATION).toContain(`'${WEB_VERIFIED_VERIFICATION}'::text`);
  });

  it('the three existing states are kept, not replaced', () => {
    for (const kept of ['source_supplied', 'location_derived', 'unverified']) {
      expect(MIGRATION).toContain(`'${kept}'::text`);
    }
  });

  it('it widens what may be RECORDED and nothing about what is SHOWN', () => {
    // `isVerifiedWebImage` is still the only thing that decides display, and
    // it demands evidence this migration cannot fabricate.
    const priority = readFileSync(
      'supabase/functions/_shared/builderStock/imagePriority.pure.ts', 'utf8');
    expect(priority).toContain('export function isVerifiedWebImage');
    expect(priority).toContain('property_identity');
    expect(MIGRATION).not.toMatch(/UPDATE public\.builder_stock_item_images/);
  });

  it('hands the affected properties back to the ladder, at no cost', () => {
    // A property whose candidate now verifies answers `none` before either
    // paid rung is considered, so promotion spends nothing.
    expect(MIGRATION).toContain('image_ladder_generation_at = now()');
    expect(MIGRATION).toContain('ensure_builder_stock_settlement_scheduled');
  });

  it('names no deployment identifier', () => {
    const bare = MIGRATION.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*--.*$/gm, ' ');
    expect(bare).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
    expect(bare).not.toMatch(/https?:\/\//);
  });
});
