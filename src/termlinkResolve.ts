// termlinkResolve.ts: terminal links resolve candidates through the batched,
// UNC-safe Rust check in pathcheck.ts (Phase 1 L2).
export { resolveExisting as resolveCandidates, type PathHit } from "./pathcheck";
