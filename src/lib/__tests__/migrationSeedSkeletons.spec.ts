/**
 * The seed skeleton manifest, and the reader that makes it.
 *
 * Mission Control takes a template-library seed's dependency facts from the
 * skeleton published here, and uses an entry only where its blob id is the one
 * its own listing reports for the file. So three things have to be true: the
 * committed manifest is current, its blob ids are git's, and the reader finds
 * the same statements whatever the file looks like around the rows. See
 * `scripts/build-migration-seed-skeletons.mjs`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  MIN_SKELETON_BYTES,
  buildSeedSkeletons,
  gitBlobSha,
} from "../../../scripts/build-migration-seed-skeletons.mjs";
import { readSeedShape, seedSkeleton } from "../../../scripts/lib/seedSkeleton.mjs";
import { TREE_IS_PRIME } from "../testSupport/primeTree";

type Entry = { path: string; blob: string; bytes: number; tuples?: number; skeleton?: string; why?: string };
const committed = JSON.parse(readFileSync("supabase/migration-seed-skeletons.json", "utf8")) as {
  schema_version: number;
  generated_by: string;
  min_bytes: number;
  skeletons: Entry[];
  refused: Entry[];
};

/** The text, handed over `size` characters at a time. */
async function* chunked(text: string, size: number): AsyncGenerator<string> {
  for (let at = 0; at < text.length; at += size) yield text.slice(at, at + size);
}
const shapeOf = (text: string, size = 4096) => readSeedShape(chunked(text, size));

/** A seed in the corpus's own layout, small. */
const SEED = [
  "-- @effect: select 1 from public.template_library_release_baselines where release = 'x'",
  "CREATE TABLE IF NOT EXISTS public.template_library_release_baselines (entry_id uuid, release text);",
  "INSERT INTO public.template_library_release_baselines (entry_id, release)",
  "SELECT id, '20261204020000_seed' FROM public.template_library_entries",
  "ON CONFLICT (entry_id, release) DO NOTHING;",
  "INSERT INTO public.template_library_entries (slug, schema)",
  "VALUES",
  "  (",
  "    'alpha',",
  "    $json${\"title\": \"A\"}$json$::jsonb",
  "  ),",
  "  (",
  "    'bravo',",
  "    $json${\"title\": \"B\"}$json$::jsonb",
  "  )",
  "ON CONFLICT (slug) DO UPDATE",
  "  SET schema = EXCLUDED.schema;",
  "",
  "UPDATE public.template_library_entries SET status = 'published' WHERE slug IN ('alpha', 'bravo');",
  "",
].join("\n");

describe("the committed manifest describes the migrations it names", () => {
  // Run on the prime's tree alone: a clone carries this file and cannot hold
  // the seeds it describes. The CI check stands down on `BACKEND_DEPLOYED_BY`,
  // which its step maps. These used to stand down on that marker too, but a
  // vitest step maps nothing, so on every clone they read `undefined` and
  // asserted seed v20, which GitHub refuses to take from the cascade. See
  // `testSupport/primeTree.ts`. Every other assertion in this suite is about
  // the FILE or the reader and stays true wherever it is carried.
  it.runIf(TREE_IS_PRIME)(
    "regenerating produces exactly what is committed",
    // Every file over the threshold is read twice — once for its blob id, once
    // streamed for its shape — and eighteen of them are ~40 MB.
    { timeout: 120_000 },
    async () => {
      expect(await buildSeedSkeletons()).toEqual(committed);
    },
  );

  it.runIf(TREE_IS_PRIME)(
    "names every migration over the threshold, as a skeleton or as a refusal",
    () => {
      // A file over the threshold that is in neither list is one Mission
      // Control cannot see and nothing here says so.
      const over = readdirSync("supabase/migrations")
        .filter((f) => /^\d{14}_.+\.sql$/.test(f))
        .filter((f) => statSync(join("supabase/migrations", f)).size > MIN_SKELETON_BYTES)
        .map((f) => `supabase/migrations/${f}`)
        .sort();
      const named = [...committed.skeletons, ...committed.refused].map((e) => e.path).sort();
      expect(named).toEqual(over);
      expect(over.length).toBeGreaterThan(0);
    },
  );

  it("carries its version and the threshold it was cut at", () => {
    expect(committed.schema_version).toBe(1);
    expect(committed.min_bytes).toBe(MIN_SKELETON_BYTES);
    expect(committed.generated_by).toBe("scripts/build-migration-seed-skeletons.mjs");
  });

  it("carries the statements and none of the rows", () => {
    for (const s of committed.skeletons) {
      const marker = s.skeleton!.split("\n").filter((l) => l === "  (…)");
      expect(marker, s.path).toHaveLength(1);
      expect(s.skeleton, s.path).toMatch(/INSERT INTO\s+/i);
      expect(s.skeleton, s.path).toMatch(/^ON CONFLICT /m);
      // A skeleton is the statements of a file that is almost all rows.
      expect(s.skeleton!.length, s.path).toBeLessThan(s.bytes / 10);
    }
  });
});

