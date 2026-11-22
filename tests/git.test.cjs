'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const repo = require('../node/git.cjs');
const { layout } = require('../graph.js');
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'git-flow-test-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await repo.git(dir,['init','-b','main']); await repo.git(dir,['config','user.name','测试者']); await repo.git(dir,['config','user.email','test@example.invalid']);
  return dir;
}
async function commit(dir,file,text,message) { await fs.writeFile(path.join(dir,file),text); await repo.git(dir,['add','--',file]); await repo.git(dir,['commit','-m',message]); return (await repo.git(dir,['rev-parse','HEAD'])).trim(); }
test('empty repo, unicode file, staged rename and detached HEAD',async t=>{
  const dir=await fixture(t); let s=await repo.snapshot(dir);assert.equal(s.unborn,true);assert.equal(s.branch,'main');assert.deepEqual(s.commits,[]);
  await commit(dir,'名字 with spaces.txt','hello','首次提交');
  await repo.git(dir,['mv','名字 with spaces.txt','新文件.txt']);
  s=await repo.snapshot(dir);assert.equal(s.status.count,1);assert.equal(s.status.files[0].from,'名字 with spaces.txt');assert.equal(s.status.files[0].path,'新文件.txt');
  await repo.git(dir,['commit','-m','rename']); await repo.git(dir,['checkout','--detach']);s=await repo.snapshot(dir);assert.equal(s.detached,true);assert.equal(s.branch,null);
  await assert.rejects(repo.detail(dir,'--output=/tmp/evil'));
});
test('divergence, merge graph, diff, worktree and clean read-only snapshots',async t=>{
  const dir=await fixture(t);const base=await commit(dir,'base','base','base');
  await repo.git(dir,['checkout','-b','feature']);const feature=await commit(dir,'feature','feature','feature');
  await repo.git(dir,['checkout','main']);await commit(dir,'main','main','main');
  let c=await repo.compare(dir,'feature');assert.equal(c.relation,'diverged');assert.equal(c.ahead,1);assert.equal(c.behind,1);assert.equal(c.base,base);
  const before=await repo.git(dir,['status','--porcelain=v2','-z']);const branchState=await repo.snapshot(dir);assert(!branchState.currentCommits.some(c=>c.sha===feature));assert.equal(await repo.git(dir,['status','--porcelain=v2','-z']),before);
  await repo.git(dir,['merge','--no-ff','feature','-m','merge']);
  const wt=dir+'-worktree';t.after(()=>fs.rm(wt,{recursive:true,force:true}));await repo.git(dir,['worktree','add',wt,'feature']);
  const s=await repo.snapshot(dir);assert.equal(s.worktrees.length,2);assert.equal(s.commits[0].parents.length,2);assert(s.currentCommits.some(c=>c.sha===feature));assert.equal(s.currentCommits[0].parents.length,2);
  const g=layout(s.commits);assert.equal(g.links.length,s.commits.reduce((n,c)=>n+c.parents.length,0));
  for(const edge of g.links){assert(s.commits[edge.fromRow].parents.includes(edge.to));if(!edge.boundary){assert.equal(s.commits[edge.toRow].sha,edge.to);assert(edge.toRow>edge.fromRow);assert.equal(g.rows[edge.toRow].lane,edge.toLane);}}
  const d=await repo.detail(dir,feature);assert(d.patch.includes('+feature'));c=await repo.compare(dir,'feature');assert.equal(c.relation,'contains');
});
test('fetch updates cached refs without changing worktree or HEAD',async t=>{
  const dir=await fixture(t);await commit(dir,'file','one','one');
  const clone=dir+'-clone';t.after(()=>fs.rm(clone,{recursive:true,force:true}));await repo.git(dir,['clone',dir,clone]);
  const before=await repo.snapshot(clone);await commit(dir,'file','two','two');const after=await repo.fetchRemote(clone,'origin');
  assert.equal(before.head,after.head);assert.equal(after.behind,1);assert.equal(after.fetchedRemote,'origin');assert(Number.isFinite(Date.parse(after.fetchCompletedAt)));assert.equal(await fs.readFile(path.join(clone,'file'),'utf8'),'one');
  await assert.rejects(repo.fetchRemote(clone,'--all'));
});
test('remote identity removes secrets and normalizes SSH/HTTPS',()=>{
 assert.equal(repo.canonicalRemote('git@github.com:Team/repo.git'),'github.com/Team/repo');
 assert.equal(repo.canonicalRemote('https://user:secret@github.com/Team/repo.git'),'github.com/Team/repo');
 assert.equal(repo.canonicalRemote('/tmp/repo'),null);
});
test('boundary graph retains parent beyond visible window',()=>{
 const g=layout([{sha:'a',parents:['b','c']},{sha:'b',parents:['z']}]);assert.equal(g.links.filter(e=>e.boundary).length,2);
});
test('分叉分支沿自己的泳道走到父提交才汇入，不和主干叠线', () => {
  // main: m2 → m1 → base；feature: f1 → base
  const g = layout([{ sha: 'm2', parents: ['m1'] }, { sha: 'f1', parents: ['base'] }, { sha: 'm1', parents: ['base'] }, { sha: 'base', parents: [] }]);
  const lane = sha => g.rows.find(r => r.sha === sha).lane;
  assert.notEqual(lane('f1'), lane('m1'));
  const fork = g.links.find(l => l.from === 'f1');
  assert.equal(fork.lane, lane('f1'));
  assert.equal(fork.toLane, lane('base'));
  assert.equal(g.reach[2], Math.max(lane('m1'), lane('f1')));
});

