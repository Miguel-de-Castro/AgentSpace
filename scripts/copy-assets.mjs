// .claude/plans/18-mock-provider-safety-and-prod-start.md P1 item 6 — `tsc`
// only emits the compiled .js; it does not copy non-TS assets. src/db/schema.sql
// is read at runtime by db/client.ts relative to its own compiled location
// (dist/db/), so without this copy `node dist/server.js` (i.e. `npm start`)
// crashes with ENOENT — a gap that was being worked around by hand every build.
// Kept as a tiny cross-platform Node script rather than a shell `cp` so it runs
// identically on Windows and POSIX.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const assets = [["src/db/schema.sql", "dist/db/schema.sql"]];

for (const [from, to] of assets) {
  const dest = join(root, to);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(root, from), dest);
  console.log(`copied ${from} -> ${to}`);
}
