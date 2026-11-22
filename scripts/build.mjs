#!/usr/bin/env node
// Compiles src/ to dist/ and makes the `ampost` bin executable.
import { execFileSync } from "node:child_process";
import { chmodSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");

rmSync(join(root, "dist"), { recursive: true, force: true });
execFileSync(process.execPath, [tsc, "-p", join(root, "tsconfig.build.json")], { stdio: "inherit" });
chmodSync(join(root, "dist", "bin.js"), 0o755);
console.log("Built dist/");