describe("gitBlobSha is the id git gives the bytes", () => {
  // `printf 'hello\n' | git hash-object --stdin`, and the empty blob. The id a
  // tree listing reports for a file is this, and it is what an entry is pinned
  // to — a different hash would match nothing and silently publish nothing.
  it("agrees with git on known bytes", () => {
    expect(gitBlobSha(Buffer.from("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(gitBlobSha(Buffer.alloc(0))).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });
});

describe("readSeedShape — everything but the rows", () => {
  it("keeps the header through VALUES, the clause that ends the rows, and what follows", async () => {
    const shape = await shapeOf(SEED);
    expect(shape.header.split("\n").at(-1)).toBe("VALUES");
    // The earlier INSERT and its ON CONFLICT are part of the header: the
    // clause that ends the rows is the first one AFTER `VALUES`.
    expect(shape.header).toContain("ON CONFLICT (entry_id, release) DO NOTHING;");
    expect(shape.onConflict).toBe("ON CONFLICT (slug) DO UPDATE\n  SET schema = EXCLUDED.schema;");
    expect(shape.tail).toBe(
      "UPDATE public.template_library_entries SET status = 'published' WHERE slug IN ('alpha', 'bravo');",
    );
    expect(shape.tupleCount).toBe(2);
  });

  it("joins them around one marker, which is the text Mission Control derives", async () => {
    const shape = await shapeOf(SEED);
    expect(seedSkeleton(shape)).toBe(
      [shape.header, "  (…)", shape.onConflict, shape.tail].join("\n"),
    );
    // The rows are gone — their payload and the lines that open them.
    expect(seedSkeleton(shape)).not.toContain('$json${"title": "A"}$json$');
    expect(seedSkeleton(shape).split("\n")).not.toContain("  (");
    expect(seedSkeleton({ ...shape, tail: "" })).toBe(
      [shape.header, "  (…)", shape.onConflict].join("\n"),
    );
  });

  it("reads the same shape however the text is chunked", async () => {
    const whole = await shapeOf(SEED, SEED.length);
    for (const size of [1, 2, 7, 64]) {
      expect(await shapeOf(SEED, size)).toEqual(whole);
    }
  });

  it.each([
    ["no VALUES line", "INSERT INTO public.t (a)\nSELECT 1;\n", /no VALUES line/],
    ["VALUES with no INSERT before it", "SELECT 1\nVALUES\n  (\n    1\n  )\nON CONFLICT DO NOTHING;\n", /no INSERT INTO/],
    ["text before the first tuple", "INSERT INTO public.t (a)\nVALUES\n(1)\nON CONFLICT DO NOTHING;\n", /text before the first tuple/],
    ["no clause after the rows", "INSERT INTO public.t (a)\nVALUES\n  (\n    1\n  );\n", /no ON CONFLICT clause/],
    ["an unterminated clause", "INSERT INTO public.t (a)\nVALUES\n  (\n    1\n  )\nON CONFLICT (a) DO UPDATE\n  SET a = 1\n", /unterminated ON CONFLICT/],
    ["no tuples", "INSERT INTO public.t (a)\nVALUES\nON CONFLICT DO NOTHING;\n", /no tuples found/],
    ["a tuple that does not end with ')'", "INSERT INTO public.t (a)\nVALUES\n  (\n    1\nON CONFLICT DO NOTHING;\n", /does not end with '\)'/],
  ])("refuses %s", async (_label, text, why) => {
    await expect(shapeOf(text)).rejects.toThrow(why);
  });

  it("refuses a boundary that fell inside a dollar-quoted string", async () => {
    // A line that is exactly `  (` inside a JSON schema would be read as a new
    // tuple; the dollar-quote tags stop balancing within each half, and that
    // is the only thing that says the split was wrong.
    const text = [
      "INSERT INTO public.t (a)",
      "VALUES",
      "  (",
      "    $json${\"note\": \"",
      "  (",
      "    \"}$json$",
      "  )",
      "ON CONFLICT DO NOTHING;",
      "",
    ].join("\n");
    await expect(shapeOf(text)).rejects.toThrow(/splits inside a \$json\$ string/);
  });
});
