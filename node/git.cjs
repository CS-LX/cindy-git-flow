'use strict';
const { runCommand: run } = require('./command.cjs');
const { StringDecoder } = require('node:string_decoder');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');
async function git(dir, args, options = {}) {
  try {
    const { stdout } = await run('git', ['--no-pager', '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', '-C', dir, ...args], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 15000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, ...options
    });
    return stdout;
  } catch (e) {
    const error = new Error(gitError(e, args.includes('fetch')));
    error.code = e.code;
    throw error;
  }
}
async function optional(dir, args) { try { return (await git(dir, args)).trim(); } catch (e) { if (e.code === 1 || e.code === 128) return null; throw e; } }
async function root(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('请选择本机仓库文件夹。');
  const base = await fs.realpath(dir);
  return (await git(base, ['rev-parse', '--show-toplevel'])).trim();
}
function canonicalRemote(raw) {
  try {
    if (/^[^/@:]+@[^/:]+:/.test(raw)) raw = 'ssh://' + raw.replace(':', '/');
    const u = new URL(raw);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(u.protocol)) return null;
    return u.hostname.toLowerCase() + (u.port ? ':' + u.port : '') + u.pathname.replace(/\/$/, '').replace(/\.git$/, '');
  } catch { return null; }
}
function displayRemote(raw) {
  try { const u = new URL(raw); u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return u.toString(); }
  catch { return raw.replace(/^[^@]+@/, '').slice(0, 400); }
}
function parseStatus(raw, fileLimit = 300) {
  const parts = raw.split('\0'); const files = [];
  for (let i = 0; i < parts.length; i++) {
    const row = parts[i]; if (!row) continue;
    const type = row[0]; if (type === '#' || type === '!') continue;
    const fields = row.split(' ');
    if (type === '?') files.push({ status: '??', path: row.slice(2), untracked: true, conflict: false });
    else if (type === '1' || type === '2' || type === 'u') {
      const offset = type === '1' ? 8 : type === '2' ? 9 : 10;
      files.push({ status: fields[1], path: fields.slice(offset).join(' '), ...(type === '2' ? { from: parts[++i] } : {}), untracked: false, conflict: type === 'u' });
    }
  }
  return { count: files.length, conflicts: files.filter(f => f.conflict).length, staged: files.filter(f => !f.untracked && f.status[0] !== '.').length, unstaged: files.filter(f => !f.untracked && !f.conflict && f.status[1] !== '.').length, untracked: files.filter(f => f.untracked).length, files: files.slice(0, fileLimit), truncated: files.length > fileLimit };
}
function parseNumstat(raw) {
  const files = [];
  for (const row of raw.split('\0')) {
    const match = row.match(/^(\d+|-)\t(\d+|-)\t([\s\S]+)$/);
    if (match) files.push({ path: match[3], add: Number(match[1]) || 0, remove: Number(match[2]) || 0, binary: match[1] === '-' || match[2] === '-' });
  }
  return files;
}
function workspacePath(dir, name) {
  if (typeof name !== 'string' || !name || name.includes('\0') || path.isAbsolute(name) || !path.resolve(dir, name).startsWith(dir + path.sep)) throw new Error('请选择仓库内的有效相对文件路径。');
  return path.resolve(dir, name);
}
async function readWorkspaceFile(dir, name, maxBytes, skipLarge = false) {
  const target = workspacePath(dir, name);
  const stat = await fs.lstat(target);
  if (!stat.isFile()) throw new Error('只能预览普通文件。');
  if (!(await fs.realpath(target)).startsWith(dir + path.sep)) throw new Error('文件路径超出仓库范围。');
  if (skipLarge && stat.size > maxBytes) return { data: Buffer.alloc(0), truncated: true };
  const file = await fs.open(target, require('node:fs').constants.O_RDONLY | require('node:fs').constants.O_NOFOLLOW);
  try {
    const current = await file.stat();
    if (!current.isFile() || current.ino !== stat.ino || current.dev !== stat.dev) throw new Error('文件已变更，请刷新后重试。');
    const data = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    return { data: data.subarray(0, Math.min(bytesRead, maxBytes)), truncated: bytesRead > maxBytes };
  } finally { await file.close(); }
}
function lineCount(text) { return text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0; }
async function workspaceStatus(dir, statusText, stagedText, unstagedText, fileLimit = 300) {
  const status = parseStatus(statusText, fileLimit);
  const stagedStats = new Map(parseNumstat(stagedText || '').map(f => [f.path, f]));
  const unstagedStats = new Map(parseNumstat(unstagedText || '').map(f => [f.path, f]));
  let inspectedUntracked = 0;
  for (const file of status.files) {
    const staged = stagedStats.get(file.path), unstaged = unstagedStats.get(file.path);
    // With --no-renames the old name is a separate deletion. Attribute it to
    // the single renamed status entry rather than silently dropping its lines.
    const fromStaged = file.from && file.status[0] === 'R' ? stagedStats.get(file.from) : null;
    const fromUnstaged = file.from && file.status[1] === 'R' ? unstagedStats.get(file.from) : null;
    Object.assign(file, { stagedAdd: staged?.add || 0, stagedRemove: (staged?.remove || 0) + (fromStaged?.remove || 0), unstagedAdd: unstaged?.add || 0, unstagedRemove: (unstaged?.remove || 0) + (fromUnstaged?.remove || 0), untrackedAdd: 0, binary: !!(staged?.binary || unstaged?.binary || fromStaged?.binary || fromUnstaged?.binary) });
    if (file.untracked && inspectedUntracked++ < 30) {
      try {
        const { data, truncated } = await readWorkspaceFile(dir, file.path, 131072, true);
        file.binary = data.subarray(0, 4096).includes(0);
        if (!truncated && !file.binary) file.untrackedAdd = lineCount(data.toString('utf8'));
      } catch { /* A disappearing, inaccessible or symbolic file has no estimate. */ }
    }
    file.add = file.stagedAdd + file.unstagedAdd + file.untrackedAdd;
    file.remove = file.stagedRemove + file.unstagedRemove;
  }
  status.additions = status.files.reduce((n, file) => n + file.add, 0);
  status.deletions = status.files.reduce((n, file) => n + file.remove, 0);
  return status;
}
async function resolve(dir, ref) {
  if (typeof ref !== 'string' || !ref || ref.length > 1024) throw new Error('请选择有效分支或提交。');
  return (await git(dir, ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}'])).trim();
}
async function snapshot(input, attempt = 0) {
  const dir = await root(typeof input === 'string' ? input : input?.dir);
  const requestedLimit = Number.isInteger(input?.limit) ? input.limit : 180;
  const limit = Math.max(180, Math.min(2000, requestedLimit));
  const startHead = await optional(dir, ['rev-parse', '--verify', 'HEAD']);
  const branch = await optional(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const [statusText, refText, remoteNames, worktreeText, userName, stagedText, unstagedText] = await Promise.all([
    git(dir, ['status', '--porcelain=v2', '-z', '--untracked-files=normal']),
    git(dir, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(symref)%00%(authorname)%00%(committerdate:iso-strict)%00%(subject)%00%(upstream)', 'refs/heads', 'refs/remotes']),
    git(dir, ['remote']), git(dir, ['worktree', 'list', '--porcelain', '-z']), optional(dir, ['config', 'user.name']),
    git(dir, ['diff', '--cached', '--numstat', '--no-renames', '-z', '--no-ext-diff', '--no-textconv']).catch(e => { if (!startHead && e.code === 128) return ''; throw e; }),
    git(dir, ['diff', '--numstat', '--no-renames', '-z', '--no-ext-diff', '--no-textconv']).catch(e => { if (!startHead && e.code === 128) return ''; throw e; })
  ]);
  const status = await workspaceStatus(dir, statusText, stagedText, unstagedText);
  const refs = refText.trim().split('\n').filter(Boolean).map(line => {
    const [full, sha, upstream, symref, author, date, subject, upstreamFull] = line.split('\0');
    return { full, sha, name: full.replace(/^refs\/(heads|remotes)\//, ''), remote: full.startsWith('refs/remotes/'), upstream, upstreamFull, symref, author, date, subject };
  }).filter(r => !r.symref);
  const remotes = await Promise.all(remoteNames.trim().split('\n').filter(Boolean).map(async name => {
    const url = (await git(dir, ['remote', 'get-url', name])).trim();
    return { name, url: displayRemote(url), identity: canonicalRemote(url) };
  }));
  const readLog = async (revisions, count = limit) => {
    const log = await git(dir, ['log', ...revisions, '--topo-order', '-n', String(count), '-z', '--format=%H%x00%P%x00%an%x00%aI%x00%s']);
    const fields = log.split('\0'), rows = [];
    for (let i = 0; i + 4 < fields.length; i += 5) rows.push({ sha: fields[i], parents: fields[i + 1].split(' ').filter(Boolean), author: fields[i + 2], date: fields[i + 3], subject: fields[i + 4] });
    return rows;
  };
  // Read HEAD history separately: filtering the global 180 rows would lose older current-branch commits.
  const [commits, currentCommits] = await Promise.all([
    // Exclude only the traversal root: stash objects also reachable through
    // a normal ref or HEAD must remain visible.
    readLog(['--exclude=refs/stash', '--all', ...(startHead ? [startHead] : [])]),
    startHead ? readLog([startHead]) : []
  ]);
  const current = refs.find(r => r.full === 'refs/heads/' + branch);
  const upstreamSha = current?.upstreamFull ? await optional(dir, ['rev-parse', '--verify', '--end-of-options', current.upstreamFull + '^{commit}']) : null;
  let ahead = null, behind = null;
  if (startHead && upstreamSha) {
    [ahead, behind] = (await git(dir, ['rev-list', '--left-right', '--count', startHead + '...' + upstreamSha])).trim().split(/\s+/).map(Number);
  }
  // Outgoing history is independent of the 180-row graph window. Keep the
  // payload bounded for huge unpublished histories; ahead remains exact.
  const outgoingLimit = 5000;
  const [outgoingCommits, stashText] = await Promise.all([
    startHead && upstreamSha && ahead ? readLog([upstreamSha + '..' + startHead], outgoingLimit) : [],
    git(dir, ['stash', 'list', '-z', '--format=%H%x00%s%x00%aI'])
  ]);
  const stashFields = stashText.split('\0'), stashes = [];
  for (let i = 0; i + 2 < stashFields.length; i += 3) {
    stashes.push({ sha: stashFields[i], subject: stashFields[i + 1], date: stashFields[i + 2] });
  }
  const worktrees = []; let wt = {};
  for (const line of worktreeText.split('\0')) {
    if (!line) { if (wt.path) worktrees.push(wt); wt = {}; }
    else if (line.startsWith('worktree ')) wt.path = line.slice(9);
    else if (line.startsWith('HEAD ')) wt.sha = line.slice(5);
    else if (line.startsWith('branch ')) wt.branch = line.slice(7).replace('refs/heads/', '');
    else if (line === 'detached') wt.detached = true;
  }
  let fetchedAt = null;
  try { const p = (await git(dir, ['rev-parse', '--git-path', 'FETCH_HEAD'])).trim(); fetchedAt = (await fs.stat(path.resolve(dir, p))).mtime.toISOString(); } catch {}
  const endHead = await optional(dir, ['rev-parse', '--verify', 'HEAD']);
  const endBranch = await optional(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if ((startHead !== endHead || branch !== endBranch) && attempt < 1) return snapshot(dir, attempt + 1);
  return { dir, name: path.basename(dir), branch, head: startHead, detached: !!startHead && !branch, unborn: !startHead, userName, status, refs, commits, currentCommits, stashes, outgoingCommits, outgoingTruncated: ahead > outgoingLimit, currentTruncated: currentCommits.length === limit, remotes, worktrees, upstream: current?.upstream || null, upstreamExists: !!upstreamSha, ahead, behind, fetchedAt, sampledAt: new Date().toISOString(), unstable: startHead !== endHead || branch !== endBranch, truncated: commits.length === limit, historyLimit: limit };
}
function addedFileDiff(name, text) {
  const header = 'diff --git ' + JSON.stringify('a/' + name) + ' ' + JSON.stringify('b/' + name) + '\n';
  const count = lineCount(text);
  if (!count) return header + 'new file mode 100644\n';
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return header + 'new file mode 100644\n--- /dev/null\n+++ ' + JSON.stringify('b/' + name) + '\n@@ -0,0 +1,' + count + ' @@\n' + lines.map(line => '+' + line + '\n').join('') + (text.endsWith('\n') ? '' : '\\ No newline at end of file\n');
}
function compressWorkspaceDiff(raw, limit) {
  const grouped = new Map();
  for (const block of raw.split(/(?=^diff --git )/m).filter(Boolean)) {
    const lines = block.split('\n');
    if (!lines[0].startsWith('diff --git ')) continue;
    const pathLine = lines.find(line => line.startsWith('+++ ') && line !== '+++ /dev/null') || lines.find(line => line.startsWith('--- '));
    let name = pathLine ? pathLine.slice(4) : lines[0].replace(/^diff --git .*? ("b\/.*"|b\/.*)$/, '$1');
    if (name.startsWith('"')) { try { name = JSON.parse(name); } catch { /* Retain Git's quoted name if it uses octal escapes. */ } }
    name = name.replace(/^[ab]\//, '').replace(/[\r\n]/g, character => character === '\n' ? '\\n' : '\\r');
    let hunk = false;
    const content = [];
    for (const line of lines.slice(1)) {
      if (line.startsWith('@@')) hunk = true;
      if (line.startsWith('\\ No newline')) continue;
      if (!hunk && /^(index |--- |\+\+\+ |new file mode |deleted file mode |similarity index |rename (from|to) )/.test(line)) continue;
      if (/^(@@|[+ -]|Binary files |GIT binary patch|# 二进制)/.test(line)) content.push(line);
    }
    const text = content.join('\n') + (content.length ? '\n' : '');
    grouped.set(name, (grouped.get(name) || '## 文件：' + name + '\n') + text);
  }
  const blocks = [...grouped.values()];
  const reserve = ('# 仍有 ' + blocks.length + ' 个文件未包含。\n').length;
  const capacity = limit - reserve;
  const omittedContent = '\n# 该文件内容已省略部分。\n';
  let text = '', includedFiles = 0, truncated = false;
  for (const [index, block] of blocks.entries()) {
    const available = capacity - text.length;
    if (available < Math.min(240, block.length)) break;
    // Reserve a useful sample for later files before expanding an early one.
    const budget = Math.min(1200, available, Math.max(240, available - (blocks.length - index - 1) * 240));
    if (block.length > budget) {
      text += block.slice(0, budget - omittedContent.length) + omittedContent;
      truncated = true;
    } else text += block;
    includedFiles++;
  }
  if (includedFiles < blocks.length) {
    text += '# 仍有 ' + (blocks.length - includedFiles) + ' 个文件未包含。\n';
    truncated = true;
  }
  return { text, truncated, includedFiles };
}
async function workspaceDiff(input, limit = 26000) {
  const dir = await root(typeof input === 'string' ? input : input?.dir);
  limit = Math.max(8000, Math.min(80000, Number.isFinite(limit) ? Math.floor(limit) : 26000));
  const head = await optional(dir, ['rev-parse', '--verify', 'HEAD']);
  const flags = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames'];
  const [body, raw, staged, unstaged] = await Promise.all([
    head ? git(dir, ['diff', head, ...flags]) : Promise.all([git(dir, ['diff', '--cached', ...flags]), git(dir, ['diff', ...flags])]).then(parts => parts.join('')),
    git(dir, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
    git(dir, ['diff', '--cached', '--numstat', '--no-renames', '-z', '--no-ext-diff', '--no-textconv']),
    git(dir, ['diff', '--numstat', '--no-renames', '-z', '--no-ext-diff', '--no-textconv'])
  ]);
  const status = await workspaceStatus(dir, raw, staged, unstaged, Infinity);
  let text = body;
  for (const file of status.files.filter(f => f.untracked).slice(0, 30)) {
    try {
      const { data, truncated } = await readWorkspaceFile(dir, file.path, 131072, true);
      if (truncated || data.subarray(0, 4096).includes(0)) text += 'diff --git ' + JSON.stringify('a/' + file.path) + ' ' + JSON.stringify('b/' + file.path) + '\n# 二进制或过大的未跟踪文件，未包含内容\n';
      else text += addedFileDiff(file.path, data.toString('utf8'));
    } catch { /* Never follow a symlink or include a file that disappeared. */ }
  }
  const compressed = compressWorkspaceDiff(text, limit);
  return { ...compressed, bytes: Buffer.byteLength(compressed.text, 'utf8'), files: status.count, additions: status.additions, deletions: status.deletions };
}
async function workspace(input, options = {}) {
  const dir = await root(typeof input === 'string' ? input : input?.dir);
  if (options?.path !== undefined) {
    workspacePath(dir, options.path);
    const scope = options.scope || 'all';
    if (!['staged', 'unstaged', 'untracked', 'all'].includes(scope)) throw new Error('请选择有效的变更范围。');
    let output = '', fileTruncated = false;
    if (scope === 'untracked') {
      const { data, truncated } = await readWorkspaceFile(dir, options.path, 180000);
      fileTruncated = truncated;
      if (data.includes(0)) return { path: options.path, scope, patch: '', truncated, binary: true };
      const text = data.toString('utf8'), count = lineCount(text);
      if (count) {
        const lines = text.split('\n');
        if (text.endsWith('\n')) lines.pop();
        output = 'diff --git ' + JSON.stringify('a/' + options.path) + ' ' + JSON.stringify('b/' + options.path) + '\nnew file mode 100644\n--- /dev/null\n+++ ' + JSON.stringify('b/' + options.path) + '\n@@ -0,0 +1,' + count + ' @@\n' + lines.map(line => '+' + line + '\n').join('') + (text.endsWith('\n') ? '' : '\\ No newline at end of file\n');
      }
    } else {
      const diff = revisions => git(dir, ['--literal-pathspecs', 'diff', ...revisions, '--no-ext-diff', '--no-textconv', '--no-color', '--', options.path]);
      if (scope === 'staged') output = await diff(['--cached']);
      else if (scope === 'unstaged') output = await diff([]);
      else {
        const head = await optional(dir, ['rev-parse', '--verify', 'HEAD']);
        output = head ? await diff([head]) : (await Promise.all([diff(['--cached']), diff([])])).join('');
      }
    }
    return { path: options.path, scope, patch: output.slice(0, 120000), truncated: fileTruncated || output.length > 120000, binary: /Binary files /.test(output) };
  }
  if (options?.stash) {
    const sha = await resolve(dir, options.stash);
    await resolve(dir, sha + '^1');
    const third = await optional(dir, ['rev-parse', '--verify', '--quiet', sha + '^3^{commit}']);
    const [stats, patch, untrackedStats, untrackedPatch] = await Promise.all([
      git(dir, ['diff', '--numstat', '--no-renames', '-z', '--no-ext-diff', '--no-textconv', sha + '^1', sha]),
      git(dir, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', sha + '^1', sha]),
      third ? git(dir, ['diff-tree', '--root', '--numstat', '--no-renames', '-r', '-z', '--no-ext-diff', '--no-textconv', third]) : '',
      third ? git(dir, ['diff-tree', '--root', '-p', '-r', '--no-ext-diff', '--no-textconv', '--no-color', third]) : ''
    ]);
    const files = [...parseNumstat(stats).map(f => ({ ...f, untracked: false })), ...parseNumstat(untrackedStats).map(f => ({ ...f, untracked: true }))];
    const combined = patch + untrackedPatch;
    return { sha, files, additions: files.reduce((n, f) => n + f.add, 0), deletions: files.reduce((n, f) => n + f.remove, 0), patch: combined.slice(0, 120000), truncated: combined.length > 120000 };
  }
  throw new Error('请选择工作区文件或 Stash 备份。');
}
async function detail(input, ref) {
  const dir = await root(input); const sha = await resolve(dir, ref);
  const output = await git(dir, ['show', '--format=fuller', '--stat', '--patch', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', sha, '--'], { maxBuffer: 16 * 1024 * 1024 });
  return { sha, patch: output.slice(0, 180000), truncated: output.length > 180000 };
}
async function compare(input, target) {
  const dir = await root(input);
  const [head, other, state] = await Promise.all([resolve(dir, 'HEAD'), resolve(dir, target), git(dir, ['status', '--porcelain=v2', '-z'])]);
  const counts = (await git(dir, ['rev-list', '--left-right', '--count', head + '...' + other])).trim().split(/\s+/).map(Number);
  const base = await optional(dir, ['merge-base', head, other]);
  const diff = await git(dir, ['diff', '--stat', '--no-ext-diff', '--no-textconv', head, other, '--']);
  const dirty = parseStatus(state);
  return { head, target, targetSha: other, ahead: counts[0], behind: counts[1], base, dirty: dirty.count, relation: !base ? 'unrelated' : head === other ? 'equal' : base === head ? 'fast-forward' : base === other ? 'contains' : 'diverged', diff: diff.slice(0, 40000), note: '这是提交关系预览；未执行切换或合并，也未判定文本冲突。' };
}
function gitError(e, network = false) {
  const stderr = String(e.stderr || '');
  if (e.code === 'ENOENT') return '找不到 Git，请先安装 Git 后重新连接仓库。';
  if (e.killed) return network ? '远端获取超过 14 分钟，已停止本次下载；请检查网络后重试。' : '本地仓库读取超时，请稍后刷新。';
  if (!network) return 'Git 操作失败，请确认仓库路径和分支是否仍存在。';
  if (/authentication failed|permission denied|could not read Username|terminal prompts disabled|HTTP.*\b(?:401|403)\b/i.test(stderr)) return '远端访问未获授权，请先在终端登录 Git 或检查仓库权限，再点击立即更新。';
  if (/repository not found|does not appear to be a git repository/i.test(stderr)) return '远端仓库不存在或当前账号无权访问，请检查远端地址和账号权限。';
  if (/could not resolve|couldn't resolve|name or service not known/i.test(stderr)) return '无法解析远端地址，请检查网络或代理后重试。';
  if (/certificate|SSL.*(?:error|problem)/i.test(stderr)) return '远端安全连接失败，请检查系统证书或代理设置后重试。';
  if (/timed out|timeout|operation too slow/i.test(stderr)) return '远端连接超时或下载长时间无响应，已停止本次获取；请检查网络或代理后重试。';
  if (/failed to connect|connection refused|connection reset|unable to access|remote end hung up|unexpected disconnect|early EOF/i.test(stderr)) return '远端连接中断，请检查网络或代理后重试。';
  return '远端获取失败，请检查网络、远端地址和账号权限后重试。';
}
function progressReader(notify) {
  const decoder = new StringDecoder('utf8'); let pending = '';
  const phases = { Counting: 'counting', Compressing: 'compressing', Receiving: 'receiving', Resolving: 'resolving' };
  return buf => {
    pending += decoder.write(buf);
    const lines = pending.split(/[\r\n]/); pending = lines.pop().slice(-2048);
    for (const line of lines) {
      const match = line.match(/(Counting|Compressing|Receiving|Resolving) (?:objects|deltas):\s*(\d+)%/);
      if (!match) continue;
      const size = line.match(/,\s*([\d.]+) (KiB|MiB|GiB)\s*\|/);
      notify({ phase: phases[match[1]], percent: Math.min(100, Number(match[2])), ...(size ? { bytes: Math.round(Number(size[1]) * { KiB: 1024, MiB: 1048576, GiB: 1073741824 }[size[2]]) } : {}) });
    }
  };
}
const fetches = new Map();
async function fetchRemote(input, remote, notify = () => {}) {
  const dir = await root(input); const names = (await git(dir, ['remote'])).trim().split('\n');
  if (typeof remote !== 'string' || !names.includes(remote) || remote.startsWith('-')) throw new Error('请选择仓库中已有的远端。');
  const key = JSON.stringify([dir, remote]);
  let task = fetches.get(key);
  if (!task) {
    task = { listeners: new Set(), latest: { dir, remote, phase: 'connecting' }, lastSent: 0 };
    fetches.set(key, task);
    const publish = (value, force = false) => {
      task.latest = { dir, remote, ...value };
      if (!force && Date.now() - task.lastSent < 1000) return;
      task.lastSent = Date.now(); for (const listener of task.listeners) listener(task.latest);
    };
    task.promise = (async () => {
      const heartbeat = setInterval(() => publish(task.latest, true), 10000);
      try {
        const ssh = await optional(dir, ['config', '--get', 'core.sshCommand']);
        const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C' };
        if (!ssh && !env.GIT_SSH_COMMAND && !env.GIT_SSH) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4';
        await git(dir, ['-c', 'fetch.recurseSubmodules=false', '-c', 'http.lowSpeedLimit=1024', '-c', 'http.lowSpeedTime=60', 'fetch', '--no-tags', '--no-auto-maintenance', '--progress', '--', remote], { timeout: 840000, env, onStderr: progressReader(publish) });
        const fetchCompletedAt = new Date().toISOString();
        publish({ phase: 'reading' }, true);
        try { return { ...await snapshot(dir), fetchCompletedAt, fetchedRemote: remote }; }
        catch (e) { throw new Error('远端记录已获取，但本地视图未能刷新。' + e.message); }
      } finally { clearInterval(heartbeat); fetches.delete(key); }
    })();
  }
  task.listeners.add(notify); notify(task.latest);
  try { return await task.promise; } finally { task.listeners.delete(notify); }
}
module.exports = { git, root, snapshot, detail, compare, workspace, workspaceDiff, fetchRemote, parseStatus, canonicalRemote, hash, gitError, progressReader };
