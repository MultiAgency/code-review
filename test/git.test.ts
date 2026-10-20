import assert from "node:assert/strict";
import { test } from "node:test";
import { commentableLines } from "../src/git.ts";

test("commentableLines tracks added and context lines on the new side", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,4 +10,5 @@ function f() {",
    " context10",
    "-removed",
    "--- removed line that looks like a header",
    "+added11",
    "+added12",
    " context13",
    "@@ -40,2 +41,2 @@",
    " context41",
    "+added42",
    "diff --git a/old.txt b/old.txt",
    "deleted file mode 100644",
    "--- a/old.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-gone",
    "",
  ].join("\n");
  const lines = commentableLines(diff);
  assert.deepEqual([...lines.keys()], ["src/a.ts"]);
  assert.deepEqual([...lines.get("src/a.ts")!], [10, 11, 12, 13, 41, 42]);
});
