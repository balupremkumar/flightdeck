import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { APP_VERSION } from "./version";

it("APP_VERSION matches the repo root package.json version", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  expect(APP_VERSION).toBe(manifest.version);
});
