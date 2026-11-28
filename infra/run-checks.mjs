// One command for every check in the repo: npm run check
//
// Runs each "test:*" script in package.json, shop rules first, and prints one line each.
// Pass --skip=name,name to leave some out (CI runs the browser test on its own step).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts;
const skip = new Set((process.argv.find((a) => a.startsWith("--skip=")) || "--skip=").slice(7).split(",").filter(Boolean));
const names = Object.keys(scripts)
  .filter((k) => k.startsWith("test:") && !skip.has(k.slice(5)) && !skip.has(k))
  .sort((a, b) => (a === "test:rules" ? -1 : b === "test:rules" ? 1 : 0));

let failed = 0;
for (const name of names) {
  const started = Date.now();
  const run = spawnSync("npm", ["run", "-s", name], { cwd: ROOT, encoding: "utf8" });
  const ok = run.status === 0;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`${ok ? "pass" : "FAIL"}  ${name.padEnd(24)} ${secs}s`);
  if (!ok) {
    failed++;
    console.log(`${run.stdout}${run.stderr}`.trim().split("\n").slice(-25).map((l) => `      ${l}`).join("\n"));
  }
}
console.log(failed ? `\n${failed} of ${names.length} checks failed` : `\nall ${names.length} checks passed`);
process.exit(failed ? 1 : 0);
