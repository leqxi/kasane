// The release notes for one version, taken from CHANGELOG.md so the changelog stays the only place
// a release is described. `node scripts/notes.mjs 0.2.0` prints them; the release workflow runs it
// before publishing, so a version with no entry fails the release rather than shipping silently.

import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

/** The body under `## [version]`, up to the next heading at that level. */
export function notes(version, changelog = readFileSync("CHANGELOG.md", "utf8")) {
  const lines = changelog.split("\n");
  const heading = lines.findIndex((line) => line.trim().startsWith(`## [${version}]`));
  if (heading === -1) throw new Error(`CHANGELOG.md has no entry for ${version}`);

  const rest = lines.slice(heading + 1);
  const next = rest.findIndex((line) => line.startsWith("## "));
  const section = next === -1 ? rest : rest.slice(0, next);

  // The last version's section runs to the end of the file, which is where the link definitions
  // live. They resolve the `[0.1.0]` in the headings and mean nothing on a release page.
  const body = section
    .filter((line) => !/^\[[^\]]+]:\s*\S+$/.test(line.trim()))
    .join("\n")
    .trim();

  if (!body) throw new Error(`the CHANGELOG entry for ${version} is empty`);
  return body;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: node scripts/notes.mjs <version>");
    process.exit(1);
  }

  try {
    console.log(notes(version));
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
  }
}
