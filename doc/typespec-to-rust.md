# TypeSpec to Rust

Chosen: progenitor 0.16 (OpenAPI 3.0 to types and a reqwest client), run as a library from `crates/xtask` by `npm run generate`, output committed in `crates/tumpel-api/src/generated.rs`.

Rejected:

- typify: fails on the json-schema bundle, which references `$defs` by `$id` (`"$ref": "HostState.json"`) and typify treats those as external references.
- openapi-generator (rust): needs a JVM, emits 32 clippy pedantic errors against progenitor's 5, adds `Default` impls to every enum and a `serde_json::Value` fallback for unknown errors.

Nasty cases:

- `offsetDateTime` and `utcDateTime` both become `format: date-time` in OpenAPI, and progenitor maps that to `DateTime<Utc>`, dropping the offset. Worked around with a conversion to `DateTime<FixedOffset>` in `crates/xtask`.
- The generated client fails clippy pedantic (missing `# Errors`, `#[must_use]`, doc backticks, trailing comma). Worked around with `#[allow(clippy::pedantic)]` on the generated module.
- Struct fields are emitted in alphabetical order, not TypeSpec order.
- `@key` has no OpenAPI form, so the generated types do not mark key fields.
- An error response typed `application/problem+json` becomes `Error<ByteStream>`: progenitor types only `application/json` bodies. The `Problem` response is sent as `application/json` so every operation returns `Error<types::Problem>`.
- A `@discriminated` union with `envelope: "none"` becomes `#[serde(untagged)]`, ignoring the OpenAPI `discriminator` mapping. Each variant keeps its `type` field as a one-value enum, so decoding is correct, but a bad frame reports "did not match any variant" instead of naming the field.
- Models in a sub-namespace are prefixed with it: `Tumpel.Channel.Hello` becomes `types::ChannelHello`.
