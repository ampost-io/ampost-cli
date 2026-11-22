#!/usr/bin/env node
// Stops `npm publish` while the SDK dependency still points at the folder next door (public-repos/ampost-node).
// After the move to github.com/ampost-io/ampost-cli, depend on the published SDK: "ampost": "^0.1.0".
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const sdk = pkg.dependencies?.ampost ?? "";
if (!/^[\^~]?\d/.test(sdk)) {
  console.error(`package.json depends on "ampost": "${sdk}". Publish only with a released SDK version, such as "^0.1.0".`);
  process.exit(1);
}
