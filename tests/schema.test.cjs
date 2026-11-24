'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DynamicStructuredTool } = require('@langchain/core/tools');
const z3 = require('zod/v3');
const z4 = require('zod/v4');
const { zodToJsonSchema } = require('zod-to-json-schema');
const { ToolMiddleware } = require('../nodes/ToolMiddleware/ToolMiddleware.node');

const schemaCode = `
	if (!schema.shape || typeof schema.extend !== 'function') throw new Error('Expected a Zod object schema');
	if (Object.hasOwn(schema.shape, 'response_format')) throw new Error('response_format already exists');
	return schema.extend({ response_format: z.enum(['json', 'compact']).describe('Response format').optional() });
`;

function context(tools, code, schemaOverride) {
	return {
		getInputConnectionData: async () => tools,
		getNodeParameter: (name, _index, fallback) => ({ code, schemaCode: schemaOverride })[name] ?? fallback,
		getNode: () => ({ name: 'Middleware', type: 'toolMiddleware' }),
		getExecutionId: () => 'test',
		logger: {},
	};
}

function original(schema) {
	return new DynamicStructuredTool({
		name: 'ping',
		description: 'Ping',
		schema,
		func: async (args) => JSON.stringify(args),
	});
}

async function wrap(tools, code, schemaOverride) {
	return (await new ToolMiddleware().supplyData.call(context(tools, code, schemaOverride), 0)).response.getTools();
}

for (const [version, z] of [['v3', z3], ['v4', z4]]) {
	test(`overrides Zod ${version} schema and passes new field through chained middleware`, async () => {
		const upstream = original(z.object({ query: z.string() }).strict());
		const formatter = (await wrap([upstream], `
			const { response_format = 'json', ...args } = input;
			return JSON.stringify({ format: response_format, upstream: JSON.parse(await next(args)) });
		`, schemaCode))[0];
		const tracer = (await wrap([formatter], 'return JSON.stringify({ observed: input, result: JSON.parse(await next(input)) });'))[0];
		assert.ok(formatter.schema.shape.response_format);
		assert.equal(upstream.schema.shape.response_format, undefined);
		assert.deepEqual(JSON.parse(await tracer.invoke({ query: 'hello', response_format: 'compact' })), {
			observed: { query: 'hello', response_format: 'compact' },
			result: { format: 'compact', upstream: { query: 'hello' } },
		});
		assert.equal(JSON.parse(await formatter.invoke({ query: 'hello' })).format, 'json');
		await assert.rejects(tracer.invoke({ query: 'hello', response_format: 'yaml' }));
		await assert.rejects(tracer.invoke({ response_format: 'compact' }));
	});

	test(`example rejects collisions with existing Zod ${version} fields`, async () => {
		await assert.rejects(wrap([original(z.object({ response_format: z.string() }))], 'return next(input);', schemaCode),
			/response_format already exists/);
	});
}

test('overrides a JSON Schema without mutating the original', async () => {
	const schema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] };
	const override = `return { ...schema, properties: { ...schema.properties, response_format: { type: 'string', enum: ['json', 'compact'] } } };`;
	const wrapped = (await wrap([original(schema)], 'return input;', override))[0];
	assert.deepEqual(wrapped.schema.properties.response_format.enum, ['json', 'compact']);
	assert.equal(schema.properties.response_format, undefined);
	assert.deepEqual(wrapped.schema.required, ['query']);
});

test('supports asynchronous per-tool schema overrides with context', async () => {
	const override = `if (tool.name !== 'ping' || context.executionId !== 'test') throw new Error('wrong context');
		await Promise.resolve(); return schema.extend({ extra: z.string().optional() });`;
	const wrapped = (await wrap([original(z3.object({}))], 'return input;', override))[0];
	assert.deepEqual(await wrapped.invoke({ extra: 'hello' }), { extra: 'hello' });
});

test('schema override errors, invalid returns and reserved fields fail registration', async () => {
	const upstream = original(z3.object({}));
	for (const code of ['throw new Error("bad schema");', 'return null;', 'return 42;',
		'return schema.extend({ _n8nOriginalToolArg: z.string() });']) {
		await assert.rejects(wrap([upstream], 'return next(input);', code), /Schema override failed for tool "ping"/);
	}
});

test('n8n MCP schema conversion exposes the new Zod v3 field through both layers', async () => {
	const inner = (await wrap([original(z3.object({ query: z3.string() }))], 'return next(input);', schemaCode))[0];
	const outer = (await wrap([inner], 'return next(input);'))[0];
	const schema = zodToJsonSchema(outer.schema, { removeAdditionalStrategy: 'strict' });
	assert.deepEqual(schema.properties.response_format.enum, ['json', 'compact']);
	assert.equal(schema.properties.response_format.description, 'Response format');
	assert.deepEqual(schema.required, ['query']);
});