test('当前分支读取自己的历史，其他分支超过 180 条也不丢失当前历史', async t => {
  const dir = await fixture(t), base = await commit(dir, 'file', 'base', 'quiet base');
  await repo.git(dir, ['branch', 'quiet']);
  const { spawn } = require('node:child_process');
  const timestamp = Math.floor(Date.now() / 1000);
  const input = Array.from({ length: 200 }, (_, i) => {
    const subject = 'noisy ' + i;
    return 'commit refs/heads/main\nmark :' + (i + 1) + '\nauthor Test <test@example.invalid> ' + (timestamp + i) + ' +0000\ncommitter Test <test@example.invalid> ' + (timestamp + i) + ' +0000\ndata ' + subject.length + '\n' + subject + '\nfrom ' + (i ? ':' + i : base) + '\nM 100644 inline file\ndata 1\nx\n\n';
  }).join('');
  await new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', dir, 'fast-import', '--quiet'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', b => stderr += b); child.on('error', reject); child.on('close', code => code ? reject(new Error(stderr)) : resolve()); child.stdin.end(input);
  });
  await repo.git(dir, ['checkout', 'quiet']);
  const before = await repo.git(dir, ['status', '--porcelain=v2', '-z']);
  const state = await repo.snapshot(dir);
  assert.equal(state.commits.length, 180); assert.equal(state.truncated, true);
  assert(!state.commits.some(c => c.sha === base));
  assert.deepEqual(state.currentCommits.map(c => c.sha), [base]); assert.equal(state.currentTruncated, false);
  assert.equal(state.branch, 'quiet'); assert.equal(state.head, base);
  assert.equal(await repo.git(dir, ['status', '--porcelain=v2', '-z']), before);
  await repo.git(dir, ['checkout', '--detach']);
  assert.equal((await repo.snapshot(dir)).currentCommits[0].sha, base);
  await repo.git(dir, ['checkout', '--orphan', 'empty-current']);
  const empty = await repo.snapshot(dir); assert(empty.commits.length > 0); assert.deepEqual(empty.currentCommits, []);
});

test('Cindy session savepoints stay out of the graph unless reachable from project history', async t => {
  const dir = await fixture(t);
  const base = await commit(dir, 'file', 'base', 'base');
  const tree = base + '^{tree}';
  const baseline = (await repo.git(dir, ['commit-tree', tree, '-m', 'baseline'])).trim();
  const saved = (await repo.git(dir, ['commit-tree', tree, '-p', baseline, '-m', 'saved'])).trim();
  await repo.git(dir, ['update-ref', 'refs/cindy/savepoints/test-session', saved]);

  const before = await repo.snapshot(dir);
  assert.deepEqual(before.commits.map(c => c.sha), [base]);

  await repo.git(dir, ['tag', 'keep-baseline', baseline]);
  const after = await repo.snapshot(dir);
  assert.deepEqual(new Set(after.commits.map(c => c.sha)), new Set([base, baseline]));
});

