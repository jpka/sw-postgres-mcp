# DECISIONS

Each entry records a single architectural decision: the question, what the options
were, what we picked, and the reasoning a reviewer can check. Newest first.

---

## 2026-08-14 — execute_plan blocks while a plan awaits approval: the rejection (or approval) surfaces on the in-flight call

The reported bug: a human clicking "Reject" in the localhost approval UI killed the token server-side (store tombstone, `rejected` audit row, `PLAN_REJECTED` on the next consume), but nothing surfaced to the agent in Claude Desktop. After a preview returned `status: "awaiting_approval"`, the tool message told the agent to "wait for approval", so the agent's turn ended and it idled; there is no push channel over MCP stdio, so the agent only learned of a rejection if it happened to re-call `execute_plan` on its own — which the "wait" guidance gave it no reason to do.

The fix changes `TwoPhaseWrite.execute()`'s semantics from refuse-now to wait-until-decided. `execute()` consumes first; on an `AWAITING_APPROVAL` refusal it waits — polling the core's public `listPending()` on a 100 ms interval, bounded by the plan TTL plus a small grace period so an unchosen plan can never hold the call open forever — then re-consumes. The core's `consume()` deliberately does not mark a token used on an `AWAITING_APPROVAL` refusal, so the re-consume is safe: an approval lets the statement execute, a rejection returns `PLAN_REJECTED` with the human's reason, and an expiry returns `EXPIRED_TOKEN`.

The preview and migration messages now instruct the agent to call `execute_plan` to await the human's decision — the out-of-band approve/reject lands on that held-open call instead of being invisible until a lucky retry. That is what makes the demo beat "reject the plan, watch the agent adapt" work without any client-side push channel: since Claude Desktop implements no spec-native elicitation (see the 2026-08-12 entry), a held-open tool call is the one in-band mechanism that can surface an out-of-band decision.

Trade-offs: a waiting call is bounded by the remaining TTL, so it cannot hang forever; the single-use/expiry/fingerprint guarantees are unchanged, since `consume()` is what actually transitions the token; a waiting-then-approved call no longer writes the spurious pre-approval `failed` audit row (there is no refused attempt to audit), and a waiting-then-rejected call writes exactly one `failed` row for the refusal.

---

## 2026-08-13 — Consuming safe-write-mcp-core (#26): the token lifecycle and the approval HTTP server now live in the shared package

**Ticket:** #26 — prove the extracted core generalizes by having this server consume
it. `src/writeCore.ts`'s `TokenStore` and the localhost approval HTTP server were the
core's two sources; both are now imported from `safe-write-mcp-core@0.1.0` instead of
duplicated here, and the deleted code stays deleted.

### What moved to the core, and what stays here

The core owns the plan lifecycle once a plan exists: single-use tokens, expiry,
payload-fingerprint binding (`consume()` refuses a changed statement/params), the
approval gate, rejection tombstones, and the deliberate `consume()` check ordering
(rejected → used → expired → mismatch → awaiting approval). Its `createApprovalServer`/
`startApprovalServer` own the whole HTTP surface this repo's #7 server had — the
loopback-only bind, the Host/Origin/Sec-Fetch-Site provenance gates, the
`Content-Type: application/json` gate, the 64 KiB body cap, and the plan-card page.

What stays here is everything Postgres-shaped: the preview/execute seam (the
`RETURNING`-wrapped count/sample/digest SQL, the DDL branch, statement timeouts), the
`ROWSET_CHANGED` digest re-check at execute time, the `approvalRequiredAboveRows`/
`hardMaxRows` policy, the `mcp_audit.log` persistence, and the agent-facing error
vocabulary. `TwoPhaseWrite` is now the host adapter the core's README describes: it
calls `store.create()` after its rolled-back preview and `store.consume()` before its
committed execute, and re-verifies its own invariant (the row-set digest) in between.

### Error codes: translated at the MCP boundary, native on the HTTP surface

The core speaks generalized lifecycle codes (`PLAN_EXPIRED`, `PLAN_USED`,
`PLAN_MISMATCH`); this server's agent-facing tools historically speak
`EXPIRED_TOKEN`/`USED_TOKEN`/`STATEMENT_MISMATCH`. The MCP tool surface keeps its
historical vocabulary — it is the documented, tested contract agents see — via a
code-for-code translation of `PlanError` at the `TwoPhaseWrite` boundary. The approval
HTTP surface, now owned by the core, reports the core's native codes: an expired plan
refused by `POST /api/plans/:token/approve` is `410` with `code: "PLAN_EXPIRED"`
(previously `EXPIRED_TOKEN`). The status codes and the behavior are unchanged; only the
string on the human-facing surface moved to the shared vocabulary. Tests follow.

### The core's AuditSink is deliberately `NoopSink` here

The core emits lifecycle events (`previewed`/`approved`/`executed`/…) to an injectable
synchronous, never-throwing `AuditSink`. This server's audit rows are richer than that
event shape — statement, redacted params, preview/actual row counts, `approved_by` —
and are written by `TwoPhaseWrite` itself at exactly the points the pre-core code wrote
them. Wiring the core's sink to `mcp_audit.log` as well would double every row and
corrupt the per-plan status sequences operators (and the test suite) query. One writer
per row, host-side; the core's sink stays `NoopSink`.

### Bridging audit attribution across the `onDecision` seam

The core's approval server reports every human decision through an `onDecision` hook
carrying the action, actor, and outcome — but not the plan's metadata, which this
repo's `approved`/`rejected`/failed-decision audit rows need for full attribution
(tool, reason, caller, preview row count). The bridge is `PostgresPlanStore`, a thin
`PlanStore` subclass that captures each `approve()`/`reject()` result (metadata
included) in a single slot `TwoPhaseWrite.recordApprovalDecision` reads when the hook
fires. A single slot is safe because the core's handler runs the store transition and
the hook in one uninterrupted synchronous segment, so two decisions cannot interleave
between a capture and its read. The upshot: a human decision writes exactly the same
audit row whether it arrives through the HTTP surface or through
`approvePlan()`/`rejectPlan()` called directly.

