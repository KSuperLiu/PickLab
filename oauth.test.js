import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

test('浏览器脚本可以解析', async () => {
  const html = await fs.readFile(new URL('./index.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(html, /<input id="allowHttp" type="checkbox" checked/);
});

test('GitLab 地址首次为空，成功提交后可在本机恢复', async () => {
  const html = await fs.readFile(new URL('./index.html', import.meta.url), 'utf8');
  const source = html.match(/const addressKey='picklab:lastProjectUrl';[\s\S]*?(?=const transport=)/)?.[0];
  assert.ok(source);
  const saved = new Map(), field = { value: '', placeholder: '' };
  const context = () => ({ URL, localStorage: { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value) }, $: () => field });
  vm.runInNewContext(source, context());
  assert.equal(field.value, '');
  vm.runInNewContext(`${source};cacheAddress('https://gitlab.example.com/group/project.git')`, context());
  field.value = '';
  vm.runInNewContext(source, context());
  assert.equal(field.value, 'https://gitlab.example.com/group/project.git');
  assert.equal(saved.size, 1);
});

test('来源分支优先选择 master、main，并与目标分支不同', async () => {
  const html = await fs.readFile(new URL('./index.html', import.meta.url), 'utf8');
  const source = html.match(/function optionize\(branches\)\{[\s\S]*?\n\}/)?.[0];
  assert.ok(source);
  for (const [branches, expectedTarget, expectedSource] of [
    [['staging', 'master'], 'staging', 'master'],
    [['feature', 'main'], 'feature', 'main'],
    [['feature', 'master', 'main'], 'main', 'master'],
    [['feature', 'develop'], 'feature', 'develop']
  ]) {
    const selects = { target: { append() {} }, source: { append() {} } };
    vm.runInNewContext(`${source};optionize(${JSON.stringify(branches)})`, { $: id => selects[id], document: { createElement: () => ({}) } });
    assert.equal(selects.target.value, expectedTarget);
    assert.equal(selects.source.value, expectedSource);
  }
});

function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))); }
function close(server) { return new Promise(resolve => server.close(resolve)); }
async function freePort() { const server = http.createServer(); const port = await listen(server); await close(server); return port; }
async function ready(url) { for (let i = 0; i < 40; i++) { try { const r = await fetch(url); if (r.ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); } throw new Error('测试服务未启动'); }

test('OAuth PKCE、state 校验、账号会话及退出', async () => {
  let tokenBody;
  const gitlab = http.createServer(async (req, res) => {
    if (req.url === '/oauth/token') {
      let body = ''; for await (const chunk of req) body += chunk;
      tokenBody = new URLSearchParams(body);
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ access_token: 'test-access-token', refresh_token: 'test-refresh-token', expires_in: 7200 }));
    } else if (req.url === '/api/v4/user') {
      assert.equal(req.headers.authorization, 'Bearer test-access-token');
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 42, name: '测试用户', username: 'tester' }));
    } else { res.statusCode = 404; res.end(); }
  });
  const gitlabPort = await listen(gitlab), appPort = await freePort();
  const base = `http://127.0.0.1:${appPort}`;
  const child = spawn(process.execPath, ['server.js'], { cwd: new URL('.', import.meta.url), env: { ...process.env, PORT: String(appPort), GITLAB_BASE_URL: `http://127.0.0.1:${gitlabPort}`, GITLAB_OAUTH_CLIENT_ID: 'test-client' }, stdio: 'ignore' });
  try {
    await ready(base);
    let r = await fetch(`${base}/api/auth/status`); assert.equal((await r.json()).configured, true);
    r = await fetch(`${base}/auth/login?allowHttp=1`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    const stateCookie = r.headers.get('set-cookie').split(';')[0];
    const target = new URL(r.headers.get('location'));
    assert.equal(target.searchParams.get('client_id'), 'test-client');
    assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(target.searchParams.get('scope'), 'api');
    const state = target.searchParams.get('state');
    r = await fetch(`${base}/auth/callback?state=wrong&code=abc`, { headers: { cookie: stateCookie }, redirect: 'manual' });
    assert.equal(r.status, 400);
    r = await fetch(`${base}/auth/callback?state=${state}&code=abc`, { headers: { cookie: stateCookie }, redirect: 'manual' });
    assert.equal(r.status, 302);
    const expectedChallenge = crypto.createHash('sha256').update(tokenBody.get('code_verifier')).digest('base64url');
    assert.equal(target.searchParams.get('code_challenge'), expectedChallenge);
    assert.equal(tokenBody.get('redirect_uri'), `${base}/auth/callback`);
    const sessionCookie = r.headers.get('set-cookie').match(/pl_session=[^;]+/)[0];
    r = await fetch(`${base}/api/auth/status`, { headers: { cookie: sessionCookie } });
    const status = await r.json(); assert.equal(status.authenticated, true); assert.equal(status.user.username, 'tester');
    r = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: sessionCookie } }); assert.equal(r.status, 200);
    r = await fetch(`${base}/api/auth/status`, { headers: { cookie: sessionCookie } }); assert.equal((await r.json()).authenticated, false);
  } finally { child.kill(); await close(gitlab); }
});

