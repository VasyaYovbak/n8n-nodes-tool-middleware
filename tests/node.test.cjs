'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const Module = require('node:module');

class DynamicStructuredTool {
	constructor(options) { Object.assign(this, options); }
	async invoke(input) { return await this.func(input); }
}
class BaseToolkit {}
class NodeOperationError extends Error {
	constructor(_node, message) { super(message); }
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === '@langchain/core/tools') return { DynamicStructuredTool, BaseToolkit };
	if (request === 'n8n-workflow') return { NodeConnectionTypes: { AiTool: 'ai_tool' }, NodeOperationError };
	return originalLoad.call(this, request, parent, isMain);
};
const { ToolMiddleware } = require('../nodes/ToolMiddleware/ToolMiddleware.node');
Module._load = originalLoad;

function context(tools, code, input = []) {
	return {
		getInputConnectionData: async () => tools,
		getNodeParameter: (name, _itemIndex, fallback) => name === 'code' ? code : fallback,
		getNode: () => ({ name: 'Middleware' }),
		getExecutionId: () => 'test-execution',
		getInputData: () => input,
		logger: { info() {} },
	};
}

function tool(name) {
	return {
		name,
		description: `Test ${name}`,
		schema: { type: 'object' },
		invoke: async (input) => ({ name, input }),
	};
}

test('supplyData wraps multiple tools, preserves schemas and executes code lazily', async () => {
	const first = tool('first');
	const second = tool('second');
	const node = new ToolMiddleware();
	const code = 'const r = await next({ ...input, changed: true }); return { ...r, execution: context.executionId };';
	const result = await node.supplyData.call(context([first, second], code), 0);
	const tools = result.response.getTools();
	assert.equal(tools.length, 2);
	assert.equal(tools[0].schema, first.schema);
	assert.equal(tools[1].metadata.isFromToolkit, true);
	assert.deepEqual(await tools[1].invoke({ x: 1 }), {
		name: 'second',
		input: { x: 1, changed: true },
		execution: 'test-execution',
	});
});

test('execute routes v3 toolkit calls through middleware and restores reserved arguments', async () => {
	const node = new ToolMiddleware();
	const code = 'return await next(input);';
	const input = [{ json: {
		tool: 'second',
		toolCallId: 'internal-call-id',
		value: 42,
		_n8nOriginalToolArg: { tool: 'user-tool', toolCallId: 'user-id' },
	} }];
	const result = await node.execute.call(context([tool('first'), tool('second')], code, input));
	assert.deepEqual(result[0][0].json.response, {
		name: 'second',
		input: { value: 42, tool: 'user-tool', toolCallId: 'user-id' },
	});
});

test('nested toolkits work and duplicate names fail explicitly', async () => {
	const node = new ToolMiddleware();
	const first = tool('same');
	const toolkit = { getTools: () => [first, tool('same')] };
	await assert.rejects(node.supplyData.call(context([toolkit], 'return next(input);'), 0), /Duplicate tool name/);
});

test('tool errors propagate to the caller', async () => {
	const failing = { ...tool('bad'), invoke: async () => { throw new Error('tool failed'); } };
	const node = new ToolMiddleware();
	const result = await node.supplyData.call(context([failing], 'return await next(input);'), 0);
	await assert.rejects(result.response.getTools()[0].invoke({}), /tool failed/);
});

test('exposes the current request and native context without changing tool arguments', async () => {
	const node = new ToolMiddleware();
	const code = 'return { userId: context.request?.headers?.["x-user-id"] ?? context.request?.headers?.["X-User-ID"], keys: Object.keys(context), header: context.request.headers.authorization, node: context.n8n.getNode().name, result: await next(input) };';
	const firstContext = context([tool('ping')], code);
	firstContext.additionalData = { httpRequest: {
		headers: { 'x-user-id': '  user-one  ', authorization: 'secret' },
		rawHeaders: ['X-User-Id', '  user-one  ', 'Authorization', 'secret'],
	} };
	const secondContext = context([tool('ping')], code);
	secondContext.additionalData = { httpRequest: {
		headers: { 'X-User-ID': 'user-two' },
		rawHeaders: ['X-User-ID', 'user-two'],
	} };
	const firstTool = (await node.supplyData.call(firstContext, 0)).response.getTools()[0];
	const secondTool = (await node.supplyData.call(secondContext, 0)).response.getTools()[0];
	const [first, second] = await Promise.all([firstTool.invoke({}), secondTool.invoke({})]);
	assert.deepEqual(first, {
		userId: '  user-one  ',
		keys: ['logger', 'executionId', 'request', 'n8n'],
		header: 'secret',
		node: 'Middleware',
		result: { name: 'ping', input: {} },
	});
	assert.equal(second.userId, 'user-two');
});

test('does not treat tool input as an HTTP request', async () => {
	const node = new ToolMiddleware();
	const ctx = context([tool('ping')], 'return { hasRequest: !!context.request, result: await next(input) };');
	const wrapped = (await node.supplyData.call(ctx, 0)).response.getTools()[0];
	const result = await wrapped.invoke({ user_id: 'forged' });
	assert.equal(result.hasRequest, false);
	assert.deepEqual(result.result.input, { user_id: 'forged' });
});

test('execute passes the request to middleware for toolkit routing', async () => {
	const node = new ToolMiddleware();
	const ctx = context([tool('ping')], 'return { userId: context.request?.headers?.["x-user-id"], result: await next(input) };', [
		{ json: { tool: 'ping' } },
	]);
	ctx.additionalData = { httpRequest: { headers: { 'x-user-id': 'user-execute' } } };
	const result = await node.execute.call(ctx);
	assert.equal(result[0][0].json.response.userId, 'user-execute');
});

test('human-review tools are rejected rather than bypassing approval', async () => {
	const gated = { ...tool('gated'), metadata: { gatedToolNodeName: 'Approval' } };
	const node = new ToolMiddleware();
	await assert.rejects(node.supplyData.call(context([gated], 'return next(input);'), 0), /Human review/);
});

test('n8n internal routing argument cannot be used as a tool parameter', async () => {
	const bad = { ...tool('bad'), schema: { properties: { _n8nOriginalToolArg: {} } } };
	const node = new ToolMiddleware();
	await assert.rejects(node.supplyData.call(context([bad], 'return next(input);'), 0), /reserved/);
});
