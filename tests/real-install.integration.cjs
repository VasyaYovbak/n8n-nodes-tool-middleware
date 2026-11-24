'use strict';

// Run inside an n8n 3.2.2 container after installing the packed package.
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { DynamicStructuredTool } = require('@langchain/core/tools');
const { z } = require('zod');
const coreDir = path.dirname(require.resolve('n8n-core'));
const { PackageDirectoryLoader } = require(path.join(coreDir, 'nodes-loader/package-directory-loader'));
const { StructuredToolkit } = require(path.join(coreDir, 'execution-engine/node-execution-context/utils/ai-tool-types'));
const { extendResponseMetadata } = require(path.join(coreDir, 'execution-engine/node-execution-context/utils/get-input-connection-data'));
const langchainDir = path.dirname(require.resolve('@n8n/n8n-nodes-langchain/package.json'));
const { createEngineRequests } = require(path.join(langchainDir, 'dist/utils/agent-execution/createEngineRequests'));
const packageDir = process.env.TEST_INSTALLED_PACKAGE_ROOT;

test('installed community package loads and routes Agent v3 toolkit calls', { skip: !packageDir }, async () => {
	const loader = new PackageDirectoryLoader(packageDir);
	await loader.loadAll();
	assert.equal(loader.packageName, 'n8n-nodes-tool-middleware');
	assert.ok(loader.known.nodes.toolMiddleware);
	const { ToolMiddleware } = require(path.join(packageDir, 'nodes/ToolMiddleware/ToolMiddleware.node.js'));
	const originals = [
		new DynamicStructuredTool({
			name: 'calculator',
			description: 'Calculate',
			schema: z.object({ input: z.string(), tool: z.string().optional() }),
			func: async (input) => `original:${input.input}:${input.tool ?? ''}`,
		}),
		new DynamicStructuredTool({
			name: 'echo',
			description: 'Echo',
			schema: z.object({ text: z.string() }),
			func: async (input) => input.text,
		}),
	];
	const context = {
		getInputConnectionData: async () => originals,
		getNodeParameter: (name, _itemIndex, fallback) => name === 'code' ? 'return "wrapped:" + await next(input);' : fallback,
		getNode: () => ({ name: 'Tool Middleware' }),
		getExecutionId: () => 'test',
		logger: { info() {} },
	};
	const node = new ToolMiddleware();
	const { response } = await node.supplyData.call(context, 0);
	assert.ok(response instanceof StructuredToolkit);
	extendResponseMetadata(response, { name: 'Tool Middleware' });
	const tools = response.getTools();
	assert.equal(await tools[1].invoke({ text: 'hello' }), 'wrapped:hello');
	const actions = createEngineRequests(
		[{ tool: 'calculator', toolInput: { input: '2+3', tool: 'customer-value' }, toolCallId: 'call-1' }],
		0,
		tools,
	);
	assert.equal(actions[0].nodeName, 'Tool Middleware');
	const result = await node.execute.call({ ...context, getInputData: () => [{ json: actions[0].input }] });
	assert.equal(result[0][0].json.response, 'wrapped:original:2+3:customer-value');
});

test('renamed tools route through chained middleware and Agent v3', { skip: !packageDir }, async () => {
	const { ToolMiddleware } = require(path.join(packageDir, 'nodes/ToolMiddleware/ToolMiddleware.node.js'));
	const original = new DynamicStructuredTool({
		name: 'DataHub_MCP_Client_ping',
		description: 'Original ping',
		schema: z.object({ query: z.string() }),
		func: async (input) => `original:${input.query}`,
	});
	const schemaCode = `
		return { ...tool, name: tool.name.replace(/^DataHub_MCP_Client_/, ''),
			description: 'Renamed ping',
			schema: tool.schema.extend({ response_format: z.enum(['json', 'compact']).optional() }) };
	`;
	const innerCode = `
		const { response_format, ...args } = input;
		return tool.name + ':' + response_format + ':' + await next(args);
	`;
	const makeContext = (tools, code, override) => ({
		getInputConnectionData: async () => tools,
		getNodeParameter: (name, _itemIndex, fallback) => ({ code, schemaCode: override })[name] ?? fallback,
		getNode: () => ({ name: 'Tool Middleware' }),
		getExecutionId: () => 'test',
		logger: { info() {} },
	});
	const node = new ToolMiddleware();
	const innerContext = makeContext([original], innerCode, schemaCode);
	const innerToolkit = (await node.supplyData.call(innerContext, 0)).response;
	const inner = innerToolkit.getTools()[0];
	assert.equal(inner.name, 'ping');
	assert.equal(inner.description, 'Renamed ping');
	assert.equal(await inner.invoke({ query: 'hello', response_format: 'compact' }), 'ping:compact:original:hello');

	const outerContext = makeContext([inner], 'return await next(input);');
	const outerToolkit = (await node.supplyData.call(outerContext, 0)).response;
	extendResponseMetadata(outerToolkit, { name: 'Outer Middleware' });
	const outerTools = outerToolkit.getTools();
	assert.equal(outerTools[0].name, 'ping');
	assert.ok(outerTools[0].schema.shape.response_format);
	const actions = createEngineRequests(
		[{ tool: 'ping', toolInput: { query: 'hello', response_format: 'compact' }, toolCallId: 'call-2' }],
		0,
		outerTools,
	);
	assert.equal(actions[0].nodeName, 'Outer Middleware');
	const outerResult = await node.execute.call({ ...outerContext, getInputData: () => [{ json: actions[0].input }] });
	assert.equal(outerResult[0][0].json.response, 'ping:compact:original:hello');

	extendResponseMetadata(innerToolkit, { name: 'Inner Middleware' });
	const directActions = createEngineRequests(
		[{ tool: 'ping', toolInput: { query: 'hello', response_format: 'compact' }, toolCallId: 'call-3' }],
		0,
		innerToolkit.getTools(),
	);
	const innerResult = await node.execute.call({ ...innerContext, getInputData: () => [{ json: directActions[0].input }] });
	assert.equal(innerResult[0][0].json.response, 'ping:compact:original:hello');
});
