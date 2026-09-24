/**
 * The gate in `testSupport/primeTree.ts` decides whether the assertions about
 * the prime's own files run at all, so it must never close quietly where they
 * belong. A gate that could go shut on the prime would turn those assertions
 * into skips and report the run green.
 */
import { describe, expect, it } from 'vitest';
import { TREE_IS_PRIME, declaredProjectRef } from '../../testSupport/primeTree';

describe('the prime-tree gate', () => {
  it('reads the project a config declares, and refuses a config that declares none', () => {
    expect(declaredProjectRef('project_id = "abcdefghijklmnopqrst"\n\n[api]\nport = 54321\n')).toBe(
      'abcdefghijklmnopqrst',
    );
    expect(() => declaredProjectRef('[api]\nport = 54321\n')).toThrow(/declares no project_id/);
  });

  // GitHub sets GITHUB_REPOSITORY on every Actions run. On the prime's own runs
  // the gate must be open; on a clone's runs, and locally, this says nothing.
  it.runIf(process.env.GITHUB_REPOSITORY?.toLowerCase() === 'naidu-group-pty-ltd/npc-property-dashbord')(
    "is open on the prime's own CI, so the assertions it gates run there",
    () => {
      expect(TREE_IS_PRIME).toBe(true);
    },
  );
});
