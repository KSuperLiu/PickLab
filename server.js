import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { aiConfig, publicAiConfig, liteLLMModels } from './ai.js';
import { runAgent } from './agent.js';

const port = Number(process.env.PORT || 4173);
const sessions = new Map();
const oauthSessions = new Map();
const pendingLogins = new Map();
const inFlightTargets = new Set();
const dataDir = process.env.PICKLAB_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'PickLab');
const historyFile = path.join(dataDir, 'operations.json');
let historyWrite = Promise.resolve();
const oauthBase = process.env.GITLAB_BASE_URL || '';
const oauthClientId = process.env.GITLAB_OAUTH_CLIENT_ID || '';
const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ''));
function json(res, status, body) { const data = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(data); }
function fail(res, e, status = 400) { json(res, status, { error: e.message || String(e), ...(e.code ? { code: e.code } : {}) }); }
async function body(req) { let data = ''; for await (const part of req) { data += part; if (data.length > 1_000_000) throw new Error('请求过大'); } return JSON.parse(data || '{}'); }
function cookies(req) { return Object.fromEntries((req.headers.cookie || '').split(';').map(part => part.trim().split('=').map(x => decodeURIComponent(x))).filter(pair => pair.length === 2)); }
function oauthSession(req) { return oauthSessions.get(cookies(req).pl_session); }
function getSession(req) { const id = req.headers['x-session-id']; const s = sessions.get(id); if (!s) throw new Error('请先连接 GitLab 项目'); if (s.oauthSessionId && s.oauthSessionId !== cookies(req).pl_session) throw new Error('登录会话与项目不匹配'); return s; }
function safeRef(ref) { if (typeof ref !== 'string' || !ref || ref.length > 180 || ref.startsWith('-')) throw new Error('分支名称无效'); return ref; }
function validToken(token) {
  if (typeof token !== 'string' || !token || token.length > 1024 || !/^[\x21-\x7e]+$/.test(token)) {
    throw new Error('个人访问令牌只能是创建时显示的完整英文字符和数字；请勿填写中文令牌名称或带空格的文字。');
  }
  return token;
}
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function randomId() { return crypto.randomBytes(32).toString('base64url'); }
async function readHistory() {
  try { const value = JSON.parse(await fs.readFile(historyFile, 'utf8')); return Array.isArray(value) ? value : []; }
  catch (e) { if (e.code === 'ENOENT') return []; throw new Error('无法读取 PickLab 操作记录'); }
}
async function recordOperation(s, detail) {
  const entry = { id: crypto.randomUUID(), gitlab: s.apiBase, project: decodeURIComponent(s.projectId), userId: s.userId, at: new Date().toISOString(), ...detail };
  const task = historyWrite.catch(() => {}).then(async () => {
    const records = await readHistory(); records.unshift(entry);
    await fs.mkdir(dataDir, { recursive: true });
    const temporary = path.join(dataDir, `operations-${crypto.randomUUID()}.tmp`);
    try { await fs.writeFile(temporary, JSON.stringify(records.slice(0, 2000)), { mode: 0o600 }); await fs.rename(temporary, historyFile); }
    finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  });
  historyWrite = task;
  await task;
  return entry;
}
async function operations(s) {
  await historyWrite.catch(() => {});
  return (await readHistory()).filter(x => x.gitlab === s.apiBase && x.project === decodeURIComponent(s.projectId) && x.userId === s.userId).slice(0, 100);
}
async function commitRefs(s, sha) {
  const names = new Set();
  for (let page = 1; page <= 10; page++) {
    const refs = await gitlabGet(s.apiBase, s.token, `projects/${s.projectId}/repository/commits/${sha}/refs?type=branch&per_page=100&page=${page}`, s.authType);
    if (!Array.isArray(refs)) throw new Error('GitLab 返回了无效的提交分支数据');
    for (const ref of refs) if (ref.type === 'branch' && typeof ref.name === 'string') names.add(ref.name);
    if (refs.length < 100) break;
  }
  return names;
}
async function patchSignature(s, sha) {
  const files = [];
  for (let page = 1; page <= 3; page++) {
    const part = await gitlabGet(s.apiBase, s.token, `projects/${s.projectId}/repository/commits/${sha}/diff?per_page=100&page=${page}`, s.authType);
    if (!Array.isArray(part)) throw new Error('GitLab 提交差异数据格式不正确');
    files.push(...part);
    if (part.length < 100) break;
    if (page === 3) return null;
  }
  const changes = files.map(file => ({
    old: file.old_path, next: file.new_path,
    added: Boolean(file.new_file), deleted: Boolean(file.deleted_file), renamed: Boolean(file.renamed_file),
    lines: (file.diff || '').split('\n').filter(line => (line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---')))
  })).sort((a, b) => `${a.old}\0${a.next}`.localeCompare(`${b.old}\0${b.next}`));
  if (!changes.length || changes.some(file => !file.lines.length)) return null;
  return hash(JSON.stringify(changes));
}
async function equivalentCommits(s, sourceCommit, title, signature) {
  const matches = [];
  let checked = 0;
  for (let page = 1; page <= 5; page++) {
    const list = await gitlabGet(s.apiBase, s.token, `projects/${s.projectId}/repository/commits?all=true&per_page=100&page=${page}`, s.authType);
    if (!Array.isArray(list)) throw new Error('GitLab 全部分支提交数据格式不正确');
    for (const item of list) {
      if (item.id === sourceCommit || item.title !== title || !/^[0-9a-f]{40,64}$/i.test(item.id || '') || checked >= 25) continue;
      checked++;
      try {
        if (await patchSignature(s, item.id) === signature) matches.push({ commit: item.id, webUrl: item.web_url || null, branches: await commitRefs(s, item.id) });
      } catch { /* Another candidate can still be checked. */ }
    }
    if (list.length < 100) break;
  }
  return matches;
}
async function landings(s, commit) {
  if (!/^[0-9a-f]{40,64}$/i.test(commit || '')) throw new Error('请输入完整的来源提交 SHA');
  await historyWrite.catch(() => {});
  const records = (await readHistory()).filter(x => x.gitlab === s.apiBase && x.project === decodeURIComponent(s.projectId) && x.userId === s.userId && x.sourceCommit === commit);
  const latest = new Map();
  for (const entry of records) if (entry.status === 'success' && entry.resultCommit && s.branches.includes(entry.target) && !latest.has(entry.target)) latest.set(entry.target, entry);
  const refs = new Map();
  const shas = [...new Set([commit, ...[...latest.values()].map(x => x.resultCommit)])];
  for (let i = 0; i < shas.length; i += 4) {
    await Promise.all(shas.slice(i, i + 4).map(async sha => {
      try { refs.set(sha, { branches: await commitRefs(s, sha) }); }
      catch { refs.set(sha, { error: true }); }
    }));
  }
  const sourceRefs = refs.get(commit);
  const result = s.branches.map(branch => {
    const entry = latest.get(branch);
    const resultRefs = entry && refs.get(entry.resultCommit);
    const originalPresent = sourceRefs?.branches?.has(branch);
    const pickedPresent = resultRefs?.branches?.has(branch);
    const state = originalPresent || pickedPresent ? 'present' : sourceRefs?.error || resultRefs?.error ? 'unverified' : entry ? 'absent' : 'no_record';
    return { branch, state, via: originalPresent ? 'original' : pickedPresent ? 'cherry-pick' : null, resultCommit: entry?.resultCommit || null, at: entry?.at || null, webUrl: entry?.webUrl || null };
  });
  let title = records[0]?.title || '';
  const unchecked = result.filter(item => item.state !== 'present');
  if (unchecked.length) {
    try {
      const source = await gitlabGet(s.apiBase, s.token, `projects/${s.projectId}/repository/commits/${commit}`, s.authType);
      title = source.title || title;
      const signature = await patchSignature(s, commit);
      if (title && signature) {
        const matches = await equivalentCommits(s, commit, title, signature);
        for (const item of unchecked) {
          const match = matches.find(candidate => candidate.branches.has(item.branch));
          if (match) { item.state = 'present'; item.via = 'equivalent'; item.resultCommit = match.commit; item.webUrl = match.webUrl; }
          else if (item.state === 'no_record') item.state = 'not_found_recent';
        }
      }
    } catch { /* Keep SHA and operation-record results when diff lookup is unavailable. */ }
  }
  return { commit, title, branches: result };
}
async function checkAgentLanding(s, input) {
  const target = safeRef(input.target), shortSha = String(input.commit || '');
  if (!s.branches.includes(target)) throw new Error('目标分支不存在');
  if (!/^[0-9a-f]{7,64}$/i.test(shortSha)) throw new Error('请提供至少 7 位提交 SHA');
  const resolved = await gitlabGet(s.apiBase, s.token, `projects/${s.projectId}/repository/commits/${shortSha}`, s.authType);
  if (!/^[0-9a-f]{40,64}$/i.test(resolved.id || '') || !resolved.id.toLowerCase().startsWith(shortSha.toLowerCase())) throw new Error('无法确定来源提交的完整 SHA');
  const result = await landings(s, resolved.id);
  const direct = result.branches.find(item => item.branch === target);
  const parents = [];
  if (direct.state !== 'present' && Array.isArray(resolved.parent_ids) && resolved.parent_ids.length > 1) {
    for (const parent of resolved.parent_ids.slice(0, 2)) {
      if (!/^[0-9a-f]{40,64}$/i.test(parent)) continue;
      try {
        const checked = await landings(s, parent);
        const item = checked.branches.find(branch => branch.branch === target);
        parents.push({ commit: parent, title: checked.title, state: item.state, via: item.via, resultCommit: item.resultCommit });
      } catch { parents.push({ commit: parent, state: 'unverified' }); }
    }
  }
  return { commit: result.commit, title: result.title || resolved.title || '', target, ...direct, parents, parentsTruncated: Array.isArray(resolved.parent_ids) && resolved.parent_ids.length > 2 };
}
function agentLandingReply(check) {
  const prefix = `提交 ${check.commit} 在 ${check.target}`;
  if (check.state === 'present') {
    const method = check.via === 'original' ? '原提交存在' : check.via === 'cherry-pick' ? '检出 PickLab 遴选产生的新提交' : '检出同标题且补丁一致的提交';
    return `${prefix}：${method}${check.resultCommit ? `（${check.resultCommit.slice(0, 8)}）` : ''}。此结果来自变更落地核验；后续提交仍可能改动或撤销相关代码。`;
  }
  const landedParents = (check.parents || []).filter(parent => parent.state === 'present');
  if (landedParents.length) {
    const details = landedParents.map(parent => `${parent.commit.slice(0, 8)} ${parent.via === 'original' ? '原提交存在' : parent.via === 'cherry-pick' ? '已遴选' : '检出等价补丁'}${parent.resultCommit ? `（${parent.resultCommit.slice(0, 8)}）` : ''}`).join('；');
    return `${prefix}：合并提交本身尚未核实为已遴选；其父提交中 ${details}。这能确认这些父提交的改动落地，不能据此认定整个合并提交的所有改动都已落地${check.parentsTruncated ? '；另有父提交尚未检查' : ''}。`;
  }
  if (check.state === 'not_found_recent') return `${prefix}：近 500 条项目提交中未检出等价提交，也没有匹配的遴选记录；无法据此断定代码未落地。`;
  if (check.state === 'absent') return `${prefix}：操作记录中的遴选提交 ${check.resultCommit?.slice(0, 8) || ''} 已不在该分支；无法据此断定相关代码不存在。`;
  return `${prefix}：暂无法验证是否落地。${check.state === 'unverified' ? 'GitLab 提交引用查询未完成。' : '没有可核实的遴选记录或等价补丁结果。'}`;
}
function cookie(name, value, maxAge) { return `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`; }
function redirect(res, target, setCookies = []) { res.writeHead(302, { location: target, 'set-cookie': setCookies, 'cache-control': 'no-store' }); res.end(); }
async function removeLogin(id) {
  if (!id) return;
  oauthSessions.delete(id);
  for (const [sessionId, s] of sessions) if (s.oauthSessionId === id) sessions.delete(sessionId);
}
async function exchangeToken(fields) {
  const response = await fetch(new URL('/oauth/token', oauthBase), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`GitLab OAuth 令牌交换失败：${response.status}`);
  const data = await response.json();
  if (!data.access_token) throw new Error('GitLab 没有返回访问令牌');
  return data;
}
async function refreshOauth(session) {
  if (session.expiresAt > Date.now() + 60_000) return session.accessToken;
  if (!session.refreshToken) throw new Error('GitLab 登录已过期，请重新登录');
  if (!session.refreshing) session.refreshing = (async () => {
    const data = await exchangeToken({ client_id: oauthClientId, refresh_token: session.refreshToken, grant_type: 'refresh_token', redirect_uri: redirectUri });
    session.accessToken = data.access_token;
    session.refreshToken = data.refresh_token;
    session.expiresAt = Date.now() + (data.expires_in || 7200) * 1000;
    return session.accessToken;
  })().finally(() => { session.refreshing = null; });
  return session.refreshing;
}
async function currentToken(req, input) {
  const auth = oauthSession(req);
  if (auth) return { token: validToken(auth.type === 'oauth' ? await refreshOauth(auth) : auth.accessToken), type: auth.type, auth };
  throw new Error('请先使用你自己的个人令牌登录 GitLab');
}
async function refreshRepoToken(s) { if (s.oauthSessionId) { const auth = oauthSessions.get(s.oauthSessionId); if (!auth) throw new Error('GitLab 登录已失效'); s.token = auth.type === 'oauth' ? await refreshOauth(auth) : auth.accessToken; } }
function remoteUrl(input, requireProject = true) {
  let remote;
  try { remote = new URL(input.url); } catch { throw new Error('请输入 GitLab 地址'); }
  if (remote.protocol === 'http:') {
    if (input.allowInsecure !== true) throw new Error('此 GitLab 地址使用 HTTP；请先勾选“确认 HTTP 传输风险”再继续');
  } else if (remote.protocol !== 'https:') throw new Error('GitLab 地址必须以 http:// 或 https:// 开头');
  if (remote.username || remote.password || remote.search || remote.hash || remote.pathname.includes('/-/')) throw new Error('GitLab 地址不能包含账号密码、查询参数或设置页路径');
  if (requireProject && remote.pathname.split('/').filter(Boolean).length < 2) throw new Error('请先点击“查询我的最近仓库”并选择项目，或输入完整的“组名/项目名”地址');
  return remote;
}
async function gitlabGet(base, token, route, type = 'personal') {
  validToken(token);
  const response = await fetch(new URL(`/api/v4/${route}`, base), {
    headers: type === 'oauth' ? { Authorization: `Bearer ${token}` } : { 'PRIVATE-TOKEN': token }, signal: AbortSignal.timeout(15000)
  });
  if (response.status === 401) throw new Error('GitLab 返回 401：令牌未被接受。请粘贴创建时显示的完整令牌值（不是令牌名称），并确认它未过期或撤销、GitLab 地址正确。');
  if (response.status === 403) throw new Error('GitLab 返回 403：当前账号或令牌没有访问该接口的权限。请检查项目权限和令牌的 api 权限。');
  if (!response.ok) throw new Error(`GitLab API 返回 ${response.status}`);
  return response.json();
}
async function cherryPick(s, target, commit, dryRun) {
  let response;
  try {
    response = await fetch(new URL(`/api/v4/projects/${s.projectId}/repository/commits/${commit}/cherry_pick`, s.apiBase), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(s.authType === 'oauth' ? { Authorization: `Bearer ${s.token}` } : { 'PRIVATE-TOKEN': s.token }) },
      body: JSON.stringify({ branch: target, dry_run: dryRun }),
      signal: AbortSignal.timeout(60000)
    });
  } catch {
    const error = new Error(dryRun ? 'GitLab 检查请求未完成，请稍后重试' : 'GitLab 响应中断，遴选结果未确认；请先查看目标分支，再决定是否重试');
    if (!dryRun) error.code = 'uncertain';
    throw error;
  }
  let data = {};
  try { data = await response.json(); } catch {}
  if (response.status === 401 || response.status === 403) throw new Error('GitLab 拒绝遴选请求：请使用带 api 权限的个人令牌，并确认你有权直接写入目标分支');
  if (!response.ok) {
    if (data.error_code === 'conflict') { const error = new Error('这条提交与目标分支有冲突，GitLab 无法自动遴选'); error.code = 'conflict'; throw error; }
    if (data.error_code === 'empty') { const error = new Error('遴选结果为空：目标分支可能已包含这项改动，或后续提交已覆盖其内容'); error.code = 'already_applied'; throw error; }
    throw new Error(`GitLab 遴选失败（HTTP ${response.status}）：${typeof data.message === 'string' ? data.message : '请检查目标分支权限和提交状态'}`);
  }
  if (dryRun) {
    if (response.status !== 200 || data.dry_run !== 'success') throw new Error('GitLab 未确认安全的 dry_run 结果，检查已中止；请确认服务器支持此接口');
    return { ok: true };
  }
  if (response.status !== 201 || !/^[0-9a-f]{40,64}$/i.test(data.id || '')) { const error = new Error('GitLab 未返回明确的新提交；请在目标分支检查结果后再操作'); error.code = 'uncertain'; throw error; }
  return { commit: data.id, webUrl: data.web_url || null };
}
async function recentProjects(base, token, type) {
  const user = await gitlabGet(base, token, 'user', type);
  if (!Number.isInteger(user.id)) throw new Error('无法识别当前 GitLab 账号');
  const ids = new Set();
  const eventsByProject = new Map();
  for (let page = 1; page <= 20 && ids.size < 10; page++) {
    const events = await gitlabGet(base, token, `users/${user.id}/events?action=pushed&sort=desc&per_page=100&page=${page}`, type);
    if (!Array.isArray(events)) throw new Error('GitLab 活动数据格式不正确');
    for (const event of events) {
      if (event.push_data?.ref_type !== 'branch' || !Number.isInteger(event.project_id)) continue;
      if (!ids.has(event.project_id)) { ids.add(event.project_id); eventsByProject.set(event.project_id, event); }
      if (ids.size >= 10) break;
    }
    if (events.length < 100) break;
  }
  const projects = await Promise.all([...ids].map(async id => {
    const info = await gitlabGet(base, token, `projects/${id}`, type);
    return { name: info.name_with_namespace || info.path_with_namespace, url: info.http_url_to_repo, pushedAt: eventsByProject.get(id).created_at };
  }));
  return { source: 'my-pushes', projects: projects.filter(p => p.name && p.url) };
}
async function branches(s) {
  return s.branches;
}
async function branchCommits(s, branch, page = 1) {
  if (!s.branches.includes(branch)) throw new Error('请选择当前项目中的分支');
  if (!Number.isInteger(page) || page < 1 || page > 100) throw new Error('提交页码无效');
  const list = await gitlabGet(s.apiBase, s.token, `projects/${s.projectId}/repository/commits?ref_name=${encodeURIComponent(branch)}&per_page=50&page=${page}`, s.authType);
  if (!Array.isArray(list)) throw new Error('GitLab 提交数据格式不正确');
  return { commits: list.map(c => ({ id: c.id, shortId: c.short_id, title: c.title, createdAt: c.created_at, author: c.author_name })), hasMore: list.length === 50 };
}
async function targetStatus(s, target) {
  safeRef(target);
  if (!s.branches.includes(target)) throw new Error('目标分支不存在');
  const branch = await gitlabGet(s.apiBase, s.token, `projects/${s.projectId}/repository/branches/${encodeURIComponent(target)}`, s.authType);
  if (!/^[0-9a-f]{40,64}$/i.test(branch.commit?.id || '')) throw new Error('无法获取目标分支的当前提交');
  return { target, head: branch.commit.id, protected: Boolean(branch.protected), canPush: branch.can_push === true };
}
async function commits(s, target, source, page = 1, onlyMissing = true) {
  safeRef(target); safeRef(source);
  if (!s.branches.includes(target) || !s.branches.includes(source) || target === source) throw new Error('请选择两个不同的远程分支');
  if (!Number.isInteger(page) || page < 1 || page > 1000) throw new Error('提交页码无效');
  const revision = onlyMissing ? `${target}..${source}` : source;
  const list = await gitlabGet(s.apiBase, s.token, `projects/${s.projectId}/repository/commits?ref_name=${encodeURIComponent(revision)}&per_page=100&page=${page}`, s.authType);
  if (!Array.isArray(list)) throw new Error('GitLab 提交列表格式不正确');
  s.allowedCommits ||= new Map();
  s.commitTitles ||= new Map();
  for (const c of list) { s.allowedCommits.set(c.id, source); s.commitTitles.set(c.id, c.title || '无标题'); }
  return { commits: list.map(c => ({ id: c.id, shortId: c.short_id, title: c.title, message: c.message, createdAt: c.created_at, author: c.author_name, authorEmail: c.author_email })), hasMore: list.length === 100, onlyMissing };
}
async function commitDiffContains(s, commit, query) {
  for (let page = 1; page <= 10; page++) {
    const files = await gitlabGet(s.apiBase, s.token, `projects/${s.projectId}/repository/commits/${commit}/diff?per_page=100&page=${page}`, s.authType);
    if (!Array.isArray(files)) throw new Error('GitLab 提交差异格式不正确');
    if (files.some(file => String(file.diff || '').toLowerCase().includes(query))) return true;
    if (files.some(file => file.too_large || file.collapsed)) throw new Error('部分提交差异被 GitLab 截断，无法完整检索代码内容');
    if (files.length < 100) return false;
  }
  throw new Error('提交差异超过 1000 个文件，无法完整检索代码内容');
}
async function findMatchingCommits(s, input) {
  const { source, target } = input;
  safeRef(source);
  if (!s.branches.includes(source)) throw new Error('来源分支不存在');
  if (target !== undefined) {
    safeRef(target);
    if (!s.branches.includes(target) || source === target) throw new Error('来源分支与目标分支必须是当前项目中的两个不同分支');
  }
  const criteria = Object.fromEntries(['author', 'title', 'content', 'sha'].map(key => [key, String(input[key] || '').trim()]));
  if (Object.values(criteria).some(value => value.length > 200)) throw new Error('检索条件过长');
  if (criteria.sha && !/^[0-9a-f]{7,64}$/i.test(criteria.sha)) throw new Error('SHA 应为至少 7 位十六进制字符');
  const raw = [];
  let historyTruncated = false;
  for (let page = 1; page <= 10; page++) {
    const result = target === undefined
      ? await gitlabGet(s.apiBase, s.token, `projects/${s.projectId}/repository/commits?ref_name=${encodeURIComponent(source)}&per_page=100&page=${page}`, s.authType).then(list => {
          if (!Array.isArray(list)) throw new Error('GitLab 提交列表格式不正确');
          return { commits: list.map(c => ({ id: c.id, shortId: c.short_id, title: c.title, message: c.message, createdAt: c.created_at, author: c.author_name, authorEmail: c.author_email })), hasMore: list.length === 100 };
        })
      : await commits(s, target, source, page, true);
    raw.push(...result.commits);
    if (!result.hasMore) break;
    if (page === 10) historyTruncated = true;
  }
  const author = criteria.author.toLowerCase(), title = criteria.title.toLowerCase(), content = criteria.content.toLowerCase(), sha = criteria.sha.toLowerCase();
  const candidates = raw.filter(item => {
    const name = String(item.author || '').toLowerCase(), email = String(item.authorEmail || '').toLowerCase();
    return (!author || name === author || email === author || email.split('@')[0] === author)
      && (!title || String(item.title || '').toLowerCase().includes(title))
      && (!sha || item.id.toLowerCase().startsWith(sha));
  });
  const contentSearchTruncated = Boolean(content && candidates.length > 50);
  const matches = [];
  for (const item of content ? candidates.slice(0, 50) : candidates) {
    if (content && !String(item.message || '').toLowerCase().includes(content) && !await commitDiffContains(s, item.id, content)) continue;
    matches.push({ id: item.id, shortId: item.shortId, title: item.title, createdAt: item.createdAt, author: item.author });
  }
  matches.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return { source, target: target || null, criteria, scanned: raw.length, candidateCount: candidates.length, tooMany: matches.length > 20, historyTruncated, contentSearchTruncated, commits: matches.slice(0, 20) };
}
async function prepareAgentSelection(s, input, cached) {
  if (!input.target) throw new Error('遴选需要指定目标分支');
  const found = cached || await findMatchingCommits(s, input);
  if (found.tooMany) throw new Error('匹配提交超过 20 条，请缩小作者或分支范围后再试');
  if (found.historyTruncated) throw new Error('来源分支独有历史超过 1000 条，尚未扫描完；请缩小范围，避免遗漏提交');
  if (found.contentSearchTruncated) throw new Error('代码内容检索候选超过 50 条，尚未扫描完；请增加作者、标题或 SHA 条件');
  if (!found.commits.length) throw new Error(`在 ${found.source} 相对 ${found.target} 独有的历史中，没有找到匹配的提交`);
  const state = await targetStatus(s, found.target);
  if (!state.canPush) throw new Error(`当前账号不能直接写入目标分支 ${found.target}`);
  const proposal = { id: crypto.randomUUID(), source: found.source, target: found.target, criteria: found.criteria, targetHead: state.head, commits: found.commits.toReversed().map(c => ({ id: c.id, title: c.title || '无标题', author: c.author || '', createdAt: c.createdAt || '' })), expiresAt: Date.now() + 600000 };
  s.agentPending = proposal;
  return { proposal: { id: proposal.id, source: proposal.source, target: proposal.target, criteria: proposal.criteria, commits: proposal.commits, expiresAt: proposal.expiresAt }, message: '已生成待确认清单，尚未写入目标分支' };
}
async function diff(s, target, source, commit) {
  safeRef(target); safeRef(source);
  if (!s.branches.includes(target) || !s.branches.includes(source) || target === source) throw new Error('请选择两个不同的远程分支');
  if (!/^[0-9a-f]{40,64}$/i.test(commit || '') || s.allowedCommits?.get(commit) !== source) throw new Error('请先从来源分支的列表中选择一个提交');
  const targetInfo = await gitlabGet(s.apiBase, s.token, `projects/${s.projectId}/repository/branches/${encodeURIComponent(target)}`, s.authType);
  const targetOid = targetInfo.commit?.id;
  if (!/^[0-9a-f]{40,64}$/i.test(targetOid || '')) throw new Error('无法获取目标分支的当前提交');
  const data = [];
  for (let page = 1; page <= 10; page++) {
    const part = await gitlabGet(s.apiBase, s.token, `projects/${s.projectId}/repository/commits/${commit}/diff?per_page=100&page=${page}`, s.authType);
    if (!Array.isArray(part)) throw new Error('GitLab 提交差异格式不正确');
    data.push(...part);
    if (part.length < 100) break;
  }
  const files = [];
  for (const entry of data) {
    const oldPath = entry.old_path, newPath = entry.new_path;
    if (typeof oldPath !== 'string' || typeof newPath !== 'string' || oldPath.includes('\n') || newPath.includes('\n')) continue;
    const unsupported = Boolean(entry.renamed_file || entry.too_large || entry.collapsed || !entry.diff);
    const mode = entry.new_file ? `new file mode ${entry.b_mode || '100644'}\n` : entry.deleted_file ? `deleted file mode ${entry.a_mode || '100644'}\n` : '';
    const header = `diff --git a/${oldPath} b/${newPath}\n${mode}--- ${entry.new_file ? '/dev/null' : 'a/' + oldPath}\n+++ ${entry.deleted_file ? '/dev/null' : 'b/' + newPath}\n`;
    const f = { header, path: newPath, hunks: [], unsupported };
    if (!unsupported) for (const line of entry.diff.split(/(?<=\n)/)) {
      if (line.startsWith('@@ ')) f.hunks.push({ text: line });
      else if (f.hunks.length) f.hunks.at(-1).text += line;
    }
    if (!f.hunks.length) f.unsupported = true;
    for (const h of f.hunks) h.id = hash(commit + header + h.text);
    files.push(f);
  }
  return { files, fingerprint: hash(JSON.stringify(data) + targetOid), targetOid };
}
async function selection(s, input) {
  const target = safeRef(input.target), source = safeRef(input.source);
  const current = await diff(s, target, source, input.commit);
  if (current.fingerprint !== input.fingerprint) throw new Error('远程分支已有更新，请重新加载差异');
  return { target, source, commit: input.commit, targetOid: current.targetOid };
}
function targetLockKey(s, target) { return `${s.apiBase}/${s.projectId}/${target}`; }
function acquireTarget(s, target) {
  const key = targetLockKey(s, target);
  if (inFlightTargets.has(key)) throw new Error('该目标分支已有遴选操作正在执行，请稍后重试');
  inFlightTargets.add(key);
  return () => inFlightTargets.delete(key);
}
async function saveResult(s, detail) {
  try { await recordOperation(s, detail); return true; }
  catch (e) { console.error('PickLab 操作记录保存失败：', e.message); return false; }
}
async function batchCherryPick(s, input) {
  if (input.mode !== 'gitlab-api') throw new Error('页面版本已更新，请刷新后重试');
  const target = safeRef(input.target), source = safeRef(input.source), commits = input.commits;
  if (!s.branches.includes(target) || !s.branches.includes(source) || target === source) throw new Error('请选择两个不同的远程分支');
  if (!Array.isArray(commits) || commits.length < 1 || commits.length > 20 || new Set(commits).size !== commits.length || commits.some(c => !/^[0-9a-f]{40,64}$/i.test(c || '') || s.allowedCommits?.get(c) !== source)) throw new Error('请选择 1 至 20 条来源分支的提交');
  const release = acquireTarget(s, target);
  try {
    let state = await targetStatus(s, target);
    if (!state.canPush) throw new Error(`当前账号不能直接写入目标分支 ${target}`);
    if (input.expectedHead && state.head !== input.expectedHead) throw new Error('目标分支在生成遴选清单后发生变化，请重新查询');
    const completed = [];
    for (let index = 0; index < commits.length; index++) {
      const commit = commits[index];
      try {
        await cherryPick(s, target, commit, true);
        const latest = await targetStatus(s, target);
        if (!latest.canPush || latest.head !== state.head) throw new Error('目标分支在检查后发生变化，批量遴选已停止');
        const result = await cherryPick(s, target, commit, false);
        const detail = { status: 'success', target, source, sourceCommit: commit, resultCommit: result.commit, title: s.commitTitles?.get(commit) || '', webUrl: result.webUrl };
        const recordSaved = await saveResult(s, detail);
        completed.push({ ...detail, recordSaved });
        state = { ...latest, head: result.commit };
      } catch (e) {
        await saveResult(s, { status: e.code === 'uncertain' ? 'unknown' : 'failed', target, source, sourceCommit: commit, title: s.commitTitles?.get(commit) || '', code: e.code || 'error' });
        return { target, completed, stopped: { index, commit, code: e.code || 'error', error: e.message }, remaining: commits.slice(index + 1) };
      }
    }
    return { target, completed, stopped: null, remaining: [] };
  } finally { release(); }
}
async function route(req, res) {
  try {
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) throw new Error('拒绝来自其他网站的请求');
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === 'GET' && url.pathname === '/') {
      const html = await fs.readFile(path.join(root, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(html); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/status') {
      const auth = oauthSession(req);
      json(res, 200, { configured: Boolean(oauthClientId && oauthBase), authenticated: Boolean(auth), type: auth?.type || null, base: auth?.base || null, allowInsecure: Boolean(auth?.allowInsecure), user: auth ? { name: auth.user.name, username: auth.user.username } : null }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/pat-login') {
      const input = await body(req), remote = remoteUrl(input, false);
      const token = typeof input.token === 'string' ? input.token.trim() : '';
      if (!token) throw new Error('请输入你的个人访问令牌');
      validToken(token);
      const user = await gitlabGet(remote.origin, token, 'user');
      if (!Number.isInteger(user.id)) throw new Error('无法识别当前 GitLab 账号');
      const oldId = cookies(req).pl_session;
      await removeLogin(oldId);
      const id = randomId();
      oauthSessions.set(id, { type: 'personal', accessToken: token, base: remote.origin, user, allowInsecure: input.allowInsecure === true });
      res.setHeader('set-cookie', cookie('pl_session', id, 86400));
      json(res, 200, { user: { name: user.name, username: user.username } }); return;
    }
    if (req.method === 'GET' && url.pathname === '/auth/login') {
      if (!oauthClientId || !oauthBase) throw new Error('管理员尚未配置 GitLab OAuth 地址和应用 ID');
      const allowInsecure = url.searchParams.get('allowHttp') === '1';
      if (new URL(oauthBase).protocol !== 'https:' && !allowInsecure) throw new Error('HTTP 登录需要先确认传输风险');
      const state = randomId(), verifier = randomId();
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      pendingLogins.set(state, { verifier, createdAt: Date.now(), allowInsecure });
      const target = new URL('/oauth/authorize', oauthBase);
      target.search = new URLSearchParams({ client_id: oauthClientId, redirect_uri: redirectUri, response_type: 'code', state, scope: 'api', code_challenge: challenge, code_challenge_method: 'S256' }).toString();
      redirect(res, target.href, [cookie('pl_oauth_state', state, 300)]); return;
    }
    if (req.method === 'GET' && url.pathname === '/auth/callback') {
      const state = url.searchParams.get('state'), code = url.searchParams.get('code');
      const pending = pendingLogins.get(state);
      pendingLogins.delete(state);
      if (!pending || state !== cookies(req).pl_oauth_state || Date.now() - pending.createdAt > 300000) throw new Error('登录状态无效，请重新登录');
      if (!code) throw new Error('GitLab 未授予登录权限');
      const token = await exchangeToken({ client_id: oauthClientId, code, grant_type: 'authorization_code', redirect_uri: redirectUri, code_verifier: pending.verifier });
      const user = await gitlabGet(oauthBase, token.access_token, 'user', 'oauth');
      if (!Number.isInteger(user.id)) throw new Error('无法识别当前 GitLab 账号');
      const id = randomId();
      await removeLogin(cookies(req).pl_session);
      oauthSessions.set(id, { type: 'oauth', accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: Date.now() + (token.expires_in || 7200) * 1000, base: new URL(oauthBase).origin, user, allowInsecure: pending.allowInsecure });
      redirect(res, '/', [cookie('pl_session', id, 86400), cookie('pl_oauth_state', '', 0)]); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      await removeLogin(cookies(req).pl_session);
      res.setHeader('set-cookie', cookie('pl_session', '', 0)); json(res, 200, { ok: true }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/recent') {
      const input = await body(req); input.allowInsecure ||= oauthSession(req)?.allowInsecure; const remote = remoteUrl(input, false);
      const auth = await currentToken(req, input); if (auth.auth && remote.origin !== auth.auth.base) throw new Error('登录令牌只能用于登录时的 GitLab 站点');
      json(res, 200, await recentProjects(remote.origin, auth.token, auth.type)); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/connect') {
      const input = await body(req); input.allowInsecure ||= oauthSession(req)?.allowInsecure; const remote = remoteUrl(input);
      if (!remote.pathname.endsWith('.git')) remote.pathname = remote.pathname.replace(/\/$/, '') + '.git';
      const auth = await currentToken(req, input); if (auth.auth && remote.origin !== auth.auth.base) throw new Error('登录令牌只能用于登录时的 GitLab 站点');
      const token = auth.token;
      const projectPath = remote.pathname.replace(/^\//, '').replace(/\.git$/, '').replace(/\/$/, '');
      const projectId = encodeURIComponent(projectPath);
      const found = [];
      for (let page = 1; page <= 10; page++) {
        const list = await gitlabGet(remote.origin, token, `projects/${projectId}/repository/branches?per_page=100&page=${page}`, auth.type);
        if (!Array.isArray(list)) throw new Error('GitLab 分支数据格式不正确');
        found.push(...list.map(x => x.name).filter(x => typeof x === 'string'));
        if (list.length < 100) break;
      }
      const previousId = req.headers['x-session-id'];
      const previous = sessions.get(previousId);
      if (previous?.oauthSessionId === cookies(req).pl_session) sessions.delete(previousId);
      const id = crypto.randomUUID(); const s = { token, apiBase: remote.origin, projectId, authType: auth.type, userId: auth.auth.user.id, branches: found, oauthSessionId: cookies(req).pl_session }; sessions.set(id, s);
      json(res, 200, { id, branches: found });
      return;
    }
    if (url.pathname === '/api/ai/config') {
      const auth = oauthSession(req);
      if (!auth) throw new Error('请先登录 GitLab');
      if (req.method === 'GET') { json(res, 200, publicAiConfig(auth.ai)); return; }
      if (req.method === 'POST') {
        const input = await body(req);
        if (!input.apiKey && input.keySource !== 'env' && auth.ai?.provider === input.provider && auth.ai.keySource !== 'env') input.apiKey = auth.ai.apiKey;
        const discover = input.provider === 'litellm' && !String(input.model || '').trim();
        if (discover) input.model = '__discover__';
        const config = aiConfig(input);
        if (discover) { const models = await liteLLMModels(config); if (!models.length) throw new Error('LiteLLM 网关没有可用模型'); config.model = models[0]; }
        auth.ai = config;
        json(res, 200, publicAiConfig(auth.ai)); return;
      }
      if (req.method === 'DELETE') { delete auth.ai; json(res, 200, { configured: false }); return; }
    }
    if (req.method === 'GET' && url.pathname === '/api/ai/models') {
      const config = oauthSession(req)?.ai;
      if (!config) throw new Error('请先配置 AI 服务');
      json(res, 200, { models: await liteLLMModels(config) }); return;
    }
    const s = getSession(req);
    await refreshRepoToken(s);
    if (req.method === 'POST' && url.pathname === '/api/agent/chat') {
      const config = oauthSession(req)?.ai;
      if (!config) throw new Error('请先在 AI 设置中配置支持工具调用的模型');
      const input = await body(req), message = String(input.message || '').trim();
      if (!message || message.length > 1000) throw new Error('请输入 1 至 1000 字的请求');
      if (s.agentRunning) throw new Error('Agent 正在处理上一条消息，请稍候');
      s.agentRunning = true;
      s.agentPending = null;
      try {
        const cache = new Map();
        const landingChecks = [];
        const asksLanding = /(?:遴选到|落地到|是否落地|有没有落地|是否遴选|落地情况|是否包含)/.test(message) && /[？?吗]|是否|有没有|已|情况/.test(message);
        const find = async args => {
          const key = JSON.stringify(args);
          if (!cache.has(key)) cache.set(key, await findMatchingCommits(s, args));
          return cache.get(key);
        };
        const messages = [...(s.agentHistory || []), { role: 'user', content: message }];
        const result = await runAgent(config, messages, {
          listBranches: () => ({ branches: s.branches }),
          findCommits: find,
          checkLanding: async args => { const check = await checkAgentLanding(s, args); landingChecks.push(check); return check; },
          prepare: async args => prepareAgentSelection(s, args, await find(args))
        }, { project: decodeURIComponent(s.projectId) });
        if (asksLanding) s.agentPending = null;
        const reply = asksLanding
          ? landingChecks.length ? landingChecks.map(agentLandingReply).join('\n') : '尚未完成变更落地核验，不能判断是否已遴选。请提供来源提交 SHA 和要核对的目标分支后重试。'
          : result.text || (s.agentPending ? '已准备遴选清单，请核对后点击确认。' : '模型未返回文字，请换一个支持工具调用的模型重试。');
        s.agentHistory = [...messages, { role: 'assistant', content: reply }].slice(-12);
        const p = s.agentPending;
        json(res, 200, { reply, toolsUsed: result.toolsUsed, proposal: p ? { id: p.id, source: p.source, target: p.target, criteria: p.criteria, commits: p.commits, expiresAt: p.expiresAt } : null });
      } catch (e) { s.agentPending = null; console.error('Agent 对话失败：', e?.name || 'Error'); throw new Error('Agent 请求失败，请检查 AI 模型是否支持工具调用以及网关状态'); }
      finally { s.agentRunning = false; }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/agent/confirm') {
      const input = await body(req), p = s.agentPending;
      if (!p || input.proposalId !== p.id || Date.now() > p.expiresAt) throw new Error('遴选清单已失效，请重新让 Agent 查询');
      s.agentPending = null;
      const result = await batchCherryPick(s, { mode: 'gitlab-api', source: p.source, target: p.target, commits: p.commits.map(c => c.id), expectedHead: p.targetHead });
      const summary = result.stopped ? `已遴选 ${result.completed.length}/${p.commits.length} 条；在 ${result.stopped.commit.slice(0,8)} 停止：${result.stopped.error}` : `已将 ${result.completed.length} 条提交遴选到 ${p.target}`;
      s.agentHistory = [...(s.agentHistory || []), { role: 'assistant', content: summary }].slice(-12);
      json(res, 200, { ...result, summary }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/agent/cancel') {
      s.agentPending = null; json(res, 200, { ok: true }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/branches') { json(res, 200, { branches: await branches(s) }); return; }
    if (req.method === 'GET' && url.pathname === '/api/target-status') { json(res, 200, await targetStatus(s, url.searchParams.get('target'))); return; }
    if (req.method === 'GET' && url.pathname === '/api/operations') { json(res, 200, { operations: await operations(s) }); return; }
    if (req.method === 'GET' && url.pathname === '/api/landings') { json(res, 200, await landings(s, url.searchParams.get('commit'))); return; }
    if (req.method === 'GET' && url.pathname === '/api/branch-commits') { json(res, 200, await branchCommits(s, url.searchParams.get('branch'), Number(url.searchParams.get('page') || 1))); return; }
    if (req.method === 'GET' && url.pathname === '/api/commits') { json(res, 200, await commits(s, url.searchParams.get('target'), url.searchParams.get('source'), Number(url.searchParams.get('page') || 1), url.searchParams.get('onlyMissing') !== '0')); return; }
    if (req.method === 'GET' && url.pathname === '/api/diff') {
      const d = await diff(s, url.searchParams.get('target'), url.searchParams.get('source'), url.searchParams.get('commit'));
      json(res, 200, { fingerprint: d.fingerprint, files: d.files.map(f => ({ path: f.path, unsupported: f.unsupported, hunks: f.hunks.map(h => ({ id: h.id, text: h.text })) })) }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/check') {
      const input = await body(req);
      if (input.mode !== 'gitlab-api') throw new Error('页面版本已更新，请刷新后再检查');
      const { target, commit } = await selection(s, input);
      json(res, 200, await cherryPick(s, target, commit, true)); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/create') {
      const input = await body(req);
      if (input.mode !== 'gitlab-api') throw new Error('页面版本已更新，请刷新后再执行直接遴选');
      const { target, commit, targetOid } = await selection(s, input);
      const release = acquireTarget(s, target);
      try {
        const permission = await targetStatus(s, target);
        if (!permission.canPush) throw new Error(`当前账号不能直接写入目标分支 ${target}`);
        if (permission.head !== targetOid) throw new Error('目标分支已更新，请重新检查提交');
        await cherryPick(s, target, commit, true);
        if ((await targetStatus(s, target)).head !== targetOid) throw new Error('目标分支在检查后发生变化，请重新检查提交');
        let result;
        try { result = await cherryPick(s, target, commit, false); }
        catch (e) { await saveResult(s, { status: e.code === 'uncertain' ? 'unknown' : 'failed', target, source: input.source, sourceCommit: commit, title: s.commitTitles?.get(commit) || '', code: e.code || 'error' }); throw e; }
        const recordSaved = await saveResult(s, { status: 'success', target, source: input.source, sourceCommit: commit, resultCommit: result.commit, title: s.commitTitles?.get(commit) || '', webUrl: result.webUrl });
        json(res, 200, { ...result, target, pushed: true, recordSaved }); return;
      } finally { release(); }
    }
    if (req.method === 'POST' && url.pathname === '/api/batch') { json(res, 200, await batchCherryPick(s, await body(req))); return; }
    if (req.method === 'POST' && url.pathname === '/api/disconnect') {
      sessions.delete(req.headers['x-session-id']); json(res, 200, { ok: true }); return;
    }
    json(res, 404, { error: '接口不存在' });
  } catch (e) { fail(res, e); }
}
const server = http.createServer(route);
server.listen(port, '127.0.0.1', () => {
  const address = `http://127.0.0.1:${port}/`;
  console.log(`GitLab 提交遴选工具：${address}`);
  if (process.env.PICKLAB_OPEN_BROWSER === '1' && process.platform === 'win32') {
    const opener = spawn('explorer.exe', [address], { detached: true, stdio: 'ignore', windowsHide: true });
    opener.on('error', e => console.error(`无法自动打开浏览器，请手动访问 ${address}：${e.message}`));
    opener.unref();
  }
});