test('stash entries stay separate, including older and untracked stashes; normal refs retain shared objects', async t => {
  const dir = await fixture(t);
  const base = await commit(dir, 'file', 'base', 'base');
  await fs.writeFile(path.join(dir, 'file'), 'first');
  await fs.writeFile(path.join(dir, 'untracked'), 'untracked');
  await repo.git(dir, ['stash', 'push', '-u', '-m', 'first']);
  const first = (await repo.git(dir, ['rev-parse', 'refs/stash'])).trim();
  const auxiliary = (await repo.git(dir, ['rev-parse', first + '^2'])).trim();
  await fs.writeFile(path.join(dir, 'file'), 'second');
  await repo.git(dir, ['stash', 'push', '-m', 'second']);
  let state = await repo.snapshot(dir);
  assert.equal(state.stashes.length, 2);
  assert.deepEqual(state.stashes.map(s => s.subject), ['On main: second', 'On main: first']);
  assert(state.stashes.every(s => Number.isFinite(Date.parse(s.date))));
  assert.deepEqual(state.commits.map(c => c.sha), [base]);
  assert.deepEqual(state.currentCommits.map(c => c.sha), [base]);
  await repo.git(dir, ['branch', 'retained-stash', first]);
  await repo.git(dir, ['tag', 'retained-index', auxiliary]);
  state = await repo.snapshot(dir);
  assert(state.commits.some(c => c.sha === first));
  assert(state.commits.some(c => c.sha === auxiliary));
  await repo.git(dir, ['branch', '-D', 'retained-stash']);
  await repo.git(dir, ['tag', '-d', 'retained-index']);
  await repo.git(dir, ['checkout', '--detach', first]);
  state = await repo.snapshot(dir);
  assert(state.commits.some(c => c.sha === first));
  assert.deepEqual(state.outgoingCommits, []);
});

test('outgoing uses the full upstream ref, handles divergence and merges, and missing upstream', async t => {
  const dir = await fixture(t);
  const base = await commit(dir, 'base', 'base', 'base');
  await repo.git(dir, ['remote', 'add', 'origin', '.']);
  await repo.git(dir, ['update-ref', 'refs/remotes/origin/main', base]);
  await repo.git(dir, ['branch', '--set-upstream-to=origin/main']);
  const synced = await repo.snapshot(dir);
  assert.equal(synced.ahead, 0); assert.equal(synced.behind, 0);
  assert.deepEqual(synced.outgoingCommits, []);
  await repo.git(dir, ['checkout', '-b', 'remote-side']);
  const remote = await commit(dir, 'remote', 'remote', 'remote');
  await repo.git(dir, ['update-ref', 'refs/remotes/origin/main', remote]);
  await repo.git(dir, ['checkout', 'main']);
  const local = await commit(dir, 'local', 'local', 'local');
  // Deliberately collide with the upstream short name.
  await repo.git(dir, ['branch', 'origin/main', local]);
  let state = await repo.snapshot(dir);
  assert.equal(state.ahead, 1); assert.equal(state.behind, 1);
  assert.deepEqual(state.outgoingCommits.map(c => c.sha), [local]);
  await repo.git(dir, ['merge', '--no-ff', 'remote-side', '-m', 'merge remote']);
  state = await repo.snapshot(dir);
  assert.equal(state.ahead, 2); assert.equal(state.behind, 0);
  assert.equal(state.outgoingCommits[0].parents.length, 2);
  assert.deepEqual(state.outgoingCommits.map(c => c.sha), [state.head, local]);
  assert.equal(state.outgoingTruncated, false);
  const unrelated = (await repo.git(dir, ['commit-tree', base + '^{tree}', '-m', 'unrelated root'])).trim();
  await repo.git(dir, ['update-ref', 'refs/remotes/origin/main', unrelated]);
  const disconnected = await repo.snapshot(dir);
  assert.equal(disconnected.behind, 1);
  assert.equal(disconnected.ahead, disconnected.currentCommits.length);
  assert.deepEqual(disconnected.outgoingCommits, disconnected.currentCommits);
  await repo.git(dir, ['update-ref', '-d', 'refs/remotes/origin/main']);
  state = await repo.snapshot(dir);
  assert.equal(state.upstreamExists, false); assert.equal(state.ahead, null);
  assert.deepEqual(state.outgoingCommits, []);
  await repo.git(dir, ['branch', '--unset-upstream']);
  state = await repo.snapshot(dir);
  assert.equal(state.upstream, null); assert.deepEqual(state.outgoingCommits, []);
});

