import * as fs from "fs";
import * as path from "path";
import { DiffContext } from "../github/prFetcher";
import { FindingCard } from "../review/finding";

/**
 * Catches an inexpensive, deterministic Java compilation failure that an LLM
 * should not be relied on to find: a PR removes an import but still uses the
 * imported simple name in the updated source file.
 */
export function findRemovedJavaImportUses(
  diff: Pick<DiffContext, "changedFiles">,
  repoRoot: string
): FindingCard[] {
  const findings: FindingCard[] = [];
  const resolvedRoot = path.resolve(repoRoot) + path.sep;

  for (const changed of diff.changedFiles) {
    if (!changed.filename.endsWith(".java") || !changed.patch) continue;

    const filePath = path.resolve(repoRoot, changed.filename);
    if (!filePath.startsWith(resolvedRoot) || !fs.existsSync(filePath)) continue;

    const source = fs.readFileSync(filePath, "utf-8");
    const sourceWithoutImports = source.replace(/^\s*import\s+[^;]+;\s*$/gm, "");
    const removedImports = Array.from(
      changed.patch.matchAll(/^[-]\s*import\s+([\w.]+)\.([A-Za-z_$][\w$]*)\s*;/gm)
    );

    for (const match of removedImports) {
      const [, qualifiedName, simpleName] = match;
      const use = new RegExp(`\\b${escapeRegExp(simpleName)}\\b`).exec(sourceWithoutImports);
      if (!use) continue;

      const line = source.slice(0, use.index).split("\n").length;
      findings.push({
        id: `P1-STATIC-${findings.length + 1}`,
        severity: "P1",
        title: `Removed import ${simpleName} is still referenced`,
        file: `${changed.filename} · line ${line}`,
        filePath: changed.filename,
        line,
        rootCause: `The PR removes import ${qualifiedName}.${simpleName}, but ${simpleName} is still referenced in this Java source file.`,
        impact: "The Java project will not compile because the referenced type or annotation cannot be resolved.",
        fix: `Restore the ${simpleName} import or remove/replace every remaining ${simpleName} reference.`,
      });
    }
  }

  return findings;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
