import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const srcDir = join(import.meta.dirname, "..", "src");

test("agents only ever launch through Sandcastle's docker provider", () => {
  for (const file of readdirSync(srcDir).filter((name) => name.endsWith(".ts"))) {
    const source = readFileSync(join(srcDir, file), "utf8");
    assert.doesNotMatch(source, /no-sandbox|noSandbox/, `${file} must not use Sandcastle's no-sandbox provider`);
  }
});
