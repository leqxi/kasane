// The built library's size, the way the README states it: minified, then gzipped and brotli'd at
// the highest level. `npm run size` prints it. Nothing here is part of the library.

import { execFileSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

/** Bytes of dist/index.js minified, gzipped and brotli'd. Needs a build. */
export function sizes() {
  const minified = execFileSync("npx", [
    "--yes",
    "esbuild",
    "dist/index.js",
    "--minify",
    "--format=esm",
    "--log-level=silent",
  ]);

  return {
    minified: minified.length,
    gzipped: gzipSync(minified, { level: 9 }).length,
    brotli: brotliCompressSync(minified, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length,
  };
}

/** Bytes as the docs state them: one decimal, thousands. */
export const kb = (bytes) => `${(bytes / 1000).toFixed(1)} kB`;

/**
 * The number the README states, in bytes gzipped — set to the last byte at which that number is
 * still the one this prints, so `--budget` fails exactly when the README stops being true. Raising
 * it is the right move for a change worth the bytes, in the same commit as the sentence it rewrites.
 */
export const BUDGET = 2050;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const size = sizes();

  console.log(
    `${kb(size.gzipped)} gzipped, ${kb(size.minified)} minified, ${kb(size.brotli)} brotli` +
      ` (${size.gzipped}, ${size.minified}, ${size.brotli} bytes)`,
  );

  if (process.argv.includes("--budget") && size.gzipped > BUDGET) {
    console.error(
      `\nOver budget: ${size.gzipped} bytes gzipped, ${BUDGET} allowed (+${size.gzipped - BUDGET}).` +
        `\nShrink it, or raise BUDGET in scripts/size.mjs and update the size the README states.`,
    );
    process.exit(1);
  }
}
