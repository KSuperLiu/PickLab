import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

const sha = character => character.repeat(40);
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));
async function freePort() { const server = http.createServer(); const port = await listen(server); await close(server); return port; }
async function ready(base) { for (let i = 0; i < 40; i++) { try { if ((await fetch(base)).ok) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('PickLab 测试服务未启动'); }

test('对话工具按作者、标题、内容和 SHA 准备清单，确认后才写目标分支', { timeout: 20000 }, async () => {
  let targetHead = sha('a'), modelCalls = 0, cherryCalls = 0, diffCalls = 0;
  const gitlab = http.createServer(async (req, res) => {
    const route = decodeURIComponent(req.url.split('?')[0]);
    res.setHeader('content-type', 'application/json');
    if (req.headers['private-token'] !== 'gitlab-test-key') { res.statusCode = 401; res.end('{}'); return; }
    if (route === '/api/v4/user') res.end(JSON.stringify({ id: 7, username: 'tester', name: 'Tester' }));
    else if (route === '/api/v4/projects/test/repo/repository/branches') res.end(JSON.stringify([{ name: 'master' }, { name: 'release' }]));
    else if (route === '/api/v4/projects/test/repo/repository/branches/release') res.end(JSON.stringify({ commit: { id: targetHead }, can_push: true, protected: false }));
    else if (route === '/api/v4/projects/test/repo/repository/commits') res.end(JSON.stringify([
      { id: sha('b'), short_id: 'bbbbbbbb', title: 'fix: login', message: 'fix: login', author_name: 'liuhouchao', author_email: 'liuhouchao@example.com', created_at: '2026-10-29T01:00:00Z' },
      { id: sha('d'), short_id: 'dddddddd', title: 'other change', message: 'other change', author_name: 'someone', author_email: 'other@example.com', created_at: '2026-10-29T02:00:00Z' }
    ]));
    else if (route === `/api/v4/projects/test/repo/repository/commits/${sha('b')}/diff`) { diffCalls++; res.end(JSON.stringify([{ old_path: 'login.js', new_path: 'login.js', diff: '@@ -1 +1 @@\n-old\n+target_word\n' }])); }
    else if (route === `/api/v4/projects/test/repo/repository/commits/${sha('b')}/cherry_pick` && req.method === 'POST') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const input = JSON.parse(raw); cherryCalls++;
      if (input.dry_run) res.end(JSON.stringify({ dry_run: 'success' }));
      else { targetHead = sha('c'); res.statusCode = 201; res.end(JSON.stringify({ id: targetHead, web_url: `http://127.0.0.1:${gitlab.address().port}/commit/${targetHead}` })); }
    } else { res.statusCode = 404; res.end('{}'); }
  });
  const gitlabPort = await listen(gitlab);
  const gateway = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer ai-test-key');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(body.model, 'tool-model');
    assert.ok(body.tools.some(x => x.function.name === 'prepare_cherry_pick'));
    const scenario = Math.floor(modelCalls / 4), step = modelCalls % 4;
    modelCalls++;
    const args = scenario === 0 ? { source: 'master', target: 'release', author: 'liuhouchao' } : { source: 'master', target: 'release', title: 'fix', content: 'target_word', sha: 'bbbbbbb' };
    const name = ['list_branches', 'find_commits', 'prepare_cherry_pick'][step];
    const message = step === 3 ? { role: 'assistant', content: '已准备清单，请核对。' } : { role: 'assistant', content: null, tool_calls: [{ id: `call-${modelCalls}`, type: 'function', function: { name, arguments: JSON.stringify(step === 0 ? {} : args) } }] };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: `chat-${modelCalls}`, object: 'chat.completion', created: 1, model: 'tool-model', choices: [{ index: 0, message, finish_reason: step === 3 ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
  });
  const gatewayPort = await listen(gateway), appPort = await freePort();
  const base = `http://127.0.0.1:${appPort}`, gitlabBase = `http://127.0.0.1:${gitlabPort}`;
  const child = spawn(process.execPath, ['server.js'], { cwd: new URL('.', import.meta.url), env: { ...process.env, PORT: String(appPort), GITLAB_BASE_URL: '', GITLAB_OAUTH_CLIENT_ID: '' }, stdio: 'ignore' });
  try {
    await ready(base);
    const post = (route, data, headers = {}) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) });
    let response = await post('/api/auth/pat-login', { url: gitlabBase, token: 'gitlab-test-key', allowInsecure: true });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    response = await post('/api/connect', { url: `${gitlabBase}/test/repo.git` }, { cookie });
    assert.equal(response.status, 200);
    const sessionId = (await response.json()).id;
    const headers = { cookie, 'x-session-id': sessionId };
    response = await post('/api/ai/config', { provider: 'litellm', apiKey: 'ai-test-key', model: 'tool-model', baseURL: `http://127.0.0.1:${gatewayPort}` }, headers);
    assert.equal(response.status, 200);
    response = await post('/api/agent/chat', { message: '把 liuhouchao 在 master 的提交遴选到 release' }, headers);
    assert.equal(response.status, 200);
    const first = await response.json();
    assert.deepEqual(first.toolsUsed, ['list_branches', 'find_commits', 'prepare_cherry_pick']);
    assert.equal(first.proposal.commits.length, 1);
    assert.equal(first.proposal.commits[0].id, sha('b'));
    assert.equal(cherryCalls, 0);
    response = await post('/api/agent/confirm', { proposalId: 'wrong' }, headers);
    assert.equal(response.status, 400);
    assert.equal(cherryCalls, 0);
    response = await post('/api/agent/confirm', { proposalId: first.proposal.id }, headers);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).completed.length, 1);
    assert.equal(cherryCalls, 2);
    response = await post('/api/agent/confirm', { proposalId: first.proposal.id }, headers);
    assert.equal(response.status, 400);
    response = await post('/api/agent/chat', { message: '把 master 中标题含 fix 且内容含 target_word、SHA 以 bbbbbbb 开头的提交遴选到 release' }, headers);
    assert.equal(response.status, 200);
    const second = await response.json();
    assert.equal(second.proposal.commits.length, 1);
    assert.ok(diffCalls > 0);
    assert.equal(cherryCalls, 2);
    targetHead = sha('e');
    response = await post('/api/agent/confirm', { proposalId: second.proposal.id }, headers);
    assert.equal(response.status, 400);
    assert.equal(cherryCalls, 2);
  } finally { child.kill(); await close(gitlab); await close(gateway); }
});
