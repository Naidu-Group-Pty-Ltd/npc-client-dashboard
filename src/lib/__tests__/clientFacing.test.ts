import { describe, expect, it } from 'vitest';
import {
  CLIENT_FACING_HIDDEN_PATHS,
  isDeveloperToolPath,
  isPathVisibleInDeployment,
  resolveClientFacingFlag,
} from '../clientFacing';
import { ADMIN_NAVIGATION_ITEMS, NAVIGATION_ITEMS } from '@/lib/navigation/registry';

describe('resolveClientFacingFlag', () => {
  it('enables only on an explicit opt-in', () => {
    expect(resolveClientFacingFlag('true')).toBe(true);
    expect(resolveClientFacingFlag('1')).toBe(true);
    expect(resolveClientFacingFlag(true)).toBe(true);
  });

  it('stays off for everything else — an unset flag must change nothing', () => {
    expect(resolveClientFacingFlag(undefined)).toBe(false);
    expect(resolveClientFacingFlag('')).toBe(false);
    expect(resolveClientFacingFlag('false')).toBe(false);
    expect(resolveClientFacingFlag('0')).toBe(false);
    expect(resolveClientFacingFlag(false)).toBe(false);
    expect(resolveClientFacingFlag('yes')).toBe(false);
  });
});

describe('CLIENT_FACING_HIDDEN_PATHS hygiene', () => {
  it('entries are absolute, unduplicated, and carry no trailing slash', () => {
    for (const path of CLIENT_FACING_HIDDEN_PATHS) {
      expect(path.startsWith('/')).toBe(true);
      expect(path.endsWith('/')).toBe(false);
    }
    expect(new Set(CLIENT_FACING_HIDDEN_PATHS).size).toBe(CLIENT_FACING_HIDDEN_PATHS.length);
  });
});

describe('isDeveloperToolPath', () => {
  it('matches an entry exactly and anything underneath it', () => {
    expect(isDeveloperToolPath('/integrations')).toBe(true);
    expect(isDeveloperToolPath('/integrations/')).toBe(true);
    expect(isDeveloperToolPath('/integrations/ghl-migration')).toBe(true);
    expect(isDeveloperToolPath('/workflow-playground')).toBe(true);
    expect(isDeveloperToolPath('/admin/pdf-import-diagnostics')).toBe(true);
  });

  it('never matches by string prefix alone', () => {
    // `/integrations-summary` would be a different page, not a child.
    expect(isDeveloperToolPath('/integrations-summary')).toBe(false);
    expect(isDeveloperToolPath('/sourcess')).toBe(false);
  });

  it('leaves the client surfaces alone', () => {
    for (const path of [
      '/',
      '/listings',
      '/listings/abc-123',
      '/reports',
      '/call-logs',
      '/clients',
      '/billing',
      '/settings',
      '/templates',
      '/admin/users',
      '/admin/template-builder',
      '/admin/aml',
    ]) {
      expect(isDeveloperToolPath(path), path).toBe(false);
    }
  });
});

describe('isPathVisibleInDeployment', () => {
  it('hides developer tooling only in client-facing mode', () => {
    expect(isPathVisibleInDeployment('/integrations', true)).toBe(false);
    expect(isPathVisibleInDeployment('/integrations', false)).toBe(true);
    expect(isPathVisibleInDeployment('/listings', true)).toBe(true);
  });
});

describe('against the navigation registry', () => {
  const allItems = [...NAVIGATION_ITEMS, ...ADMIN_NAVIGATION_ITEMS];

  it('removes the named operator tools from a client-facing deployment', () => {
    const hiddenTitles = allItems
      .filter((item) => !isPathVisibleInDeployment(item.url, true))
      .map((item) => item.title);
    for (const title of [
      'Integrations',
      'Workflow Playground',
      'Cloudflare',
      'API Usage',
      'Model Hub',
      'Monitoring',
      'Quality Assurance',
      'Error Logs',
      'Sources',
      'Token Audit Log',
      'PDF Import Engine',
      'PDF Import Diagnostics',
      'BC Segment Engine',
      'Reclassify Property',
    ]) {
      expect(hiddenTitles, title).toContain(title);
    }
  });

  it('keeps every client-workspace feature visible', () => {
    const visibleTitles = allItems
      .filter((item) => isPathVisibleInDeployment(item.url, true))
      .map((item) => item.title);
    for (const title of [
      'Overview',
      'Property Marketplace',
      'Reports',
      'Call Logs',
      'Clients',
      'Billing & Usage',
      'Templates',
      'Template Builder',
      'Branding',
      'Settings',
      'User Management',
      'Client Portal',
      'Support',
    ]) {
      expect(visibleTitles, title).toContain(title);
    }
  });

  it('hides nothing when the deployment is the internal console', () => {
    expect(allItems.filter((item) => !isPathVisibleInDeployment(item.url, false))).toEqual([]);
  });
});

/**
 * WIP cherry-pick candidates — one `it` per candidate commit, so reverting a
 * commit removes its expectation together with its list entry.
 */
describe('WIP cherry-pick candidates', () => {
  it('hides Data Import', () => {
    expect(isDeveloperToolPath('/data-import')).toBe(true);
  });

  it('hides the Depreciation Comps admin', () => {
    expect(isDeveloperToolPath('/admin/depreciation-comps')).toBe(true);
  });

  it('hides the Figma Templates admin', () => {
    expect(isDeveloperToolPath('/admin/figma-templates')).toBe(true);
  });

  it('hides Activity Logs', () => {
    expect(isDeveloperToolPath('/admin/activity-logs')).toBe(true);
  });
});
