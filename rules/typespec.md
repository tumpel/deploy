# TypeSpec

1. TypeSpec in [tumpel/protocol](https://github.com/tumpel/protocol) is the single source of truth for the API, the host channel and every config file.
2. Tumpel installs the generated `@tumpel/schemas`, `@tumpel/openapi` and `@tumpel/api` from a protocol release by tarball URL. Never hand-write or hand-edit generated output. A change lands in tumpel/protocol first, then a tumpel PR bumps the three URLs.
3. Name keys `<entity>Id` and `<entity>Version`, never bare `id` or `version`. A foreign key takes the name of the key it references.
4. A business date is an ISO 8601 string with an explicit offset. An epoch integer is only for a UTC metadata timestamp (`createdAt`, `updatedAt`).
5. Enums are PascalCase with string-valued members.
6. Give each variant its own model. Never one model with a `kind` field or an optional key.
7. Derive inputs from the model: `model XCreate is Create<X>;`.
8. `alias` is a reserved keyword. Never use it as a field name (use `ref`, `label` or `key`).
9. tumpel/protocol enforces rules 3 to 5 in its own checks.
