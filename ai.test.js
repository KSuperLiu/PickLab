import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { aiConfig, publicAiConfig, resolveAiKey, liteLLMModels, reviewCommit } from './ai.js';

test('LiteLLM 配置只返回非敏感字段，并通过虚拟 Key 读取模型与分析提交', async () => {
  let prompt = '';
  const gateway = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-virtual-key');
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'team-model' }] })); return; }
    if (req.url === '/v1/chat/completions') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); prompt = body.messages.map(x => x.content).join('\n');
      assert.equal(body.model, 'team-model');
      res.end(JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: 'team-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '改动概述：增加测试。' } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const config = aiConfig({ provider: 'litellm', apiKey: 'test-virtual-key', model: 'team-model', baseURL: `http://127.0.0.1:${gateway.address().port}` });
    assert.equal(publicAiConfig(config).apiKey, undefined);
    assert.deepEqual(await liteLLMModels(config), ['team-model']);
    const result = await reviewCommit(config, 'test commit', 'a'.repeat(40), [{ header: 'diff --git a/a.js b/a.js', hunks: [{ text: '@@ -1 +1 @@\n-old\n+new' }] }]);
    assert.match(result.text, /增加测试/);
    assert.match(prompt, /\+new/);
    assert.equal(result.truncated, false);
  } finally { await new Promise(resolve => gateway.close(resolve)); }
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