### Surface changes the extraction brought (and tests that follow them)

- `GET /api/plans` JSON: the core's generalized shape — `plan_token`, `tool`, `reason`,
  `preview_count`, `expires_at`, `caller_id`, `payload` (the host's
  `{ statement, params }`), and `render` (the host-rendered card) — replaces the old
  flattened `statement`/`params`/`affected_rows`/`sample_rows`/`target`. The sample
  rows and DDL target are still shown to the human — the host's `renderPlan` hook
  renders them as card details, on the page and in the JSON's `render` field.
- The plan-card badge reads `N affected` (core) instead of `N row(s)` (old local page).
- `TwoPhaseWrite.listPendingPlans()` and the local `PendingPlan` shape are deleted;
  the approval server reads `store.listPending()` directly.
- `statementFingerprint(statement, params)` remains exported (tests and tooling use
  it) and keeps its whitespace-trim tolerance, now delegating to the core's
  canonical-JSON `fingerprint()` over the identical `{ statement, params }` payload the
  plan token is bound to.

---

## 2026-08-13 — run_migration (#9): forcing approval without a threshold, DDL through a core built for RETURNING, and what "allowlist" means for a table that doesn't exist yet

**Ticket:** #9 — `run_migration`, a DDL tool that reuses `TwoPhaseWrite` (built for #4,
extended by #5/#6/#7/#8) but must **always** require human approval, never gated by the
`approvalRequiredAboveRows`/`hardMaxRows` thresholds #6 built for the data write tools.
Given this session's two prior review-caught security holes (agent self-approval on #6,
CSRF on #7's HTTP server), the overriding design constraint here was: no code path,
misconfiguration, or edge case can let a migration execute without going through the
approval server's approve endpoint.

### Forcing approval: a `WriteMeta` flag hardcoded by the tool module, not an agent-supplied parameter

The ticket's own suggestion was followed as the safest option among three considered:
(a) give `run_migration` an artificially low internal threshold (e.g. treat every DDL
statement as "affecting" more rows than `approvalRequiredAboveRows`) so the existing
row-count gate fires by construction, (b) add a boolean to `run_migration`'s MCP
`inputSchema` that the agent could set, or (c) add a new `WriteMeta` field,
`alwaysRequireApproval`, that only tool-module code sets and that `TwoPhaseWrite.preview()`
ORs into the same `requiresApproval` decision the row-count check makes. (c) was picked.

(a) was rejected outright — it is exactly the "trying to make DDL's row count naturally
exceed the threshold" approach the ticket explicitly warns against: it would make
`run_migration`'s approval requirement an accident of a made-up number being bigger than
a config value nobody sees, rather than something a reviewer of `writeCore.ts` can verify
by reading the code. It would also silently stop working (migrations would fall through
to `status: "previewed"`) if `approvalRequiredAboveRows` were ever raised past whatever
fake number was chosen — a config change in one place quietly weakening a guarantee in
another, which is precisely the shape of bug this ticket calls out from #6/#7.

(b) was rejected because it is a parameter the calling agent controls, even if the
*intent* is that `run_migration` always sets it to `true` — a `z.boolean().optional()`
in the schema that a future tweak forgets to hardcode, or that a caller talking to the
tool via a slightly different path passes explicitly, is a live footgun. The ticket is
explicit that the flag "can't be spoofed or bypassed by the calling agent."

(c) closes that gap structurally: `alwaysRequireApproval` is not part of
`run_migration`'s `inputSchema` in `src/server.ts` at all — nothing in the parsed
`args` reaches it. `src/tools/runMigration.ts` sets `alwaysRequireApproval: true`
unconditionally on its one call to `write.preview()`; there is no branch, no
config-driven default, no way to construct a `run_migration` call that omits it. The
same idea already exists in this codebase for a different reason — `tool` on
`WriteMeta` is likewise set by the calling tool module, never taken from agent input —
so this is one more field in the same "meta the tool module owns" bucket, not a new
category of state. `TwoPhaseWrite.preview()`'s change is one line:
`requiresApproval = meta.alwaysRequireApproval === true || affectedRows > this.approvalRequiredAboveRows`.
`write.hardMaxRows` needed no equivalent override: `run_migration`'s `affectedRows` is
always `0` (see below), which can never exceed a hard cap that config validation
already requires to be a positive integer, so the hard-cap wall simply never applies to
DDL — not because it was special-cased away, but because the number it compares
against is structurally always small enough.

An alternative not taken: making `isDdlStatement(statement)` (see below) itself force
approval, so *any* CREATE/ALTER/DROP text preview() ever sees requires approval,
regardless of which tool called it. This would arguably be even harder to bypass by
accident. It was rejected because it conflates two independent concerns that happen to
share one keyword check: "how do I build valid SQL for this statement" (mechanical,
derived from statement text, safe to get from a regex) and "does this specific call
require a human" (a security decision that should be an explicit, auditable choice by
the calling tool module, not an emergent property of what a statement's first word
happens to be). Keeping them separate means a future non-DDL tool that also needs
mandatory approval doesn't have to construct DDL-shaped SQL to get it.

### Why `writeCore.ts` needed a real code path for DDL, not just a threshold tweak

