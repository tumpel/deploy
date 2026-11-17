# 004. TypeSpec to Rust via secondary tooling

Status: accepted

TypeSpec emits an intermediate format that Rust tooling supports well, such as OpenAPI or JSON Schema, and an established Rust generator produces types and clients from it. TypeSpec stays the single source of truth. A custom emitter is written only for a case the generators cannot handle, and each such case is noted first.
