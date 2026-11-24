# Tool Middleware for n8n

An experimental self-hosted n8n community node that wraps calls to connected
AI tools with JavaScript. An agent can still see and call each tool individually.
The node executes middleware when a tool is invoked, not when it is connected.

> **Security: trusted workflow authors only.** The JavaScript runs without a
> sandbox in the n8n process, with access to its environment and privileges.
> Anyone able to write this code can potentially compromise the instance.
> Do not use this node in a multi-tenant or untrusted-editor environment.
> The node is not reviewed or verified by n8n.
>
> The npm dependency tree tested with n8n 3.2.2 includes `zod` 3.25.76 via
> `n8n-workflow`. npm audit reports
> [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
> (high-severity memory exhaustion on oversized constrained collections).
> This package does not fix the upstream n8n dependency; limit untrusted inputs
> and reassess the dependency when upgrading n8n.

## Requirements and installation

- Self-hosted n8n 3.2.2. The node was tested locally with this version only.
  It depends on internal Agent v3 toolkit routing; test every n8n upgrade.
- This unverified community package is not available on n8n Cloud.

After publication, use **Settings → Community nodes → Install** and enter
`n8n-nodes-tool-middleware`. Use only on a trusted instance. Review the
[community node risks](https://docs.n8n.io/integrations/community-nodes/risks/).

## Usage

Connect one or more AI tools to **Tool Middleware**, and connect its output to
an AI Agent. Write JavaScript in the node:

```js
const start = Date.now();
try {
  const result = await next(input);
  context.logger.info(`Tool ${tool.name} completed in ${Date.now() - start}ms`);
  return result;
} catch (error) {
  context.logger.error(`Tool ${tool.name} failed`);
  throw error;
}
```

- `tool.name`, `tool.description`: selected tool's name and description.
- `input`: tool arguments.
- `next(input)`: invoke the original tool and get its result.
- `context.logger`, `context.executionId`: n8n logger and execution ID.
- `context.request`: the current HTTP request, when n8n makes it available;
  otherwise `undefined`. For example, `context.request?.headers['x-user-id']`.
- `context.n8n`: the native n8n node context for the current execution phase.
  It can expose n8n methods and internal data beyond the convenience fields.
- The return value becomes the tool's response to the agent.

Calling `next()` more than once repeats the operation, including side effects.
Avoid logging tool inputs or results if they can contain sensitive data.
The request and native context can contain credentials, cookies, authorization
headers, and other sensitive data: do not log, return, or forward them wholesale.

Request headers are **untrusted client-supplied metadata**, not proof of
identity. Use them for identification only behind a trusted gateway that
authenticates the caller and replaces the relevant headers; do not use them
for access control by themselves. The node uses n8n's internal request
context, which is version-dependent and may be unavailable in queue mode,
Agent executions, or other execution paths. The available `context.n8n`
methods also differ between `supplyData` and `execute` phases. Do not assume
the request is always present, and test the actual deployment.

JavaScript is stored in each node instance. Editing it does **not** update other
workflows. There is no shared editable code store in this version.

## Schema override

**Schema Override JavaScript** runs for each connected tool during
registration, before the tool can be listed or called. For Agent v3 toolkit
routing it also runs when resolving an invocation. By default it returns the
original schema unchanged. The code receives:

- `schema`: the original tool schema; return the schema to register.
- `tool`: a shallow snapshot of the connected tool, including `name`,
  `description`, `schema`, and `metadata`.
- `z`: Zod v3 or v4, selected to match the original Zod object schema.
- `context.n8n`, `context.logger`, `context.executionId`: registration context.

Return either a schema (as in version 0.2.0), or a tool object with `name`,
`description`, `schema`, and optionally `metadata`. For example, remove a
prefix while extending the schema:

```js
if (Object.hasOwn(tool.schema.shape, 'response_format')) {
  throw new Error(`response_format already exists in ${tool.name}`);
}
return {
  ...tool,
  name: tool.name.replace(/^DataHub_MCP_Client_/, ''),
  schema: tool.schema.extend({
    response_format: z.enum(['json', 'compact']).optional(),
  }),
};
```

The exposed name is routed back to the original tool. Renamed tools must use
1–128 letters, digits, underscores, hyphens or dots; duplicate exposed names
are rejected. Metadata can be changed, but n8n's internal toolkit-routing flags
are enforced and human-review tools remain unsupported. The node always invokes
the original tool: modifying `func`, `invoke`, or other internal fields in the
returned object does not replace its implementation.

Overrides must be deterministic and side-effect-free: toolkit routing may
evaluate them again, with a different n8n execution context. Do not rely on
timestamps, random values, request headers, or execution-phase-specific context
to determine the name. Middleware invocation code sees the exposed name.

For an MCP Client Tool with a Zod object schema, add an optional parameter
without replacing existing fields:

```js
if (!schema.shape || typeof schema.extend !== 'function') {
  throw new Error(`Expected a Zod object schema for ${tool.name}`);
}
if (Object.hasOwn(schema.shape, 'response_format')) {
  throw new Error(`response_format already exists in ${tool.name}`);
}
return schema.extend({
  response_format: z.enum(['json', 'compact'])
    .describe('Response format: JSON or compact TOON.')
    .optional(),
});
```

For chained middleware, configure the schema override only on the inner node.
The outer node preserves the extended schema. The inner node's invocation code
must remove its field before invoking the original tool:

```js
const { response_format = 'json', ...args } = input;
const result = await next(args);
// Convert result to TOON here when response_format === 'compact'.
return result;
```

The override is trusted, unsandboxed code. The snapshot is shallow: return a new
schema and metadata instead of mutating the original. An error or non-object
return stops registration; the reserved `_n8nOriginalToolArg` is rejected.
The override is responsible for preserving required fields and detecting
schema-field collisions. It can modify or remove fields and break clients.

The node does not automatically strip added fields or perform TOON conversion;
middleware must handle its own fields. Renaming tools does not preserve legacy
parameters or response formats. MCP Client error handling can hide upstream
error status.

## Limitations

- This is a tool-call wrapper, not a complete replacement for LangChain Code.
- Human-review (HITL) tools are rejected; approval routing is not implemented.
- Tool names must be unique. `_n8nOriginalToolArg` is reserved by n8n.
- Agent v3 may merge workflow input fields into tool arguments.
- Toolkit member routing uses n8n internal metadata. Complex toolkits, nested
  middleware, multi-item runs, cancellation and queue mode need more testing.
- Schema overrides support Zod v3/v4 and JSON Schema objects. MCP Server
  Trigger schema conversion depends on n8n; the schema conversion
  used by n8n 3.2.2 is tested here for Zod v3, not Zod v4 or JSON Schema.
- The node has been exercised end-to-end in n8n 3.2.2 with Calculator and Code
  Tool as a private node. A separately installed npm package has passed
  component tests in the same n8n version, but not a full agent workflow.
  That does not establish compatibility with all n8n tools or versions.

## Development

```sh
npm ci
npm test
npm pack --dry-run
```