`TwoPhaseWrite.preview()`/`execute()` wrap every statement as
`WITH _affected AS (${statement} RETURNING *) SELECT count(*), sample_rows, rows_digest ...`
— this is invalid SQL for `CREATE TABLE`/`ALTER TABLE`/`DROP TABLE`/`CREATE INDEX`,
none of which support a `RETURNING` clause. Wiring `run_migration` through the
unmodified core (as attempted first, mirroring #8's "wire it straight through and see
what breaks" approach) fails on the first `CREATE TABLE` preview with a syntax error,
not a `ROWSET_CHANGED` mismatch the way #8's INSERT case did — DDL doesn't get far
enough into the existing SQL to reach that check at all.

Fix: a new `isDdlStatement(statement)` leading-keyword check (`^\s*(create|alter|drop)\b`,
the same "this project's own tool code builds every statement, never raw agent SQL"
reasoning `isInsertStatement` already relies on) branches both `preview()` and
`execute()`. When true, the raw statement runs directly inside the same
`BEGIN`/`ROLLBACK` (preview) or `BEGIN`/`COMMIT` (execute) — Postgres DDL is
transactional, so this rolls back and commits exactly like the RETURNING-wrapped path
does for DELETE/UPDATE/INSERT, verified against a live Postgres in
`tests/runMigration.test.ts` for `CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`, and
`CREATE INDEX` (preview leaves no trace; execute, once approved, leaves exactly the
expected table/column/index behind). `affectedRows`/`sampleRows` are hardcoded to
`0`/`[]` on this path — not a fake row count standing in for something else, but the
literal, accurate answer for a statement with no `RETURNING` rows to report.

### The ROWSET_CHANGED digest check: skipped for DDL, for a stronger reason than INSERT's

Ticket #8's entry above explains why the digest comparison is skipped for INSERT: there's no
pre-existing matched row set to compare against, so the check would false-positive on
every insert into a table with a server-generated column. DDL shares that same
underlying reason (no pre-existing matched rows a WHERE clause selected) but more
fundamentally: there is no digest to compare in the first place, because there was
never a `RETURNING` result to hash. `execute()`'s DDL branch skips the whole
digest-comparison block, not just the equality check — `rowsDigest` is set to `""` at
preview time and never read back out on the DDL path. What `run_migration` keeps from
the core, same as INSERT: `statementFingerprint`-bound tokens (so `execute_plan` cannot
run a different statement than what was previewed and approved), single-use/expiring
tokens, the approval mechanism (now unconditional rather than threshold-driven — see
above), and full audit logging on every path.

### What "allowlist" means for DDL: extract the target from statement text, not a catalog lookup

`delete_rows`/`insert_rows`/`update_rows` take a structured `table` argument and check
it against `isTableWritable` before building any SQL. `run_migration` takes a single
opaque `statement` string instead (DDL is too varied — `CREATE TABLE`, `ALTER TABLE ...
ADD COLUMN`, `CREATE INDEX ... ON` — to fit the same `table`/`columns`/`set` shape), so
enforcing the same allowlist meant first extracting *which* table/index the statement
names.

A catalog lookup (resolve the name against `pg_class`, the way `sqlGuard.ts`'s
`assertTablesAllowlisted` already does for the read allowlist) was rejected as the
primary mechanism: `CREATE TABLE`'s target doesn't exist yet at preview time, so
`to_regclass` on it always returns null — there is nothing in the catalog to look up.
The allowlist check has to work from the statement's own text.

`src/tools/ddlTarget.ts`'s `parseDdlStatement()` does this with a small, deliberately
narrow parser reusing `sanitizeSql`/`readWord`/`skipWs` from `sqlGuard.ts` (exported for
this purpose) rather than a second, independent tokenizer that could disagree with the
first on edge cases (quoted identifiers, a string literal containing `;` or a keyword).
It recognizes exactly the forms the ticket names — `CREATE TABLE`, `ALTER TABLE`,
`DROP TABLE` (one or more comma-separated targets), and `CREATE [UNIQUE] INDEX
[CONCURRENTLY] [IF NOT EXISTS] [name] ON [ONLY] <table>` — and reports anything else,
including a bare `DROP INDEX`, as `UNSUPPORTED` with no targets. `run_migration` treats
`UNSUPPORTED` (or a recognized form whose target still failed to parse) as a hard
refusal (`INVALID_INPUT`), not a silent skip of the allowlist check — deny-by-default,
consistent with `isTableWritable`'s own "no config means nothing is writable" default.

`DROP INDEX` was deliberately left unsupported rather than half-supported: the table an
index belongs to cannot be determined from `DROP INDEX <name>`'s statement text alone —
unlike `CREATE INDEX ... ON <table>`, there's no `<table>` in the statement — so
enforcing the allowlist for it would require a `pg_index`/`pg_class` catalog lookup
using the writer pool, similar to `assertTablesAllowlisted`, before ever calling
`write.preview()`. That's a reasonable follow-up but adds a second kind of DDL target
resolution (text-based for everything else, catalog-based for this one form) for a
statement form the ticket's own examples ("CREATE/ALTER/DROP TABLE, indexes, etc.")
don't call out specifically; refusing it clearly (with a hint naming the supported
forms) was judged better than shipping a half-implemented allowlist check for it.

### `target` threaded through `WritePreview`/`PendingPlan`, not a new audit-log column

The ticket asks the pending-plan view to show "the exact statement, the target
table/schema if extractable, and the reason." `statement` and `reason` already flow
through the existing `WriteMeta`/`TokenEntry`/`PendingPlan` plumbing #6/#7 built;
`target` (the schema-qualified name(s) `ddlTarget.ts` extracted, e.g.
`"public.customers"`) was added as one more field alongside them — `WriteMeta.target` →
`TokenMeta.target`/`TokenEntry.target` → `WritePreview.target`/`PendingPlan.target` —
rather than a parallel data structure. It's `null` for every other tool (their
`affected_rows`/`sample_rows` already identify what the statement touches, so there's
nothing for `target` to add there). No `mcp_audit.log` schema change was needed: the
audit row's existing `statement` column already contains the full DDL text a human or
operator can re-derive the target from, and the ticket's audit acceptance criterion
only calls for the `reason` — adding a redundant `target` column purely for display
would be exactly the kind of drift-prone duplicate column the #7 entry below already
argued against when it reused `approved_by` for "who rejected" instead of adding
`rejected_by`.

### Multi-statement guard: reused `sqlGuard.ts`'s `assertSingleStatement`, not a new one

