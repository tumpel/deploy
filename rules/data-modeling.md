# Data modeling

Storage is SQLite: one central D1 database (`packages/control-plane/migrations`) and one Durable Object database per tenant, host and metrics store (`migrations/tenant`, `migrations/host`, `migrations/metrics`).

1. Each tenant has its own database. The central database holds only what sign-in and routing need to find the tenant.
2. A schema change is a new numbered migration file. Never edit a migration that has shipped.
3. Every new field is mandatory: `NOT NULL` in SQL and no `?` in TypeSpec. No sentinel values and no nullable foreign keys. When a field needs a null, make it mandatory, drop it, or give the uncommon state its own table.
4. Give each record type its own table. Never one table with a `kind` column.
5. The schema enforces integrity: `PRIMARY KEY`, `UNIQUE`, `CHECK` and `REFERENCES`. Never write an app-side check the schema can hold.
6. A reference holds a stable id. The human-readable name lives in its own column.
7. Two records with their own queries link through a junction table that holds only ids.
8. An external reference gets a deterministic id (UUID v5 from the system and the external value).
9. Guard a concurrent write with a conditional update on `updated_at`.
10. Filter in the query. A handler never fetches more rows than it uses.
11. A column is the snake_case form of its TypeSpec name: `tenantId` is `tenant_id`.
