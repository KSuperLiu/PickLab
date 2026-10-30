import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MockLanguageModelV3 } from 'ai/test';
import { aiConfig, publicAiConfig, resolveAiKey, liteLLMModels } from './ai.js';
import { runAgent } from './agent.js';

test('LiteLLM 配置只返回非敏感字段，并通过虚拟 Key 读取模型', async () => {
  const gateway = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-virtual-key');
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'team-model' }] })); return; }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const config = aiConfig({ provider: 'litellm', apiKey: 'test-virtual-key', model: 'team-model', baseURL: `http://127.0.0.1:${gateway.address().port}` });
    assert.equal(publicAiConfig(config).apiKey, undefined);
    assert.deepEqual(await liteLLMModels(config), ['team-model']);
  } finally { await new Promise(resolve => gateway.close(resolve)); }
});

test('Agent 依次调用分支、提交查询、准备遴选工具，不自行写入分支', async () => {
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const toolCall = (name, input, index) => ({ content: [{ type: 'tool-call', toolCallId: `call-${index}`, toolName: name, input: JSON.stringify(input) }], finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] });
  const args = { source: 'master', target: 'release', author: 'alice' };
  const model = new MockLanguageModelV3({ doGenerate: [
    toolCall('list_branches', {}, 1),
    toolCall('find_commits', args, 2),
    toolCall('prepare_cherry_pick', args, 3),
    { content: [{ type: 'text', text: '已准备清单，请核对后确认。' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }
  ] });
  const calls = [];
  const result = await runAgent({}, [{ role: 'user', content: '把 alice 在 master 的提交遴选到 release' }], {
    listBranches: () => { calls.push('branches'); return { branches: ['master', 'release'] }; },
    findCommits: input => { calls.push('find'); assert.deepEqual(input, args); return { commits: [{ id: 'a'.repeat(40) }] }; },
    prepare: input => { calls.push('prepare'); assert.deepEqual(input, args); return { proposal: { id: 'proposal-1' } }; }
  }, { model });
  assert.deepEqual(calls, ['branches', 'find', 'prepare']);
  assert.deepEqual(result.toolsUsed, ['list_branches', 'find_commits', 'prepare_cherry_pick']);
  assert.match(result.text, /核对后确认/);
});

test('拒绝无效的 LiteLLM 地址与缺失的 Key', () => {
  assert.throws(() => aiConfig({ provider: 'litellm', apiKey: '', model: 'x' }), /AI Key/);
  assert.throws(() => aiConfig({ provider: 'litellm', apiKey: 'x', model: 'x', baseURL: 'file:///etc/passwd' }), /LiteLLM 地址/);
});

test('环境变量模式不在会话配置或接口响应中保存 Key', () => {
  const input = { provider: 'litellm', keySource: 'env', apiKey: 'ignored-browser-key', model: 'team-model', baseURL: 'http://127.0.0.1:4000' };
  assert.throws(() => aiConfig(input, {}), /LITELLM_API_KEY/);
  const config = aiConfig(input, { LITELLM_API_KEY: 'server-only-key' });
  assert.equal(config.apiKey, '');
  assert.equal(config.keySource, 'env');
  assert.equal(resolveAiKey(config, { LITELLM_API_KEY: 'server-only-key' }), 'server-only-key');
  assert.doesNotMatch(JSON.stringify(publicAiConfig(config)), /server-only-key|ignored-browser-key/);
  assert.throws(() => aiConfig({ ...input, provider: 'openrouter' }, { LITELLM_API_KEY: 'x' }), /仅适用于 LiteLLM/);
});