`delete_rows`/`insert_rows`/`update_rows` never faced this problem the same way —
they take structured arguments (`table`, `where`, `set`) and build the SQL themselves,
so there was never a raw agent-supplied statement string to split on `;` in the first
place (and node-postgres's extended query protocol, which every write tool already uses
by always passing a `values` array even when empty, refuses multiple statements in one
`Parse` message regardless). `run_migration` is different: `statement` *is* raw
agent-supplied text, the same shape `query`/`explain_plan` already accept. Rather than
write a second multi-statement detector, `run_migration` calls the exact same
`sanitizeSql` + `assertSingleStatement` pair those two read tools use — the same
comment/string-literal-safe masking, the same `MULTI_STATEMENT`/`EMPTY_STATEMENT`
error codes — before ever calling `write.preview()`, so a semicolon or the word
CREATE/ALTER/DROP inside a quoted identifier or a string-literal default value (e.g.
`DEFAULT 'a; maybe-keyword-looking text'`) doesn't false-positive, verified in
`tests/runMigration.test.ts`.

---

## 2026-08-13 — insert_rows/update_rows (#8): shared guard, and why the rows-changed digest must skip INSERT

**Ticket:** #8 — extend the two-phase core (`src/writeCore.ts`, built for #4/#6/#5/#7)
to `insert_rows` and `update_rows`, the same way `delete_rows` already uses it.

### No-WHERE guard: generalized into `src/tools/writeStatements.ts`, not duplicated

`delete_rows`'s "refuse an empty WHERE unless `confirm_full_table: true`" check
previously lived as inline logic inside `src/tools/deleteRows.ts`. `update_rows` needs
the identical guard (same acceptance criterion, same escape hatch). Rather than copy
the four lines into `updateRows.ts` — which is exactly the kind of drift that lets one
copy get hardened later while the other doesn't — `parseQualifiedName`,
`quoteIdentifier`, and a new `requireWhereOrConfirm` were pulled out into
`src/tools/writeStatements.ts`, and `delete_rows` was switched to call the shared
version too (`tests/writeStatements.test.ts` asserts the DELETE and UPDATE call sites
produce byte-identical error codes/messages modulo the verb/gerund passed in, and that
generalizing it didn't quietly loosen it — `1=1` still counts as "has a WHERE clause,"
no tautology detection was added). `insert_rows` doesn't call this at all: INSERT has
no WHERE clause, so the guard simply doesn't apply — per the ticket, not a gap.

### The ROWSET_CHANGED digest check cannot apply to INSERT — this is a core gap, not a workaround site

