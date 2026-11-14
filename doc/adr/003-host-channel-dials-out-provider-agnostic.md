# 003. The host channel dials out and is defined before any backend

Status: accepted, 2026-11-14

"The supervisor dials out from the host, with no inbound ports, and keeps a persistent connection to the control plane (roughly the cloudflared/Tailscale model, with a Durable Object per host as the first implementation). Don't build it straight on Cloudflare. Always work in two stages: first define how it works in general, meaning the protocol, message types, auth, reconnect and ordering semantics, as a provider-agnostic interface modelled in TypeSpec/schema. Then plug in Cloudflare as one backend. Keep the backend swappable, for example AWS Lambda with API Gateway WebSockets later. Apply the same two-stage principle to other platform-specific pieces too."

— Matthijs van Henten
