# 003. The host channel dials out and is defined before any backend

Status: accepted

The supervisor dials out from the host, with no inbound ports, and keeps a persistent connection to the control plane, with a Durable Object per host as the first implementation. The channel is defined first as a provider-agnostic interface modelled in TypeSpec/schema: the protocol, message types, auth, reconnect and ordering semantics. Cloudflare then plugs in as one backend. The backend stays swappable, for example for AWS Lambda with API Gateway WebSockets. Every other platform-specific piece follows the same two stages.