const renameAndExtend = `
	if (Object.hasOwn(tool.schema.shape, 'response_format')) throw new Error('response_format already exists');
	return {
		...tool,
		name: tool.name.replace(/^DataHub_MCP_Client_/, ''),
		description: 'Renamed ping',
		schema: tool.schema.extend({ response_format: z.enum(['json', 'compact']).optional() }),
		metadata: { ...tool.metadata, custom: 'preserved', isFromToolkit: false, isMcpTool: false },
		func: async () => 'must not replace original',
	};
`;

test('tool object override renames and extends a tool without changing its implementation', async () => {
	const upstream = original(z3.object({ query: z3.string() }).strict());
	upstream.name = 'DataHub_MCP_Client_ping';
	const formatter = (await wrap([upstream], `
		const { response_format, ...args } = input;
		return JSON.stringify({ name: tool.name, response_format, result: JSON.parse(await next(args)) });
	`, renameAndExtend))[0];
	const outer = (await wrap([formatter], 'return await next(input);'))[0];
	assert.equal(outer.name, 'ping');
	assert.equal(outer.description, 'Renamed ping');
	assert.equal(formatter.metadata.custom, 'preserved');
	assert.equal(formatter.metadata.isFromToolkit, true);
	assert.equal(formatter.metadata.isMcpTool, true);
	assert.equal(upstream.name, 'DataHub_MCP_Client_ping');
	assert.equal(upstream.schema.shape.response_format, undefined);
	assert.deepEqual(JSON.parse(await outer.invoke({ query: 'hello', response_format: 'compact' })), {
		name: 'ping', response_format: 'compact', result: { query: 'hello' },
	});
});

test('Agent toolkit execute resolves exposed names back to the correct original', async () => {
	const upstream = original(z3.object({ query: z3.string() }).strict());
	upstream.name = 'DataHub_MCP_Client_ping';
	const node = new ToolMiddleware();
	const ctx = context([upstream], `
		const { response_format, ...args } = input;
		return { visibleName: tool.name, response_format, result: JSON.parse(await next(args)) };
	`, renameAndExtend);
	ctx.getInputData = () => [{ json: { tool: 'ping', toolCallId: 'call-1', query: 'hello', response_format: 'compact' } }];
	const result = await node.execute.call(ctx);
	assert.deepEqual(result[0][0].json.response, {
		visibleName: 'ping', response_format: 'compact', result: { query: 'hello' },
	});
	ctx.getInputData = () => [{ json: { tool: 'DataHub_MCP_Client_ping', query: 'hello' } }];
	await assert.rejects(node.execute.call(ctx), /Tool not found/);
});

test('renamed tool collisions are rejected in registration and toolkit execution', async () => {
	const first = original(z3.object({}));
	first.name = 'DataHub_MCP_Client_ping';
	const second = original(z3.object({}));
	second.name = 'Other_ping';
	const rename = 'return { ...tool, name: "ping" };';
	await assert.rejects(wrap([first, second], 'return next(input);', rename), /Duplicate tool name after override: ping/);
	const ctx = context([first, second], 'return next(input);', rename);
	ctx.getInputData = () => [{ json: { tool: 'ping' } }];
	await assert.rejects(new ToolMiddleware().execute.call(ctx), /Duplicate tool name after override: ping/);
});

test('renamed Agent tool restores user arguments reserved for toolkit routing', async () => {
	const upstream = original(z3.object({
		tool: z3.string(),
		toolCallId: z3.string(),
	}).strict());
	upstream.name = 'DataHub_MCP_Client_ping';
	const ctx = context([upstream], 'return await next(input);',
		'return { ...tool, name: tool.name.replace(/^DataHub_MCP_Client_/, "") };');
	ctx.getInputData = () => [{ json: {
		tool: 'ping',
		toolCallId: 'internal',
		_n8nOriginalToolArg: { tool: 'user-tool', toolCallId: 'user-call' },
	} }];
	const result = await new ToolMiddleware().execute.call(ctx);
	assert.deepEqual(JSON.parse(result[0][0].json.response), { tool: 'user-tool', toolCallId: 'user-call' });
});

test('invalid tool overrides fail closed', async () => {
	const upstream = original(z3.object({}));
	for (const code of [
		'return { ...tool, name: "" };',
		'return { ...tool, name: "invalid name" };',
		'return { ...tool, description: 3 };',
		'return { ...tool, schema: null };',
		'return { ...tool, metadata: "bad" };',
		'return { ...tool, metadata: { gatedToolNodeName: "Approval" } };',
		'return { ...tool, schema: schema.extend({ _n8nOriginalToolArg: z.string() }) };',
	]) {
		await assert.rejects(wrap([upstream], 'return next(input);', code), /Schema override failed/);
	}
});
