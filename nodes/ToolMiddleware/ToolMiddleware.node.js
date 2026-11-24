'use strict';

const { DynamicStructuredTool, BaseToolkit } = require('@langchain/core/tools');
const { NodeConnectionTypes, NodeOperationError } = require('n8n-workflow');
const zod3 = require('zod/v3');
const zod4 = require('zod/v4');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const DEFAULT_CODE = `// tool: { name, description }, input: tool arguments
// next(input) invokes the original tool. Return the result for the agent.
return await next(input);`;
const DEFAULT_SCHEMA_CODE = `// Runs during tool registration, before middleware is called.
// Return the schema unchanged, or return a modified copy.
return schema;`;

function flattenTools(value) {
	if (value == null) return [];
	if (Array.isArray(value)) return value.flatMap(flattenTools);
	if (typeof value.getTools === 'function') return value.getTools().flatMap(flattenTools);
	if (Array.isArray(value.tools)) return value.tools.flatMap(flattenTools);
	return [value];
}

async function connectedTools(context, itemIndex) {
	const data = await context.getInputConnectionData(NodeConnectionTypes.AiTool, itemIndex);
	const tools = flattenTools(data);
	const names = new Set();
	for (const tool of tools) {
		if (!tool || typeof tool.name !== 'string' || typeof tool.invoke !== 'function' || !tool.schema) {
			throw new NodeOperationError(context.getNode(), 'A connected input is not a supported AI tool');
		}
		if (tool.metadata?.gatedToolNodeName) {
			throw new NodeOperationError(context.getNode(), 'Human review tools are not supported by this prototype');
		}
		const fields = tool.schema.shape || tool.schema.properties;
		if (fields && Object.hasOwn(fields, '_n8nOriginalToolArg')) {
			throw new NodeOperationError(context.getNode(), 'The _n8nOriginalToolArg tool parameter is reserved by n8n');
		}
		if (names.has(tool.name)) {
			throw new NodeOperationError(context.getNode(), `Duplicate tool name: ${tool.name}`);
		}
		names.add(tool.name);
	}
	if (!tools.length) throw new NodeOperationError(context.getNode(), 'Connect at least one AI tool');
	return tools;
}

function runMiddleware(code, tool, input, context, exposed = tool) {
	const fn = new AsyncFunction('tool', 'input', 'next', 'context', code);
	return fn(
		{ name: exposed.name, description: exposed.description },
		input,
		(args = input) => tool.invoke(args),
		{
			logger: context.logger,
			executionId: context.getExecutionId(),
			request: context.additionalData?.httpRequest,
			n8n: context,
		},
	);
}

async function overrideTool(context, tool, code) {
	const original = { name: tool.name, description: tool.description, schema: tool.schema };
	if (!code || code === DEFAULT_SCHEMA_CODE) return original;
	try {
		const fn = new AsyncFunction('schema', 'tool', 'z', 'context', code);
		const result = await fn(
			tool.schema,
			{ ...tool, ...original, metadata: tool.metadata ? { ...tool.metadata } : undefined },
			tool.schema._zod ? zod4 : zod3,
			{ n8n: context, logger: context.logger, executionId: context.getExecutionId() },
		);
		if (!result || typeof result !== 'object' || Array.isArray(result)) {
			throw new Error('Schema override must return a schema or tool object');
		}
		const isTool = Object.hasOwn(result, 'schema') &&
			(Object.hasOwn(result, 'name') || Object.hasOwn(result, 'description'));
		const exposed = isTool ? {
			name: result.name,
			description: result.description,
			schema: result.schema,
			metadata: result.metadata,
		} : { ...original, schema: result };
		if (typeof exposed.name !== 'string' || !exposed.name.trim()) {
			throw new Error('Tool name must be a non-empty string');
		}
		if (exposed.name !== tool.name && !/^[A-Za-z0-9_.-]{1,128}$/.test(exposed.name)) {
			throw new Error('Renamed tool must use 1–128 letters, numbers, underscores, hyphens or dots');
		}
		if (exposed.description !== undefined && typeof exposed.description !== 'string') {
			throw new Error('Tool description must be a string');
		}
		if (!exposed.schema || typeof exposed.schema !== 'object' || Array.isArray(exposed.schema)) {
			throw new Error('Tool schema must be an object');
		}
		if (exposed.metadata !== undefined && (!exposed.metadata || typeof exposed.metadata !== 'object' || Array.isArray(exposed.metadata))) {
			throw new Error('Tool metadata must be an object');
		}
		if (exposed.metadata?.gatedToolNodeName) {
			throw new Error('Human review tools are not supported by this prototype');
		}
		const fields = exposed.schema.shape || exposed.schema.properties;
		if (fields && Object.hasOwn(fields, '_n8nOriginalToolArg')) {
			throw new Error('The _n8nOriginalToolArg tool parameter is reserved by n8n');
		}
		return exposed;
	} catch (error) {
		throw new NodeOperationError(context.getNode(), `Schema override failed for tool "${tool.name}": ${error.message}`);
	}
}

