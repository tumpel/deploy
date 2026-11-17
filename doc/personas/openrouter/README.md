# The OpenRouter personas

Two OpenCode personas that run on one secret set, `openrouter`, whose only member is the `OPENROUTER_API_KEY` that Connect OpenRouter mints. Nobody copies a key by hand. The catalog maps OpenCode to provider `OpenRouter` and that variable, so a session on either persona needs nothing else from the set.

| Persona           | Model (`opencode.json`)                             |
| ----------------- | --------------------------------------------------- |
| `openrouter-free` | `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` |
| `openrouter-glm`  | `openrouter/z-ai/glm-5.3`                           |

The model lives in the persona's `.config/opencode/opencode.json`, as `openrouter/<OpenRouter model id>`; [`https://openrouter.ai/api/v1/models`](https://openrouter.ai/api/v1/models) lists the ids. To compare models, copy a file, change its `model` line and update the persona with it. `AGENTS.md` holds the ticket rules of [`ticket-worker`](../ticket-worker/CLAUDE.md).

Set them up from a signed-in terminal at the repository root:

```sh
tumpel secret-set create --name openrouter
tumpel persona create --name openrouter-free --harness OpenCode --secret-set-id <secretSetId> \
  --persona-file .config/opencode/opencode.json=doc/personas/openrouter/free.opencode.json \
  --persona-file .config/opencode/AGENTS.md=doc/personas/ticket-worker/CLAUDE.md
tumpel persona create --name openrouter-glm --harness OpenCode --secret-set-id <secretSetId> \
  --persona-file .config/opencode/opencode.json=doc/personas/openrouter/glm.opencode.json \
  --persona-file .config/opencode/AGENTS.md=doc/personas/ticket-worker/CLAUDE.md
```

Then open the `openrouter` secret set in the dashboard and choose Connect OpenRouter, or run `tumpel openrouter authorize --secret-set-id <secretSetId>` and open the URL it prints. Approve on OpenRouter within 10 minutes; the browser comes back to the secret set, which then lists `OPENROUTER_API_KEY`. Delete the key on [OpenRouter](https://openrouter.ai/settings/keys) to revoke it.

OpenCode takes its model from the persona's `opencode.json` and ignores the `--model` a session start requires, so pass the same id, such as `--model openrouter/z-ai/glm-5.3`, to keep the session record true. A session needs a guest image of OpenCode in the current release.
