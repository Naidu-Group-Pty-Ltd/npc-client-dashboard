/**
 * The migration object index is generated and must stay current, because a
 * consumer reads an absent name as "never ours" — the reading that would let
 * one of this repository's own leftovers pass as a tenant's data.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildIndex } from "../../../scripts/build-migration-object-index.mjs";

const committed = JSON.parse(readFileSync("supabase/migration-object-index.json", "utf8"));

describe("the committed index matches the migrations it describes", () => {
  it("regenerating produces exactly what is committed", () => {
    // The same assertion `npm run migrations:index:check` makes in CI, kept
    // here too so a local run catches it before the push.
    expect(buildIndex()).toEqual(committed);
  });

  it("carries a schema version, so a consumer can tell an old index apart", () => {
    expect(committed.schema_version).toBe(1);
  });
});

describe("it records what this repository created and what it dropped", () => {
  it("finds the object that started this: created, then dropped", () => {
    // `public.builder_design_images` is present on a tenant provisioned from
    // this repository and in no schema here — created by
    // 20261102000000_builder_design_images.sql and dropped by
    // 20261104000000_builder_stock_withdraw_design_renders.sql. That pair is
    // what makes it OUR leftover rather than the tenant's own table.
    expect(committed.created).toContain("table:public.builder_design_images");
    expect(committed.dropped).toContain("table:public.builder_design_images");
  });

  it("is a real corpus rather than a stub", () => {
    expect(committed.migration_files).toBeGreaterThan(900);
    expect(committed.created.length).toBeGreaterThan(2000);
  });

  it("every entry is a lowercased class:name pair with no quotes", () => {
    for (const entry of [...committed.created, ...committed.dropped]) {
      expect(entry).toMatch(/^[a-z_]+:[^"\s]+$/);
      expect(entry).toBe(entry.toLowerCase());
    }
  });

  it("names nothing this repository never had", () => {
    // A tenant's own object must not appear, or the classifier downstream
    // would call it ours and offer it for removal.
    expect(committed.created).not.toContain("table:public.a_tenant_invented_this");
  });
});
