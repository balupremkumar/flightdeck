import { writeFileSync } from "node:fs";
import path from "node:path";
import { OUT, stableSnapshot } from "./w1a-lib.mjs";
const which = process.argv[2] ?? "before";
const s = { when: new Date().toISOString(), ...stableSnapshot() };
writeFileSync(path.join(OUT, `w1a-safety-${which}.json`), JSON.stringify(s, null, 2));
console.log(JSON.stringify(s));