test('每位用户使用自己的个人令牌登录并查询自己的仓库', async () => {
  const testDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picklab-test-'));
  let targetOid = 'a'.repeat(40);
  let canPush = true, branchProtected = false;
  const cherryCalls = [];
  const seenCommitRanges = [];
  const gitlab = http.createServer(async (req, res) => {
    const token = req.headers['private-token'];
    const id = token === 'alice-token' ? 1 : token === 'bob-token' ? 2 : 0;
    const route = decodeURIComponent(req.url.split('?')[0]);
    res.setHeader('content-type', 'application/json');
    if (!id) { res.statusCode = 401; res.end('{}'); return; }
    if (req.url === '/api/v4/user') res.end(JSON.stringify({ id, name: id === 1 ? 'Alice' : 'Bob', username: id === 1 ? 'alice' : 'bob' }));
    else if (req.url.startsWith(`/api/v4/users/${id}/events?`)) res.end(JSON.stringify([{ project_id: id * 100, push_data: { ref_type: 'branch' }, created_at: '2026-10-29T00:00:00Z' }]));
    else if (req.url === `/api/v4/projects/${id * 100}`) res.end(JSON.stringify({ name_with_namespace: `${id === 1 ? 'Alice' : 'Bob'} / repo`, http_url_to_repo: `http://127.0.0.1:${gitlab.address().port}/${id}/repo.git` }));
    else if (route === `/api/v4/projects/${id}/repo/repository/branches/main`) res.end(JSON.stringify({ commit: { id: targetOid }, can_push: canPush, protected: branchProtected }));
    else if (route === `/api/v4/projects/${id}/repo/repository/branches`) res.end(JSON.stringify([{ name: 'main' }, { name: 'feature' }]));
    else if (route === `/api/v4/projects/${id}/repo/repository/commits/${'b'.repeat(40)}/refs`) res.end(JSON.stringify([{ type: 'branch', name: 'feature' }]));
    else if (route === `/api/v4/projects/${id}/repo/repository/commits/${'c'.repeat(40)}/refs`) res.end(JSON.stringify([{ type: 'branch', name: 'feature' }]));
    else if (route === `/api/v4/projects/${id}/repo/repository/commits/${'d'.repeat(40)}/refs`) res.end(JSON.stringify([{ type: 'branch', name: 'main' }]));
    else if (route === `/api/v4/projects/${id}/repo/repository/commits/${'f'.repeat(40)}/refs`) res.end(JSON.stringify([{ type: 'branch', name: 'main' }]));
    else if (route === `/api/v4/projects/${id}/repo/repository/commits/${'c'.repeat(40)}`) res.end(JSON.stringify({ id: 'c'.repeat(40), title: 'Older demo' }));
    else if (route === `/api/v4/projects/${id}/repo/repository/commits`) {
      const revision = new URL(req.url, 'http://gitlab.test').searchParams.get('ref_name');
      if (new URL(req.url, 'http://gitlab.test').searchParams.get('all') === 'true') { res.end(JSON.stringify([{ id: 'f'.repeat(40), title: 'Older demo', web_url: `http://127.0.0.1:${gitlab.address().port}/commit/${'f'.repeat(40)}` }])); return; }
      seenCommitRanges.push(revision);
      if (!['main..feature', 'feature', 'main'].includes(revision)) { res.statusCode = 400; res.end('{}'); return; }
      const first = { id: 'b'.repeat(40), short_id: 'bbbbbbbb', title: 'Change demo', created_at: '2026-10-29T00:00:00Z' };
      const list = revision === 'main' ? [{ ...first, id: 'f'.repeat(40), title: 'Older demo', web_url: `http://127.0.0.1:${gitlab.address().port}/commit/${'f'.repeat(40)}` }] : revision === 'feature' ? [first, { ...first, id: 'a'.repeat(40), title: 'Common ancestor' }] : req.url.includes('page=2') ? [{ id: 'c'.repeat(40), short_id: 'cccccccc', title: 'Older demo', created_at: '2026-10-28T00:00:00Z' }, { id: 'e'.repeat(40), short_id: 'eeeeeeee', title: 'Conflicting demo', created_at: '2026-10-27T00:00:00Z' }] : [first, ...Array.from({ length: 99 }, (_, i) => ({ ...first, id: i.toString(16).padStart(40, '0') }))];
      res.end(JSON.stringify(list));
    }
    else if (['b', 'c', 'e', 'f'].map(x => `/api/v4/projects/${id}/repo/repository/commits/${x.repeat(40)}/diff`).includes(route)) res.end(JSON.stringify([{ old_path: 'demo.txt', new_path: 'demo.txt', diff: '@@ -1 +1 @@\n-old\n+new\n', renamed_file: false, new_file: false, deleted_file: false }]));
    else if (req.method === 'POST' && ['b', 'c', 'e'].map(x => `/api/v4/projects/${id}/repo/repository/commits/${x.repeat(40)}/cherry_pick`).includes(route)) {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const input = JSON.parse(raw); cherryCalls.push(input);
      assert.equal(input.branch, 'main');
      if (route.includes(`${'c'.repeat(40)}/`)) { res.statusCode = 400; res.end(JSON.stringify({ error_code: 'empty' })); }
      else if (route.includes(`${'e'.repeat(40)}/`)) { res.statusCode = 400; res.end(JSON.stringify({ error_code: 'conflict' })); }
      else if (input.dry_run) res.end(JSON.stringify({ dry_run: 'success' }));
      else { res.statusCode = 201; targetOid = 'd'.repeat(40); res.end(JSON.stringify({ id: targetOid, web_url: `http://127.0.0.1:${gitlab.address().port}/commit/${targetOid}` })); }
    }
    else { res.statusCode = 404; res.end('{}'); }
  });
  const gitlabPort = await listen(gitlab), appPort = await freePort();
  const base = `http://127.0.0.1:${appPort}`, gitlabUrl = `http://127.0.0.1:${gitlabPort}/`;
  const child = spawn(process.execPath, ['server.js'], { cwd: new URL('.', import.meta.url), env: { ...process.env, PORT: String(appPort), GITLAB_BASE_URL: '', GITLAB_OAUTH_CLIENT_ID: '', PICKLAB_DATA_DIR: testDataDir, LITELLM_API_KEY: 'server-only-key' }, stdio: 'ignore' });
  try {
    await ready(base);
    const noHttpConfirm = await fetch(`${base}/api/recent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: gitlabUrl, token: 'alice-token', allowInsecure: false }) });
    assert.match((await noHttpConfirm.json()).error, /确认 HTTP 传输风险/);
    const noProject = await fetch(`${base}/api/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: gitlabUrl, token: 'alice-token', allowInsecure: true }) });
    assert.match((await noProject.json()).error, /查询我的最近仓库/);
    const noLogin = await fetch(`${base}/api/recent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: gitlabUrl, token: 'alice-token', allowInsecure: true }) });
    assert.match((await noLogin.json()).error, /请先使用你自己的个人令牌登录/);
    const invalid = await fetch(`${base}/api/auth/pat-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: gitlabUrl, token: 'invalid-token', allowInsecure: true }) });
    assert.equal(invalid.status, 400);
    const invalidMessage = (await invalid.json()).error;
    assert.match(invalidMessage, /令牌未被接受/);
    assert.doesNotMatch(invalidMessage, /invalid-token/);
    const chineseName = await fetch(`${base}/api/auth/pat-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: gitlabUrl, token: 'PickLab 即时仓库查询', allowInsecure: true }) });
    assert.equal(chineseName.status, 400);
    assert.match((await chineseName.json()).error, /请勿填写中文令牌名称/);
    const results = [];
    for (const token of ['alice-token', 'bob-token']) {
      let r = await fetch(`${base}/api/auth/pat-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: gitlabUrl, token, allowInsecure: true }) });
      assert.equal(r.status, 200);
      const cookie = r.headers.get('set-cookie').split(';')[0];
      r = await fetch(`${base}/api/recent`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ url: gitlabUrl, allowInsecure: false }) });
      assert.equal(r.status, 200);
      results.push({ cookie, project: (await r.json()).projects[0].name });
    }
    assert.equal(results[0].project, 'Alice / repo');
    assert.equal(results[1].project, 'Bob / repo');
    assert.notEqual(results[0].cookie, results[1].cookie);
    let r = await fetch(`${base}/api/connect`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: results[0].cookie }, body: JSON.stringify({ url: `${gitlabUrl}1/repo.git` }) });
    assert.equal(r.status, 200);
    const connected = await r.json(); assert.deepEqual(connected.branches, ['main', 'feature']);
    r = await fetch(`${base}/api/target-status?target=main`, { headers: { 'x-session-id': connected.id, cookie: results[0].cookie } });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { target: 'main', head: targetOid, protected: false, canPush: true });
    r = await fetch(`${base}/api/commits?target=main&source=feature`, { headers: { 'x-session-id': connected.id, cookie: results[0].cookie } });
    assert.equal(r.status, 200); const firstPage = await r.json(); assert.equal(firstPage.commits[0].id, 'b'.repeat(40)); assert.equal(firstPage.hasMore, true);
    r = await fetch(`${base}/api/commits?target=main&source=feature&page=2`, { headers: { 'x-session-id': connected.id, cookie: results[0].cookie } });
    assert.equal(r.status, 200); const secondPage = await r.json(); assert.equal(secondPage.commits[0].id, 'c'.repeat(40)); assert.equal(secondPage.hasMore, false);
    r = await fetch(`${base}/api/commits?target=main&source=feature&onlyMissing=0`, { headers: { 'x-session-id': connected.id, cookie: results[0].cookie } });
    assert.equal(r.status, 200); const allHistory = await r.json(); assert.equal(allHistory.commits[1].title, 'Common ancestor');
    r = await fetch(`${base}/api/branch-commits?branch=feature`, { headers: { 'x-session-id': connected.id, cookie: results[0].cookie } });
    assert.equal(r.status, 200); const boardHistory = await r.json(); assert.equal(boardHistory.commits.length, 2); assert.equal(boardHistory.commits[1].title, 'Common ancestor');
    assert.deepEqual(seenCommitRanges, ['main..feature', 'main..feature', 'feature', 'feature']);
    r = await fetch(`${base}/api/diff?target=main&source=feature&commit=${'b'.repeat(40)}`, { headers: { 'x-session-id': connected.id, cookie: results[0].cookie } });
    assert.equal(r.status, 200); const preview = await r.json(); assert.equal(preview.files[0].hunks.length, 1);
    const payload = { mode: 'gitlab-api', target: 'main', source: 'feature', commit: 'b'.repeat(40), fingerprint: preview.fingerprint };
    const headers = { 'content-type': 'application/json', 'x-session-id': connected.id, cookie: results[0].cookie };
    r = await fetch(`${base}/api/ai/config`, { method: 'POST', headers, body: JSON.stringify({ provider: 'openrouter', apiKey: 'private-ai-key' }) });
    assert.equal(r.status, 200); assert.equal((await r.json()).model, 'openrouter/auto');
    r = await fetch(`${base}/api/ai/config`, { headers });
    const aiState = await r.text(); assert.doesNotMatch(aiState, /private-ai-key/);
    r = await fetch(`${base}/api/ai/config`, { method: 'POST', headers, body: JSON.stringify({ provider: 'litellm', keySource: 'env', model: 'team-model', baseURL: 'http://127.0.0.1:4000' }) });
    assert.equal(r.status, 200); const envConfig = await r.text(); assert.match(envConfig, /"keySource":"env"/); assert.doesNotMatch(envConfig, /server-only-key/);
    r = await fetch(`${base}/api/ai/config`, { headers: { cookie: results[1].cookie } });
    assert.equal((await r.json()).configured, false);
    r = await fetch(`${base}/api/agent/confirm`, { method: 'POST', headers, body: JSON.stringify({ proposalId: 'not-approved' }) });
    assert.match((await r.json()).error, /清单已失效/);
    r = await fetch(`${base}/api/check`, { method: 'POST', headers, body: JSON.stringify(payload) });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });
    assert.equal(targetOid, 'a'.repeat(40)); assert.deepEqual(cherryCalls, [{ branch: 'main', dry_run: true }]);
    r = await fetch(`${base}/api/create`, { method: 'POST', headers, body: JSON.stringify(payload) });
    assert.equal(r.status, 200); const created = await r.json(); assert.equal(created.commit, 'd'.repeat(40)); assert.equal(created.target, 'main'); assert.equal(created.recordSaved, true);
    assert.equal(targetOid, 'd'.repeat(40)); assert.deepEqual(cherryCalls.at(-1), { branch: 'main', dry_run: false });
    r = await fetch(`${base}/api/operations`, { headers });
    assert.equal(r.status, 200); const recorded = (await r.json()).operations; assert.equal(recorded.length, 1); assert.equal(recorded[0].sourceCommit, 'b'.repeat(40)); assert.equal(recorded[0].resultCommit, targetOid);
    r = await fetch(`${base}/api/landings?commit=${'b'.repeat(40)}`, { headers });
    assert.equal(r.status, 200); const landings = (await r.json()).branches;
    assert.deepEqual(landings.map(x => [x.branch, x.state, x.via]), [['main', 'present', 'cherry-pick'], ['feature', 'present', 'original']]);
    r = await fetch(`${base}/api/landings?commit=${'c'.repeat(40)}`, { headers });
    assert.equal(r.status, 200); const equivalents = (await r.json()).branches;
    assert.deepEqual(equivalents.map(x => [x.branch, x.state, x.via, x.resultCommit]), [['main', 'present', 'equivalent', 'f'.repeat(40)], ['feature', 'present', 'original', null]]);
    const savedHistory = await fs.readFile(path.join(testDataDir, 'operations.json'), 'utf8');
    assert.equal(JSON.parse(savedHistory).length, 1); assert.doesNotMatch(savedHistory, /alice-token|bob-token/);
    r = await fetch(`${base}/api/create`, { method: 'POST', headers, body: JSON.stringify(payload) });
    assert.equal(r.status, 400); assert.match((await r.json()).error, /远程分支已有更新/);
    r = await fetch(`${base}/api/diff?target=main&source=feature&commit=${'c'.repeat(40)}`, { headers: { 'x-session-id': connected.id, cookie: results[0].cookie } });
    assert.equal(r.status, 200); const alreadyApplied = await r.json();
    r = await fetch(`${base}/api/check`, { method: 'POST', headers, body: JSON.stringify({ ...payload, commit: 'c'.repeat(40), fingerprint: alreadyApplied.fingerprint }) });
    assert.equal(r.status, 400); const emptyResult = await r.json(); assert.equal(emptyResult.code, 'already_applied'); assert.match(emptyResult.error, /已包含/);
    r = await fetch(`${base}/api/batch`, { method: 'POST', headers, body: JSON.stringify({ mode: 'gitlab-api', target: 'main', source: 'feature', commits: ['b'.repeat(40), 'c'.repeat(40)] }) });
    assert.equal(r.status, 200); const batch = await r.json(); assert.equal(batch.completed.length, 1); assert.equal(batch.completed[0].recordSaved, true); assert.equal(batch.stopped.index, 1); assert.equal(batch.stopped.code, 'already_applied'); assert.equal(batch.remaining.length, 0);
    r = await fetch(`${base}/api/operations`, { headers });
    assert.equal((await r.json()).operations.length, 3);
    r = await fetch(`${base}/api/batch`, { method: 'POST', headers, body: JSON.stringify({ mode: 'gitlab-api', target: 'main', source: 'feature', commits: ['b'.repeat(40), 'e'.repeat(40), 'c'.repeat(40)] }) });
    assert.equal(r.status, 200); const conflictBatch = await r.json(); assert.equal(conflictBatch.completed.length, 1); assert.equal(conflictBatch.stopped.code, 'conflict'); assert.deepEqual(conflictBatch.remaining, ['c'.repeat(40)]);
    r = await fetch(`${base}/api/operations`, { headers });
    assert.equal((await r.json()).operations.length, 5);
    branchProtected = true; canPush = false;
    r = await fetch(`${base}/api/target-status?target=main`, { headers });
    assert.equal(r.status, 200); const blocked = await r.json(); assert.equal(blocked.protected, true); assert.equal(blocked.canPush, false);
    r = await fetch(`${base}/api/batch`, { method: 'POST', headers, body: JSON.stringify({ mode: 'gitlab-api', target: 'main', source: 'feature', commits: ['b'.repeat(40)] }) });
    assert.equal(r.status, 400); assert.match((await r.json()).error, /不能直接写入/);
    r = await fetch(`${base}/api/connect`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: results[1].cookie }, body: JSON.stringify({ url: `${gitlabUrl}2/repo.git` }) });
    assert.equal(r.status, 200); const bobRepo = await r.json();
    r = await fetch(`${base}/api/operations`, { headers: { 'x-session-id': bobRepo.id, cookie: results[1].cookie } });
    assert.equal(r.status, 200); assert.equal((await r.json()).operations.length, 0);
  } finally { child.kill(); await close(gitlab); await fs.rm(testDataDir, { recursive: true, force: true }); }
});
