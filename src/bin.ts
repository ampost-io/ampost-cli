#!/usr/bin/env node
import { run } from "./cli.js";
import { nodeIo } from "./io.js";

const code = await run(process.argv.slice(2), {
  env: process.env,
  io: nodeIo(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});
process.exitCode = code;
