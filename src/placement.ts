// Where a finding can be shown on the PR.

/**
 * lines: on new-side lines GitHub accepts inline comments on; `exact` when
 * they are precisely `existing_code`, so `fix_code` can replace them.
 * file: on a changed file, but not on a commentable line. summary: nowhere in the diff.
 */
export type Placement =
  | { kind: "lines"; start: number; end: number; exact: boolean }
  | { kind: "file" }
  | { kind: "summary" };

/**
 * Finds the finding's quoted code in the file and anchors there, preferring the
 * occurrence nearest the reported line; falls back to the reported line, then
 * the file, then the summary.
 */
export function place(
  f: { line: number; existing_code: string },
  text: string | undefined,
  commentable: Set<number> | undefined,
  changed: boolean,
): Placement {
  const ok = (start: number, end: number) => {
    if (!commentable) return false;
    for (let n = start; n <= end; n++) if (!commentable.has(n)) return false;
    return true;
  };
  const snippet = trimBlankEdges(f.existing_code.split("\n")).map((l) => l.trim());
  if (text !== undefined && snippet.length > 0) {
    const lines = text.split("\n").map((l) => l.trim());
    let best: { start: number; end: number } | undefined;
    for (let i = 0; i + snippet.length <= lines.length; i++) {
      if (!snippet.every((s, k) => lines[i + k] === s)) continue;
      const start = i + 1;
      const end = i + snippet.length;
      if (!ok(start, end)) continue;
      if (!best || Math.abs(start - f.line) < Math.abs(best.start - f.line)) best = { start, end };
    }
    if (best) return { kind: "lines", ...best, exact: true };
  }
  if (ok(f.line, f.line)) return { kind: "lines", start: f.line, end: f.line, exact: false };
  return changed ? { kind: "file" } : { kind: "summary" };
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start++;
  while (end > start && lines[end - 1]!.trim() === "") end--;
  return lines.slice(start, end);
}
