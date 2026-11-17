# 006. CircleCI connects through OAuth with PKCE and a loopback redirect

Status: accepted

CircleCI connects through its OAuth 2.0 authorization code flow with PKCE S256 and dynamic client registration; a pasted personal API token stays as the fallback. CircleCI registers only loopback redirects: it refuses a redirect such as `https://dev.tumpel.dev/circleci/callback` with 400 `invalid_redirect_uri`, "expected an RFC 8252 loopback URI (http://127.0.0.1[:port], http://[::1][:port] or http://localhost[:port]) or a supported hosted redirect".

So the redirect is `http://127.0.0.1:47151/circleci/callback`. `tumpel circleci authorize` listens there; the dashboard asks the person to paste the address the browser lands on, as Set up Claude Code does with its code. The control plane holds the verifier and the state per authorization, each phase lasts 10 minutes, and the token is sealed where the pasted token was.

Each tenant registers its own client on its first authorization. CircleCI revokes the earlier token of a client and user pair when the pair authorizes again, so a client per stage would let one tenant's connection revoke another's for the same CircleCI user.

The token lasts 90 days with no refresh token. The connection reads Expiring from 14 days before the expiry, two weekly cycles to act, since authorizing again early costs nothing, and Expired from the expiry. CircleCI revokes the earlier token at the exchange, so a renewal binds the new token to the connected organization straight away.

The organization comes from `GET /api/v2/me/collaborations`. The CircleCI API v2 OpenAPI document (openapi 3.0.3, info.version v2) has no operation that lists an organization's projects, only `GET /project/{project-slug}`, so the dashboard lists the tenant's bindings instead.
