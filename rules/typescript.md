# TypeScript

1. Never use `any`. Use `unknown` and narrow it with a type guard (`value is T`). Prefer a type guard over an `as` cast.
2. Give explicit types to parameters, return values and exported state. Let inference handle local bodies.
3. Import types, schemas, enums and clients from the generated packages (`@tumpel/schemas`, `@tumpel/api`, `@tumpel/openapi`). Never redefine one by hand. When one is missing, add it to the TypeSpec in tumpel/protocol and bump the release (`rules/typespec.md`).
4. Parse external input with the generated zod schema and `safeParse` at the boundary. Derive the type with `z.infer`. Read a request body with `parseBody` from `packages/control-plane/src/http.ts`.
5. Return a discriminated union for an expected outcome, as `Parsed<T>` in `http.ts` does: `{ ok: true; value } | { ok: false; ... }`.
6. Return an HTTP error as a problem response through `problem()` in `http.ts`, with a `detail` and a `fix`.
7. Handle a rejection with `.catch()` on that promise. Never wrap an `await` in `try`/`catch` to rethrow: the `try` block also catches unrelated throws.
8. Return early. Never write `else` after a `return`.
9. `npm run lint` (Biome) and `npm run typecheck` pass. `npm run fix` formats.
