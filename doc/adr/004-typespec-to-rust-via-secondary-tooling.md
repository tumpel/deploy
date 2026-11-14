# 004. TypeSpec to Rust via secondary tooling

Status: accepted, 2026-11-14

"Use secondary tooling. TypeSpec emits an intermediate format that Rust tooling supports well, such as OpenAPI or JSON Schema, and established Rust generators produce types and clients from that (for example progenitor or typify, or openapi-generator; pick based on quality). TypeSpec stays the single source of truth. Only for the really nasty cases do we consider writing our own emitter. Note those cases, but don't start there."

— Matthijs van Henten