Wiring `insert_rows` straight through `TwoPhaseWrite` (as the ticket asks — "if either
tool needs to reach around the core, that's a signal the core has a gap") immediately
failed every execute_plan call against a table with any server-generated default
column (a `serial`/`identity` primary key, in the test tables): `execute()` always
raised `ROWSET_CHANGED`.

The reason: `rows_digest` is computed by hashing the `RETURNING *` rows, and is meant
to catch "the set of rows this statement matches changed between preview and execute"
for DELETE/UPDATE's WHERE-matched rows. For INSERT there is no pre-existing matched
row set to compare — the RETURNING content is freshly generated every execution, most
visibly a `serial` column's `nextval()`. Critically, the *preview* itself is a real
(rolled-back) INSERT, so it already consumes a sequence value; the execute's real
INSERT then consumes the *next* one. The preview's digest and the execute's digest are
therefore guaranteed to differ for such a table, on every single insert, which is not
the concurrent-modification signal this check exists to catch — it would make
`insert_rows` permanently broken against any table with an identity/serial column, not
occasionally trip on genuine concurrent activity.

Fix (in `writeCore.ts`, not worked around per-tool): `execute()` now skips the digest
equality check when the statement is an INSERT (`isInsertStatement()`, a leading-
keyword check). `execute_plan` does receive `statement`/`params` back from the agent —
they aren't confined to `src/tools/*.ts` — but `TokenStore.consume()` recomputes
`statementFingerprint(statement, params)` and rejects any mismatch before execution, so
`isInsertStatement()` only ever runs against the exact statement that was previewed,
never an agent-substituted one. The digest is still computed and stored either way (no
separate code path in the SQL itself); only the comparison is conditional. What INSERT still gets from the core,
unchanged: preview-then-rollback with an exact count and RETURNING sample,
`statementFingerprint` binding the token to the exact statement + params (so
execute_plan cannot be tricked into inserting something other than what was
previewed), single-use/expiring tokens, the approval threshold and hard cap, and full
audit logging on every path. What it deliberately does not get, because it cannot
mean anything for INSERT: protection against "someone else changed the matched rows
since I looked" — there is no antecedent "matched rows" for a literal VALUES list.

### Sequence gap is a documented side effect, not a bug to route around

A rolled-back `insert_rows` preview permanently advances any sequence the inserted
columns default from — Postgres sequences are non-transactional by design, so this is
not fixable (and not desirable to fix) from application code. `tests/insertRows.test.ts`
has a test asserting the gap is real (a later actually-executed insert's id jumps by
more than 1 across a preview-only insert in between). Documented in the README rather
than treated as a defect.

### update_rows: WHERE params first, SET params appended after — no renumbering of caller SQL

`update_rows` accepts `set` (a column→value object) and `where` (raw SQL text using
`$1, $2, ...`, identical in spirit to `delete_rows`'s `where`/`params`). Both need
parameters, and Postgres has one flat `$n` parameter list per statement. Two options:
(a) renumber the caller's WHERE placeholders to make room for SET's, or (b) keep the
caller's WHERE placeholders exactly as given and append SET's values after them. (b)
was picked — it never touches or reparses the caller-supplied WHERE text (lower risk:
a renumbering pass is itself a small SQL parser that could get a corner case wrong),
at the cost of the WHERE clause's `$1..$M` params being written first and SET's
`$(M+1)..` last in the final statement, which is purely an implementation detail the
agent never has to reason about (it only ever gets `params` back from the preview and
replays them verbatim, the same as every other tool here).

---

## 2026-08-13 — Localhost approval UI: reject as a tombstone, pending-plan data stored on the token, one HTTP surface with no framework

**Ticket:** #7 (localhost approval UI with approve and reject). Builds directly on the
2026-08-13 / #6 entry below — same plan-token store, same "no separate approvals table"
reasoning, same "not an MCP tool" security boundary, now extended to a symmetric reject.

**Approach vs. #1's conclusion:** unchanged. #1 (see the 2026-08-12 entry below)
concluded the out-of-band localhost page is the primary approval mechanism because no
shipping client we target implements spec-native elicitation/MRTR yet. Nothing about
that client-support situation changed by this ticket, so this page is built exactly as
ticket #1 anticipated — no divergence to record there.

### Where the pending-plan data (statement, sample rows) lives

`TokenEntry` (the in-memory record `TwoPhaseWrite.preview()` already creates per plan)
previously stored only a fingerprint hash and a rows digest hash of the statement/params
— enough to *verify* a later `execute_plan` call, but not enough to *display* the
statement or sample rows again later. The localhost page needs to render both without
re-running the preview (which would re-execute the statement inside a fresh
transaction). Two options: (a) add `statement`, `params`, and `sampleRows` directly onto
`TokenEntry`, or (b) stand up a second, parallel store keyed by `plan_token` just for
display data. (a) was picked — it is one more field group next to the
`requiresApproval`/`approved` flags the 2026-08-13/#6 entry below already put there,
governed by the same lifecycle (created at preview, alive until used/expired/rejected),
rather than a second data structure that could drift out of sync with the first. The
memory cost is bounded by the same TTL and prune() sweep that already bounds the token
store's size.

### Reject semantics: a permanent tombstone, not a deletion

"Permanently kills the token" (the ticket's own words) could mean either (a) delete the
entry outright, so a later `execute_plan`/`approvePlan` call reports `UNKNOWN_TOKEN`, or
(b) keep the entry with a `rejected` flag set, so those calls report a distinct
`PLAN_REJECTED` instead. (b) was picked, for the acceptance criterion that matters most
here: *"The agent receives a rejection as a structured error distinguishable from a
timeout, an expiry, or a hard-cap refusal."* `UNKNOWN_TOKEN` already means "never issued
or long gone" for three unrelated reasons (typo, stale token, server restart) — collapsing
"a human looked at this and said no" into that same bucket would make the one outcome
this ticket exists to make legible indistinguishable from an agent's-own bug. So:

- `TokenStore.reject()` sets `entry.rejected = true` and (once) an optional
  `rejectionReason`; it never deletes the entry.
- `prune()` (which normally sweeps used/expired entries) explicitly skips rejected
  entries, so a rejected token cannot silently age out into `UNKNOWN_TOKEN` before an
  agent's retried `execute_plan` call reaches it.
- Both `consume()` (backing `execute_plan`) and `approve()` check `entry.rejected` first
  — ahead of used/expired/fingerprint checks — so rejection wins regardless of what else
  is true about the call. This is also what makes "approving after rejecting" and
  "rejecting twice" both safe: approve() on a rejected entry fails with `PLAN_REJECTED`
  (never flips `approved`), and reject() on an already-rejected entry succeeds again
  idempotently without changing anything.
- The cost is that a rejected token's memory is never reclaimed by TTL alone — bounded
  in practice (rejections are a human-paced, low-volume path; see #6's entry below on
  bounding tombstone-style state by the same lifecycle as everything else), and
  acceptable for a v1 whose plan-token store is already fully in-memory and
  process-scoped with no persistence story beyond the audit log.

### `approved_by` reused for "who rejected", no new migration

The audit schema (`docker/init/02-audit-log.sql`) has one actor-identity column,
`approved_by`, sized for `TwoPhaseWrite.approvePlan()`'s `approvedBy` argument.
`rejectPlan()`'s `rejectedBy` argument is written into that same column rather than
adding a `rejected_by` column that would sit next to it doing the identical job — the
column already means "who actioned this token," not narrowly "who approved this token,"
and a second column with the same shape and purpose would only exist to satisfy a naming
mismatch, not a real distinction. `docker/init/03-approval-workflow.sql` (ticket #6)
already extended `mcp_audit.log.status`'s `CHECK` constraint to include `rejected`
in anticipation of this ticket, so no new migration was needed for #7 at all.

### One local HTTP server, `node:http`, no new dependency

The page is server-rendered plain HTML with a small inline `<script>` doing two
`fetch()` calls (approve/reject) and reloading — the ticket explicitly asks to resist
making this a React app ("a form with two buttons"). Built on Node's built-in `http`
module rather than adding Express or similar: the whole surface is four routes (`GET /`,
`GET /api/plans`, `POST /api/plans/:token/approve`, `POST /api/plans/:token/reject`), and
the project has otherwise stayed dependency-light (`pg`, `zod`, the MCP SDK). The JSON
API (`GET /api/plans` and the two POST actions) exists as a first-class surface, not an
implementation detail behind the HTML — it is what `tests/approvalUi.test.ts` drives
directly with plain `fetch()`, matching the ticket's own guidance that no browser
automation is needed to verify this.

The server binds to `127.0.0.1` unconditionally — `src/approvalServer.ts` hardcodes the
host, and `config.approvalServer` (src/config.ts) only exposes `enabled`/`port`, no host
override — so there is no configuration path that could accidentally expose it on
`0.0.0.0`. `src/index.ts` constructs one `TwoPhaseWrite` instance and shares it between
`startServer` (the MCP stdio transport) and `startApprovalServer`, so an approval or
rejection is visible to `execute_plan` in the same process without any new
inter-process channel.

---

## 2026-08-13 — Approval mechanism's shape: a flag on the plan token, no separate approvals table

**Ticket:** #6 (approval threshold, hard row cap, `awaiting_approval`). Read by: #7
(localhost approval UI), which is expected to build its "approve" / "reject" buttons
on top of what's described here rather than invent its own storage.

**Question:** #6 needs *some* concrete way for a plan to go from "awaiting approval" to
"approved" — #7 explicitly "unlocks `execute_plan`" on top of it, but #7's actual UI is
out of scope here. What is the smallest mechanism that is still a real, documented
contract #7 can build on, rather than a placeholder #7 has to redesign?

### What #6 builds

- Two new `write` config thresholds, both compared against the **exact** rollback-preview
  row count (`TwoPhaseWrite.preview`'s `affectedRows`), never an `EXPLAIN` estimate:
  `approvalRequiredAboveRows` (default 100) and `hardMaxRows` (default 10,000, must be
  `>= approvalRequiredAboveRows`).
- A plan token's in-memory record (`TokenEntry` in `src/writeCore.ts`, alongside the
  fingerprint/expiry/used-once state ticket #4 already put there) gained two fields:
  `requiresApproval` (set once, at preview time, from the threshold check above) and
  `approved` (`true` immediately if `!requiresApproval`; otherwise flipped by approval).
  `execute_plan` refuses with `AWAITING_APPROVAL` while `requiresApproval && !approved`.
- `TwoPhaseWrite.approvePlan(planToken, approvedBy)` is the entire approval mechanism:
  it looks up the token, flips `approved = true`, and writes an `approved` audit row
  (`tool` set explicitly to `"approve_plan"`; `approved_by` = the caller-supplied
  identity, default `"unknown"`). It does not consume the token — `execute_plan` still
  runs its own statement/fingerprint/expiry/rowset checks afterward, unchanged. It is
  idempotent (approving twice, or approving a token that never required approval, both
  just succeed).
- **Deliberately NOT exposed as an MCP tool.** `approve_plan` is a real, callable,
  internal/programmatic method — not a stub — so it can be exercised by tests and (once
  #7 exists) by a human, but it is not on the agent-facing MCP server's tool list. The
  whole point of `awaiting_approval` is a human-in-the-loop gate; if the same MCP
  connection an agent uses to request a gated write could also call `approve_plan`, the
  gate would be theater — the requesting agent could preview a write, "approve" its own
  plan with a self-reported `approved_by`, and execute it, with nothing to stop it. So
  `approvePlan` is exported from `TwoPhaseWrite` for #7's out-of-band localhost approval
  page (see the 2026-08-12 entry below) to call directly, and is exercised in tests the
  same way — never through the MCP tool-dispatch layer.
- A row over `hardMaxRows` never reaches any of the above: no token is created at all
  (`HARD_MAX_ROWS_EXCEEDED`, audited as `hard_cap_refused`). There is nothing for an
  approval mechanism to act on in that case by design — the ticket's "wall, not a gate."

### What #6 deliberately does not build

- **No `reject_plan` / no `rejected` audit status wired up.** `mcp_audit.log.status`
  already had `rejected` in its enum (anticipated by #5), and this ticket's migration
  (`docker/init/03-approval-workflow.sql`) leaves it in place, but nothing in #6 writes
  it. Rejection is #7's acceptance criteria (permanently invalidate the token; refuse
  even a correct statement afterward) and #7's to build, most likely as
  `TwoPhaseWrite.rejectPlan` alongside `approvePlan`, deleting the token from the store
  outright rather than approving it.
- **No standalone approvals table.** The plan token is already the unit `execute_plan`
  is scoped to, and it already lives somewhere ticket #4 built for exactly this kind of
  short-lived, single-use state — an in-memory `TokenStore` inside one running
  `TwoPhaseWrite` instance. Approval state is one more flag on that same record, not a
  new subsystem. This does mean approval is scoped to the process that issued the
  preview (same as the token's expiry and single-use guarantee already were) — a plan
  previewed against one server instance cannot be approved from another. That was
  already true of every other property of a plan token before this ticket; #7's
  same-process localhost page does not change it.
- **No listing/query API for pending plans.** #7 needs "list what's awaiting approval"
  for its page. #6 does not add a `list_pending_plans`-shaped tool; the `TokenStore` has
  no enumeration method today. #7 will need to add one (e.g. an accessor on `TokenStore`
  exposing entries with `requiresApproval && !approved && !used && !expired`, or reading
  `mcp_audit.log` for the most recent `awaiting_approval` row per un-superseded
  `plan_token`) — either is compatible with what's here.

### Why this shape, not a database-backed approvals table

A DB table would survive a server restart and be inspectable directly with `query`
without a bespoke listing tool — real advantages. It was not chosen because the plan
token itself does not survive a server restart either (the whole two-phase-write core is
in-memory and TTL'd), so a persisted approval record would outlive the thing it approves
by design, which is more confusing than convenient: an operator could "approve" a token
that has already silently expired. Keeping approval state exactly as durable as the plan
it approves — no more, no less — was judged the more honest contract. The audit log
already gives durability for the *history* of what was approved and by whom; it is just
not the thing `execute_plan` checks live.

### For #7

Two front-ends over one mechanism, same framing as the 2026-08-12 entry below:
`TwoPhaseWrite.approvePlan()` (this ticket) is the whole "approve" button's backend
already — #7's localhost page calls it directly (it is not, and must not become, an MCP
tool the agent itself can reach). #7 mainly needs to add (a) a way to list pending
(`awaiting_approval`, unexpired, unused) plans, and (b) a symmetric `rejectPlan` that
deletes the token instead of approving it and returns a rejection `execute_plan` can
distinguish from `AWAITING_APPROVAL` / `EXPIRED_TOKEN` / `USED_TOKEN` (its own new
`WriteErrorCode`, e.g. `PLAN_REJECTED`) — likewise called directly by #7's page, not
exposed as `reject_plan` on the MCP server.

---

## 2026-08-13 — Append-only audit log: enforced by a `REVOKE`, not by application code

**Ticket:** #5 — a separate `mcp_audit` schema holding one append-only table, immediately
after the two-phase core (#4) so every later write tool inherits auditing rather than
having it retrofitted.

**Question:** the ticket's own wording is "genuinely append-only" — not a convention the
code politely follows. What makes a guarantee like that real rather than aspirational?

### Enforcement point: a grant the `writer` role does not have

Two options: (a) have `TwoPhaseWrite`/`AuditLog` only ever call `INSERT` against
`mcp_audit.log` and trust that discipline — no application code path currently issues an
`UPDATE`/`DELETE` against it, so in practice nothing violates append-only today; (b) make
it structurally impossible by revoking the privilege at the database. (a) was rejected
for the same reason ticket #2's role-separation entry below rejects parsing as a safety
boundary: "no code path does X today" is not the same claim as "no code path *can* do X,"
and the whole value of an audit trail is that a future bug, a careless refactor, or a
compromised dependency can't quietly rewrite history. (b) was picked:
`docker/init/02-audit-log.sql` grants `writer` `INSERT` (and `USAGE` on the id sequence an
`INSERT` needs) and nothing else, then explicitly
`REVOKE UPDATE, DELETE, TRUNCATE ON mcp_audit.log FROM writer`. A `writer`-role connection
attempting any of those three gets Postgres's own `permission denied` — asserted by a real
test against a live database (`tests/auditLog.test.ts`), not just asserted in a comment.
`readonly` gets `SELECT` only on the same table, so an operator can inspect the trail
without ever having write access to it either. This mirrors ticket #2's role-separation
entry below exactly: enforcement lives in a permission the role doesn't have, not in a
check the application chooses to run.

**Scope of the guarantee, stated honestly:** this only holds for connections that
authenticate as `writer` (or `readonly`). A Postgres superuser, or any role with
equivalent administrative privileges, sits outside the model entirely and can `GRANT`
itself the revoked privileges back, or bypass them outright — no `REVOKE` on `writer` can
stop the database's own administrator. This is not a gap the ticket missed; it is what
"the database enforces it" always means in practice, and it is called out explicitly in
the README's Limitations section so a reviewer doesn't mistake "genuinely append-only"
for "tamper-proof against anyone with database admin access."

### `params_redacted`: a shape, not the values

The audit row's `params_redacted` column records `{ type, length }` per parameter rather
than the literal values. An audit trail exists so an operator can reconstruct *what kind*
of statement an agent ran and why — not to become a second copy of whatever sensitive
data passed through the statement (an email address, a token, a customer name). Storing
literal values would make the audit log itself a thing worth protecting as carefully as
the tables it audits, defeating some of the point of having a comparatively low-privilege
`readonly`-readable trail. `statement` (the SQL text) is stored in full, since
schema/table names and the shape of a query are what audit review is actually for; only
the parameter *values* are redacted.

### Audit-write failures never mask the write's own outcome

`AuditLog.record()`'s failure path is logged to stderr and swallowed rather than thrown.
The alternative — letting a transient audit-insert failure (a brief connection blip)
propagate as the *write's* failure, or worse, roll back a write that had already
committed — would make a monitoring hiccup on the audit path indistinguishable from an
actual data-safety failure, which is a strictly worse failure mode for exactly the tool
this project is trying to be trustworthy about. The audit row is recorded on the same
connection *after* the `COMMIT`/`ROLLBACK` it describes (see `writeCore.ts`'s `execute()`
and `preview()`), specifically so a failure writing the audit row can never itself roll
back a write that already succeeded, or be confused with one that failed.

---

## 2026-08-13 — Preview-and-rollback beats `EXPLAIN`; plan tokens bind to a statement-hash fingerprint

**Ticket:** #4 — the two-phase write core (`delete_rows`, `execute_plan`, and the
token guarantees: expiry, single-use, statement binding, the no-`WHERE` guard,
`statement_timeout`). The largest ticket in the build, by design — "every later write
tool inherits whatever this does."

### Why the preview is a real rolled-back execution, not an `EXPLAIN` estimate

**Question:** how does the server learn the exact blast radius of a write before letting
anything commit? Two options: (a) run `EXPLAIN` (optionally `ANALYZE`) and gate on the
planner's estimated row count; (b) actually run the statement inside `BEGIN`, capture the
exact count via `RETURNING`, then `ROLLBACK`.

(a) was rejected. A planner estimate is derived from table statistics — histograms,
n-distinct counts — gathered by `ANALYZE`, which can be stale (most visibly right after a
bulk load, like `npm run seed:demo`'s ~208k rows, before autovacuum's next `ANALYZE` has
run) or simply wrong for a predicate whose column correlations the planner can't model.
The entire safety mechanism — `approvalRequiredAboveRows`/`hardMaxRows` — is a threshold
compared against a row count; if that count is a guess, the threshold is a guess too, and
a statement whose *true* affected-row count is 40,000 could sail under a 100-row threshold
because the planner estimated 80. That failure mode is silent — nothing about it looks
wrong until the numbers are compared after the fact — which is the opposite of what an
approval gate is for.

(b) was picked: for the DML tools (`delete_rows`/`insert_rows`/`update_rows`),
`TwoPhaseWrite.preview()` wraps the statement as
`WITH _affected AS (${statement} RETURNING *) SELECT count(*), sample_rows, rows_digest ...`,
runs it for real inside a transaction, then rolls back. The row count in every preview
response is the exact count a real execution just produced — not a projection of one.
(DDL, added later by #9's `run_migration`, has no `RETURNING` to wrap: its preview runs
the statement directly inside `BEGIN … ROLLBACK` and reports 0 affected rows plus a
`target` extracted from the statement text — see #9's entry above. DDL's safety comes
from *always* requiring approval regardless of that row count, not from this exact-count
mechanism.) This is strictly more expensive than `EXPLAIN` (a real execution, rolled back, followed
later by another real execution to commit), which is accepted deliberately: correctness of
the row count is the entire point of the safety layer, and `EXPLAIN`'s only remaining job
is the separate, explicitly-cheap `explain_plan` tool — a pre-check an agent can call
*before* attempting a two-phase write, never a substitute for the preview's real count.

A consequence of "the preview is a real execution": the preview and the execute must
never share an open transaction (an open transaction sitting idle while the agent decides
whether to execute holds locks and a pool connection for however long that takes — from
milliseconds to the full `planTtlMs`, 60s by default). `preview()`/`execute()` each check
out their own connection from the pool and release it in a `finally`, so no transaction
outlives a single call — verified directly by a test that asserts no connection is left
mid-transaction between the two calls (`tests/twoPhaseWrite.test.ts`).

### Why a plan token binds to a hash of the statement + params

**Question:** a plan token is a server-issued credential — but a credential for *what*,
exactly? If it only proves "a preview happened, at some point," nothing stops
`execute_plan` from being called with a valid token and a *different* statement than the
one that was actually previewed — a wider `WHERE`, a different table, extra literal rows
— a bait-and-switch a human approving a plan in the localhost UI would have no way to
detect, since they approved based on what the UI showed them, not on some invisible
identity a random token carries.

Two options: (a) treat the token alone as sufficient — whatever statement/params
`execute_plan` is called with is trusted as "the thing this token authorizes"; (b) hash
the exact statement text and parameter values at preview time, require `execute_plan` to
pass the statement/params back, and refuse on any mismatch between the recomputed hash and
the one stored at issuance. (a) was rejected for the bait-and-switch reason above — it
would make the token a general "this caller may write something" capability rather than
authorization for one specific, already-reviewed statement, which quietly undermines the
entire point of a human-reviewable preview (ticket #6/#7's approval mechanism, built
later, depends on this token meaning "the exact thing a human looked at").

(b) was picked: `statementFingerprint(statement, params)` (`src/writeCore.ts`) is
`sha256(statement.trim() + "\0" + JSON.stringify(params))`, computed once at preview time
and stored on the token; `TokenStore.consume()` recomputes it from whatever `execute_plan`
is actually called with and refuses with `STATEMENT_MISMATCH` on any deviation, before
touching the database at all. `execute_plan`'s MCP tool schema requires the agent to pass
`statement`/`params` back explicitly (`src/server.ts`) rather than trusting server-side
memory alone, specifically so this recomputation has something independent to check
against — the agent's own claim about what it's executing is verified, not assumed.

This is deliberately a **separate** mechanism from the rows-affected digest check
(`rows_digest`, also built in this ticket): the fingerprint catches "a different statement
or different params than what was previewed," while the digest catches "the *same*
statement, but the rows it now matches changed since preview" (e.g. a concurrent insert
added a new row into a `WHERE`'s predicate — `ROWSET_CHANGED`). Neither check subsumes the
other: the fingerprint alone would not catch a same-statement-different-rows race, and the
digest alone would not stop a rewritten statement that happens to affect a same-looking
row set. `insert_rows` (#8) and `run_migration` (#9) later needed to skip the digest check
specifically — see their own entries above — but both keep the fingerprint check
unconditionally; it is the one guarantee that applies to every write tool with no
exceptions.

---

## 2026-08-12 — Role separation via Postgres grants, not statement parsing

**Ticket:** #2 — scaffold the server with dual-role pools and `describe_schema`. The
foundation every later tool builds on: "read-only is enforced by the database, never by
parsing SQL. A bug in our code must not be able to turn a read tool into a write tool."

**Question:** how does the server guarantee a read tool (`describe_schema`, `query`,
`explain_plan`) can never mutate the database, no matter what SQL an agent asks it to run
or what bug this project's own code might have?

### Enforcement point: which Postgres role a connection authenticates as

Two options: (a) enforce it in application code — parse or pattern-match every statement a
read tool builds or accepts, and reject anything shaped like a write (a regex for a
leading `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE`, or a more careful SQL-aware check); (b)
enforce it at the database — connect as two distinct Postgres roles, `readonly` (granted
`SELECT` only) and `writer` (granted `SELECT, INSERT, UPDATE, DELETE`, further scoped by
this project's own write allowlist), and never let a read tool acquire a connection from
the writer pool.

(a) was rejected as the primary mechanism, on the same reasoning this project later
applied to its own read-allowlist parser: a parser can always be fooled by a form it
wasn't specifically written to catch — a CTE-wrapped mutation
(`WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x`), a function call that mutates as
a side effect, a quoting or escaping edge case a regex didn't anticipate — and every one of
those is a case where the *safety property itself* fails silently, not a cosmetic bug.
This project's own `sqlGuard.ts` (built one ticket later, for the narrower job of
extracting table references for the *read* allowlist) is a live demonstration of how hard
that is to get right even for a much smaller problem: it needed several dedicated
hardening passes for quoted identifiers, `U&"..."`-escaped Unicode identifiers,
dollar-quoted string bodies, and comment-safe scanning before it reliably resolved what a
statement was actually referencing. A parser trying to soundly answer "is this SQL a
mutation, in general" is a strictly harder, more open-ended version of the same problem —
not a place to put the one guarantee this entire project exists to make.

(b) was picked: `docker/init/01-roles.sql` provisions `readonly` with `SELECT` only (and
`CREATE` explicitly revoked on the `public` schema, defense in depth against a read tool
somehow being coerced into `CREATE TABLE ... AS`), and `writer` with full DML. A mutating
statement submitted through the `readonly` pool is refused by Postgres itself with
`permission denied`, regardless of what the SQL text says or how this project's own
TypeScript parses or fails to parse it — verified against a live database in
`tests/roles.test.ts`, not just documented. This is the same shape of guarantee ticket #5
later reuses for the audit log's append-only property (see its entry above): a permission
the role does not have, not a check the application chooses to run.

### This doesn't retire parsing — it demotes it to defense-in-depth

`query`/`explain_plan` still reject non-`SELECT`-shaped input (`assertReadStatement`) and
still enforce the *read allowlist* by extracting table references from statement text
(`extractTableReferences`/`assertTablesAllowlisted` in `sqlGuard.ts`) — parsing wasn't
abandoned, it was scoped down to a job where getting it wrong has a bounded consequence.
If that allowlist-extraction logic has an unnoticed gap (the way several review passes on
ticket #3 kept finding and fixing them for quoted/Unicode-escaped identifiers), the worst
case is an allowlist bypass — a table that should have been hidden becomes readable — not
a mutation succeeding through a read tool, which the role grant prevents regardless of
what the parsing layer does or misses. Both the tool descriptions and the README's threat
model say this explicitly: role separation is the safety boundary; the read-allowlist
parser is a second layer on top of it, not a replacement for it.

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