async function configuredTools(context, tools, code) {
	const configured = [];
	const names = new Set();
	for (const original of tools) {
		const exposed = await overrideTool(context, original, code);
		if (names.has(exposed.name)) {
			throw new NodeOperationError(context.getNode(), `Duplicate tool name after override: ${exposed.name}`);
		}
		names.add(exposed.name);
		configured.push({ original, exposed });
	}
	return configured;
}

class ToolMiddleware {
	description = {
		displayName: 'Tool Middleware',
		name: 'toolMiddleware',
		icon: 'fa:code',
		group: ['transform'],
		version: 1,
		description: 'Wrap connected AI tools with trusted JavaScript',
		defaults: { name: 'Tool Middleware' },
		inputs: [{ type: NodeConnectionTypes.AiTool, displayName: 'Tools', required: true }],
		outputs: [NodeConnectionTypes.AiTool],
		outputNames: ['Tools'],
		properties: [
			{
				displayName: 'Trusted Code Only',
				name: 'securityNotice',
				type: 'notice',
				default: '',
				description: 'Code runs without a sandbox in the n8n process. Only trusted workflow authors should use this node.',
			},
			{
				displayName: 'Schema Override JavaScript',
				name: 'schemaCode',
				type: 'string',
				typeOptions: { editor: 'jsEditor', rows: 8 },
				noDataExpression: true,
				default: DEFAULT_SCHEMA_CODE,
				description: 'Return a schema or tool object; runs during registration and toolkit routing',
			},
			{
				displayName: 'JavaScript',
				name: 'code',
				type: 'string',
				typeOptions: { editor: 'jsEditor', rows: 12 },
				noDataExpression: true,
				default: DEFAULT_CODE,
				description: 'Wrap each tool invocation using tool, input, next, and context',
			},
		],
	};

	async supplyData(itemIndex) {
		const tools = await connectedTools(this, itemIndex);
		const code = this.getNodeParameter('code', itemIndex, DEFAULT_CODE);
		const schemaCode = this.getNodeParameter('schemaCode', itemIndex, DEFAULT_SCHEMA_CODE);
		const context = this;
		const configured = await configuredTools(this, tools, schemaCode);
		const wrapped = configured.map(({ original, exposed }) => new DynamicStructuredTool({
			name: exposed.name,
			description: exposed.description,
			schema: exposed.schema,
			metadata: {
				...exposed.metadata,
				// Agent v3 routes toolkit members through this node's execute().
				isFromToolkit: true,
				// The engine preserves the user's "tool" and "toolCallId" arguments.
				isMcpTool: true,
			},
			func: async (input) => await runMiddleware(code, original, input, context, exposed),
		}));
		const toolkit = new BaseToolkit();
		toolkit.tools = wrapped;
		toolkit.getTools = () => wrapped;
		return { response: toolkit };
	}

	async execute() {
		const items = this.getInputData();
		const output = [];
		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			const item = items[itemIndex].json;
			const name = item.tool;
			const input = { ...item };
			delete input.tool;
			delete input.toolCallId;
			const stashed = input._n8nOriginalToolArg;
			delete input._n8nOriginalToolArg;
			if (stashed && typeof stashed === 'object' && !Array.isArray(stashed)) {
				if (Object.hasOwn(stashed, 'tool')) input.tool = stashed.tool;
				if (Object.hasOwn(stashed, 'toolCallId')) input.toolCallId = stashed.toolCallId;
			}
			const tools = await connectedTools(this, itemIndex);
			const schemaCode = this.getNodeParameter('schemaCode', itemIndex, DEFAULT_SCHEMA_CODE);
			const configured = await configuredTools(this, tools, schemaCode);
			const tool = configured.find((candidate) => candidate.exposed.name === name);
			if (!tool) throw new NodeOperationError(this.getNode(), `Tool not found: ${String(name)}`);
			const code = this.getNodeParameter('code', itemIndex, DEFAULT_CODE);
			const result = await runMiddleware(code, tool.original, input, this, tool.exposed);
			output.push({ json: { response: result }, pairedItem: { item: itemIndex } });
		}
		return [output];
	}
}

module.exports = { ToolMiddleware };