test('outgoing extends beyond the graph window and reports its payload cap', async t => {
  const dir = await fixture(t);
  const base = await commit(dir, 'file', 'base', 'base');
  await repo.git(dir, ['remote', 'add', 'origin', '.']);
  await repo.git(dir, ['update-ref', 'refs/remotes/origin/main', base]);
  await repo.git(dir, ['branch', '--set-upstream-to=origin/main']);
  const { spawn } = require('node:child_process');
  const timestamp = Math.floor(Date.now() / 1000);
  async function importHistory(count, from) {
    const input = Array.from({ length: count }, (_, i) => {
      const subject = 'outgoing ' + i;
      return 'commit refs/heads/main\nmark :' + (i + 1) + '\ncommitter Test <test@example.invalid> ' + (timestamp + i) + ' +0000\ndata ' + subject.length + '\n' + subject + '\nfrom ' + (i ? ':' + i : from) + '\n\n';
    }).join('');
    await new Promise((resolve, reject) => {
      const child = spawn('git', ['-C', dir, 'fast-import', '--quiet'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = ''; child.stderr.on('data', b => stderr += b); child.on('error', reject);
      child.on('close', code => code ? reject(new Error(stderr)) : resolve());
      child.stdin.end(input);
    });
  }
  await importHistory(201, base);
  let state = await repo.snapshot(dir);
  assert.equal(state.commits.length, 180); assert.equal(state.currentCommits.length, 180);
  assert.equal(state.outgoingCommits.length, 201); assert.equal(state.ahead, 201);
  assert.equal(state.outgoingCommits.at(-1).subject, 'outgoing 0');
  assert.equal(state.outgoingTruncated, false);
  await importHistory(4800, state.head);
  state = await repo.snapshot(dir);
  assert.equal(state.ahead, 5001); assert.equal(state.outgoingCommits.length, 5000);
  assert.equal(state.outgoingTruncated, true);
  assert.deepEqual(state.currentCommits.map(c => c.sha), state.outgoingCommits.slice(0, 180).map(c => c.sha));
});

test('workspace statistics separate staged, unstaged, binary and untracked lines', async t => {
  const dir = await fixture(t);
  await commit(dir, 'tracked', 'old\nkeep\n', 'base');
  await fs.writeFile(path.join(dir, 'tracked'), 'staged\nkeep\n');
  await repo.git(dir, ['add', 'tracked']);
  await fs.writeFile(path.join(dir, 'tracked'), 'staged\nkeep\nworking\n');
  await fs.writeFile(path.join(dir, 'new 空格'), 'one\ntwo');
  await fs.writeFile(path.join(dir, 'binary'), Buffer.from([1, 0, 2]));
  await fs.writeFile(path.join(dir, 'big'), 'x'.repeat(131073));
  let state = await repo.snapshot(dir);
  const tracked = state.status.files.find(f => f.path === 'tracked');
  assert.equal(state.status.unstaged, 1);
  assert.equal(tracked.stagedAdd, 1); assert.equal(tracked.stagedRemove, 1);
  assert.equal(tracked.unstagedAdd, 1); assert.equal(tracked.unstagedRemove, 0);
  assert.equal(tracked.add, 2); assert.equal(tracked.remove, 1);
  assert.equal(state.status.files.find(f => f.path.startsWith('new ')).untrackedAdd, 2);
  assert.equal(state.status.files.find(f => f.path === 'binary').binary, true);
  assert.equal(state.status.files.find(f => f.path === 'big').untrackedAdd, 0);
  assert.equal(state.status.additions, 4); assert.equal(state.status.deletions, 1);
  await repo.git(dir, ['add', 'binary']);
  state = await repo.snapshot(dir);
  assert.equal(state.status.files.find(f => f.path === 'binary').binary, true);
  assert.equal(state.status.files.find(f => f.path === 'binary').stagedAdd, 0);
});

test('workspace previews cover scopes, unborn HEAD, literal paths and path boundaries', async t => {
  const dir = await fixture(t);
  await commit(dir, 'tracked', 'old\n', 'base');
  await fs.writeFile(path.join(dir, 'tracked'), 'staged\n');
  await repo.git(dir, ['add', 'tracked']);
  await fs.writeFile(path.join(dir, 'tracked'), 'staged\nworking\n');
  const staged = await repo.workspace(dir, { path: 'tracked', scope: 'staged' });
  const unstaged = await repo.workspace(dir, { path: 'tracked', scope: 'unstaged' });
  const all = await repo.workspace({ dir }, { path: 'tracked' });
  assert(staged.patch.includes('+staged')); assert(!staged.patch.includes('+working'));
  assert(unstaged.patch.includes('+working')); assert(!unstaged.patch.includes('-old'));
  assert(all.patch.includes('-old')); assert(all.patch.includes('+working'));
  await fs.writeFile(path.join(dir, 'new'), 'one\ntwo');
  const untracked = await repo.workspace(dir, { path: 'new', scope: 'untracked' });
  assert(untracked.patch.includes('@@ -0,0 +1,2 @@\n+one\n+two\n'));
  assert(untracked.patch.includes('No newline at end of file'));
  await fs.writeFile(path.join(dir, 'binary'), Buffer.from([0, 1]));
  assert.deepEqual(await repo.workspace(dir, { path: 'binary', scope: 'untracked' }), { path: 'binary', scope: 'untracked', patch: '', binary: true, truncated: false });
  await fs.writeFile(path.join(dir, 'huge'), 'x'.repeat(180001));
  assert.equal((await repo.workspace(dir, { path: 'huge', scope: 'untracked' })).truncated, true);
  for (const name of ['', '../escape', path.join(dir, 'tracked'), 'a/../../escape', 'bad' + String.fromCharCode(0) + 'path', '.']) await assert.rejects(repo.workspace(dir, { path: name }));
  await assert.rejects(repo.workspace(dir, { path: 'tracked', scope: 'invalid' }));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'git-flow-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'secret'), 'private');
  await fs.symlink(path.join(outside, 'secret'), path.join(dir, 'link'));
  await fs.symlink(outside, path.join(dir, 'outside'));
  await assert.rejects(repo.workspace(dir, { path: 'link', scope: 'untracked' }));
  await assert.rejects(repo.workspace(dir, { path: 'outside/secret', scope: 'untracked' }));
  assert.equal((await repo.workspace(dir, { path: ':(glob)**' })).patch, '');
  const unborn = await fixture(t);
  await fs.writeFile(path.join(unborn, 'new'), 'staged\n');
  await repo.git(unborn, ['add', 'new']);
  await fs.writeFile(path.join(unborn, 'new'), 'staged\nworking\n');
  const fresh = await repo.snapshot(unborn);
  assert.equal(fresh.unborn, true); assert.equal(fresh.status.additions, 2);
  assert.equal(fresh.status.files[0].stagedAdd, 1); assert.equal(fresh.status.files[0].unstagedAdd, 1);
  const freshPatch = await repo.workspace(unborn, { path: 'new', scope: 'all' });
  assert(freshPatch.patch.includes('+staged')); assert(freshPatch.patch.includes('+working'));
});

test('stash detail combines tracked and -u files, including binary and unusual filenames', async t => {
  const dir = await fixture(t);
  await commit(dir, 'tracked', 'old\n', 'base');
  await fs.writeFile(path.join(dir, 'tracked'), 'changed\n');
  const unusual = 'new 空格\tline\n.txt';
  await fs.writeFile(path.join(dir, unusual), 'new\nlines\n');
  await fs.writeFile(path.join(dir, 'binary'), Buffer.from([0, 1, 2]));
  await repo.git(dir, ['stash', 'push', '-u', '-m', 'backup']);
  const before = await repo.snapshot(dir);
  const detail = await repo.workspace(dir, { stash: before.stashes[0].sha });
  assert.equal(detail.sha, before.stashes[0].sha); assert.equal(detail.additions, 3); assert.equal(detail.deletions, 1);
  assert(detail.patch.includes('+changed')); assert(detail.patch.includes('+lines'));
  assert.deepEqual(detail.files.find(f => f.path === unusual), { path: unusual, add: 2, remove: 0, binary: false, untracked: true });
  assert.equal(detail.files.find(f => f.path === 'tracked').untracked, false);
  assert.equal(detail.files.find(f => f.path === 'binary').binary, true);
  assert.equal(detail.truncated, false);
  assert.deepEqual((await repo.snapshot(dir)).stashes, before.stashes);
  const service = require('../node/service.cjs');
  assert.deepEqual(await service.handle('repo/workspace', { dir, stash: detail.sha }), detail);
  await assert.rejects(repo.workspace(dir, { stash: 'HEAD' }));
});

test('workspace rename statistics and untracked estimates remain bounded', async t => {
  const dir = await fixture(t);
  await commit(dir, 'old', 'one\ntwo\n', 'base');
  await repo.git(dir, ['mv', 'old', 'renamed']);
  await Promise.all(Array.from({ length: 32 }, (_, i) => fs.writeFile(path.join(dir, 'new-' + String(i).padStart(2, '0')), 'line\n')));
  const state = await repo.snapshot(dir);
  const renamed = state.status.files.find(f => f.path === 'renamed');
  assert.equal(renamed.stagedAdd, 2); assert.equal(renamed.stagedRemove, 2);
  const untracked = state.status.files.filter(f => f.untracked);
  assert.equal(untracked.reduce((n, f) => n + f.untrackedAdd, 0), 30);
  assert.equal(state.status.additions, 32); assert.equal(state.status.deletions, 2);
});

test('workspaceDiff includes mixed changes, bounds untracked input, and leaves HEAD/index/worktree untouched', async t => {
  const dir = await fixture(t);
  await commit(dir, 'tracked', 'base\n', 'base');
  await fs.writeFile(path.join(dir, 'tracked'), 'base\nstaged-marker\n');
  await repo.git(dir, ['add', 'tracked']);
  await fs.appendFile(path.join(dir, 'tracked'), 'unstaged-marker\n');
  await fs.mkdir(path.join(dir, 'folder'));
  await fs.writeFile(path.join(dir, 'folder', 'new'), 'untracked-marker\n');
  await fs.writeFile(path.join(dir, 'binary'), Buffer.concat([Buffer.from([0]), Buffer.from('binary-private-marker')]));
  await fs.writeFile(path.join(dir, 'large'), 'large-private-marker'.repeat(10000));
  const before = await repo.git(dir, ['status', '--porcelain=v2', '-z']);
  const head = (await repo.git(dir, ['rev-parse', 'HEAD'])).trim();
  const result = await repo.workspaceDiff(dir);
  assert(result.text.includes('+staged-marker')); assert(result.text.includes('+unstaged-marker'));
  assert(result.text.includes('+untracked-marker'));
  assert(result.text.includes('二进制或过大的未跟踪文件，未包含内容'));
  assert(!result.text.includes('binary-private-marker')); assert(!result.text.includes('large-private-marker'));
  assert.equal(result.files, 4); assert.equal(result.additions, 3); assert.equal(result.deletions, 0);
  assert.equal(result.bytes, Buffer.byteLength(result.text)); assert.equal(result.truncated, false);
  await fs.writeFile(path.join(dir, 'padding'), 'padding-line\n'.repeat(9000));
  const paddedBefore = await repo.git(dir, ['status', '--porcelain=v2', '-z']);
  const limited = await repo.workspaceDiff({ dir }, 10000);
  assert(limited.text.length <= 10000); assert.equal(limited.truncated, true);
  assert(limited.text.includes('该文件内容已省略'));
  assert((await repo.workspaceDiff(dir, 1)).text.length <= 8000);
  assert.equal(await repo.git(dir, ['status', '--porcelain=v2', '-z']), paddedBefore);
  assert.equal((await repo.git(dir, ['rev-parse', 'HEAD'])).trim(), head);
  await fs.unlink(path.join(dir, 'padding'));
  assert.equal(await repo.git(dir, ['status', '--porcelain=v2', '-z']), before);
  const service = require('../node/service.cjs');
  assert.deepEqual(await service.handle('repo/workspace-diff', { dir, limit: 60000 }), result);
});

test('workspaceDiff supports unborn repos and only includes the first thirty untracked files', async t => {
  const dir = await fixture(t);
  await fs.writeFile(path.join(dir, 'staged'), 'staged-first\n');
  await repo.git(dir, ['add', 'staged']);
  await fs.appendFile(path.join(dir, 'staged'), 'unstaged-next\n');
  await Promise.all(Array.from({ length: 32 }, (_, i) => fs.writeFile(path.join(dir, 'new-' + String(i).padStart(2, '0')), 'new-marker-' + i + '\n')));
  const before = await repo.git(dir, ['status', '--porcelain=v2', '-z']);
  const result = await repo.workspaceDiff(dir);
  assert(result.text.includes('+staged-first')); assert(result.text.includes('+unstaged-next'));
  assert(result.text.includes('+new-marker-29\n')); assert(!result.text.includes('+new-marker-30\n'));
  assert.equal(result.files, 33); assert.equal(result.additions, 32);
  assert.equal(await repo.git(dir, ['status', '--porcelain=v2', '-z']), before);
  await assert.rejects(repo.git(dir, ['rev-parse', '--verify', 'HEAD']));
  const empty = await fixture(t);
  assert.deepEqual(await repo.workspaceDiff(empty), { text: '', truncated: false, includedFiles: 0, bytes: 0, files: 0, additions: 0, deletions: 0 });
});

test('workspaceDiff distributes a bounded budget across large file blocks without touching Git state', async t => {
  const dir = await fixture(t);
  await commit(dir, 'base', 'base\n', 'base');
  const names = Array.from({ length: 48 }, (_, i) => 'large-' + String(i).padStart(2, '0') + '.txt');
  await Promise.all(names.map(name => fs.writeFile(path.join(dir, name), ('内容改动 ' + name + '\n').repeat(180))));
  await repo.git(dir, ['add', '--', ...names]);
  const before = await repo.git(dir, ['status', '--porcelain=v2', '-z']);
  const head = (await repo.git(dir, ['rev-parse', 'HEAD'])).trim();
  const diff = await repo.workspaceDiff(dir, 8000);
  assert(diff.text.length <= 8000); assert.equal(diff.truncated, true);
  assert(diff.includedFiles > 1 && diff.includedFiles < names.length);
  assert.equal((diff.text.match(/^## 文件：/gm) || []).length, diff.includedFiles);
  assert(diff.text.includes('该文件内容已省略'));
  assert(diff.text.includes('仍有 ' + (names.length - diff.includedFiles) + ' 个文件未包含'));
  assert(!/^index |^--- |^\+\+\+ |^new file mode /m.test(diff.text));
  assert.equal(diff.bytes, Buffer.byteLength(diff.text));
  const defaultBudget = await repo.workspaceDiff(dir);
  assert(defaultBudget.text.length <= 26000); assert(defaultBudget.includedFiles >= diff.includedFiles);
  assert.equal(await repo.git(dir, ['status', '--porcelain=v2', '-z']), before);
  assert.equal((await repo.git(dir, ['rev-parse', 'HEAD'])).trim(), head);
});
