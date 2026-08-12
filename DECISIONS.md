# DECISIONS

Each entry records a single architectural decision: the question, what the options
were, what we picked, and the reasoning a reviewer can check. Newest first.

---

## 2026-08-12 — Approval route: out-of-band localhost UI; spec-native elicitation deferred to client support

**Ticket:** #1 (spike: how the current MCP spec handles human-in-the-loop approval).

**Question:** When a write is above the approval threshold, how does a human sign off?

### What the current spec supports

Version checked: **2026-07-28** (published 2026-07-28, the current revision). Date checked: 2026-08-12.

- A first-class server-to-user confirmation channel has existed since **2025-06-18**:
  `elicitation`, form mode — the server sends `elicitation/create` mid-`tools/call` with a
  restricted JSON Schema, the client renders it, and the user answers with
  `accept` / `decline` / `cancel`. (Added via PR #382.)
- **2025-11-25** extended it: URL mode for out-of-band interactions that must not pass
  through the client (OAuth consent, payments), plus richer enums and schema defaults.
- **2026-07-28** replaced the stream-based server→client requests with **Multi Round-Trip
  Requests (MRTR, SEP-2322)**: a `tools/call` handler returns
  `resultType: "input_required"` with an `inputRequests` map and an optional opaque
  `requestState`; the client gathers the answers and retries the original call with
  `inputResponses` and the echoed `requestState`. No held-open stream. The Tier-1 SDKs
  (TypeScript, Python, Go, C#) ship 2026-07-28 support. A related requirement (SEP-2260)
  makes a server prompt only while it is actively processing a client request — no
  unsolicited prompts.

So the spec-native route exists, is sanctioned, and is designed for exactly this use case
(server / clients SHOULD present confirmation prompts for sensitive operations).

### The concrete client support situation — why we are not building on it yet

Per the spike's own rule — *"a pattern no shipping client implements is not usable yet"* —
for our target client, elicitation is that pattern today:

- **Claude Code CLI:** elicitation shipped since v2.1.76, per the MCP client capability
  matrix (spec PR #2398, merged 2026-03-14).
- **Claude Desktop app (our target):** elicitation is **not** listed in the capability
  matrix (only Roots). A server's `elicitation/create` is not surfaced; Desktop returns
  an immediate `cancel` (anthropics/claude-code#56243), which an approval flow cannot
  distinguish from a user rejecting.
- **Claude.ai:** not shipped; the feature request remains open
  (anthropics/claude-ai-mcp#153).

Anthropic's 2026-07-28 rollout announcement also frames client support as rolling out,
not shipped.

### Decision

The approval flow takes the **out-of-band localhost page** route (Ticket #7) as its
primary mechanism. This is a deliberate, documented fallback — the route the build plan
anticipated — not a gap. Two reasons, in order:

1. **Client reality:** the target client (Claude Desktop) implements no spec-native
   approval channel today, so a spec-native-only design would be inert in the demo.
2. **Demo legibility:** the plan's proof beat is *reject the plan, watch the agent
   adapt*. Rendering that in our own localhost page showcases the refusal; a client
   chrome might swallow it.

### Designed so the spec-native route can be layered on later

The two-phase write core (preview → plan token → `execute_plan`) already mirrors the
spec's shape. When a client declares the `elicitation` capability — or negotiates
2026-07-28 MRTR — the server can express "awaiting approval" as an in-band elicitation
or an `input_required` result whose `requestState` is bound to the same plan token
(after the same preview/rollback). Approval becomes spec-native with no change to the
token, threshold, or audit logic. The localhost page and a future native surface are two
front-ends over one approval store.

### Sources (primary)

- 2026-07-28 spec, MRTR: https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr
- 2026-07-28 spec, elicitation (form + URL): https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation
- 2025-11-25 spec, elicitation: https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
- 2025-06-18 spec, elicitation (introduced): https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation
- 2025-06-18 changelog (elicitation added, PR #382): https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-06-18/changelog.mdx
- 2025-11-25 changelog (URL mode SEP-1036/PR #887, defaults SEP-1034, enums SEP-1330): https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/changelog.mdx
- Client capability matrix (Claude Code: elicitation; Desktop: roots only; Claude.ai: apps): https://github.com/modelcontextprotocol/specification/pull/2398
- 2026-07-28 release notes: https://blog.modelcontextprotocol.io/posts/2026-07-28/
- Claude Desktop surfaces elicitation as cancel, no Desktop support: https://github.com/anthropics/claude-code/issues/56243 and https://github.com/anthropics/claude-code/issues/41110
- Claude.ai elicitation not shipped: https://github.com/anthropics/claude-ai-mcp/issues/153