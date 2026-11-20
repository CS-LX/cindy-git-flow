'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { subject, fileStatus } = require('../labels.js');
test('本地合并模板优先于旧模型译文，仅清理目的地标识符的引号',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),context={};vm.runInNewContext(fs.readFileSync(require.resolve('../labels.js'),'utf8'),context);const L=context.GitLabels,merge="Merge pull request #5380 into 'develop'";
 L.loadTranslations({[merge]:"合并拉取请求 #5380 到 'develop'",'quote preserve sample':"修复 'module' 的问题",'destination quote sample':"合入更新到 'develop'",'destination double sample':'切换到 "release/v2"','prose quote sample':"移动到 'new branch'",'middle quote sample':"修复 'x' 的问题"});
 assert.equal(L.subject(merge),'合并更新：合入合并请求 #5380 到 develop');assert.equal(L.needsTranslation(merge),false);
 assert.equal(L.subject('quote preserve sample'),"修复 'module' 的问题");assert.equal(L.subject('middle quote sample'),"修复 'x' 的问题");
 assert.equal(L.subject('destination quote sample'),'合入更新到 develop');assert.equal(L.subject('destination double sample'),'切换到 release/v2');assert.equal(L.subject('prose quote sample'),"移动到 'new branch'");
});
test('点目录归入配置与工具，保留已知模块与文档优先级',()=>{
 const L=require('../labels.js'),module=path=>L.workspaceSummary({files:[{path,status:'.M'}]}).headline;
 for(const path of ['.claude/settings.json','.vscode/settings.json','.gitignore','.editorconfig','.env.local','src/.cursor/settings.json','.github/workflows/check.yml','.husky/pre-commit'])assert.equal(module(path),'主要涉及 配置与工具文件',path);
 for(const path of ['package.json','ghost.json','.claude/README.md'])assert.equal(module(path),'主要涉及 项目配置与文档',path);
 assert.equal(module('.claude/style.css'),'主要涉及 样式与视觉');assert.equal(module('.claude/tests/a.test.js'),'主要涉及 自动化测试');assert.equal(module('.claude/panel.js'),'主要涉及 界面与交互');
});
test('未获得有效行数时不展示零行数，仍显示文件与新文件数',()=>{
 const L=require('../labels.js');
 for(const totals of [{additions:0,deletions:0},{additions:null,deletions:null},{}]){
  const summary=L.workspaceSummary({...totals,files:[{path:'.claude/settings.json',status:'??',untracked:true,add:0,remove:0}]});
  assert.equal(summary.statsText,'1 个文件 · 含 1 个新文件');assert(!summary.bullets.join('').includes('+0'));assert(!summary.bullets.join('').includes('-0'));
 }
 assert.equal(L.workspaceSummary({files:[{path:'a',status:'.D',add:0,remove:3}]}).statsText,'1 个文件 · +0 / -3 行');
});
test('长标识符备份改为友好标题，短备份和自然语言仍可翻译',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),context={};vm.runInNewContext(fs.readFileSync(require.resolve('../labels.js'),'utf8'),context);const L=context.GitLabels;
 const id='codex-preserve-before-pet-house-second-scene-77909fbb66b',raw='On x: '+id,info=L.stashInfo({subject:raw});
 assert.equal(info.title,'工作区备份');assert.equal(info.subtitle,'标识 '+id.slice(0,28)+'…');assert.equal(info.source,'');assert.equal(info.raw,raw);assert.equal(info.branch,'x');
 assert.equal(L.stashInfo({subject:'On x: my english scratch backup'}).source,'my english scratch backup');assert.equal(L.stashInfo({subject:'On x: wipping-backup'}).title,'wipping-backup');assert.equal(L.stashInfo({subject:'On x: wipping-backup'}).source,'wipping-backup');
 assert.equal(L.stashInfo({subject:'On x: '+'a'.repeat(33)}).title,'工作区备份');
 assert.equal(L.stashInfo({subject:'On x: local-upgrade-20261120-preserve-existing-work'}).title,'升级前自动保留的本地改动');
});
test('真实合并模板本地转中文且不进入模型队列，保留分支和PR标识',()=>{
 const L=require('../labels.js');
 const examples=[
  ["Merge pull request #5380 into 'develop'",'合并更新：合入合并请求 #5380 到 develop'],
  ["Merge pull request #5358 into 'develop'",'合并更新：合入合并请求 #5358 到 develop'],
  ["Merge pull request #5379 into 'develop'",'合并更新：合入合并请求 #5379 到 develop'],
  ["Merge branch 'feature/x' into 'develop'",'合并更新：将分支 feature/x 合入 develop'],
  ["Merge remote-tracking branch 'origin/huhutest' into main",'合并更新：将远端分支 origin/huhutest 合入 main'],
  ['Merge pull request #99 into "release/v2"','合并更新：合入合并请求 #99 到 release/v2'],
  ['Merge pull request #42 into main','合并更新：合入合并请求 #42 到 main'],
  ['Merge pull request #18 from alice/feature-x','合并更新：合入 alice/feature-x 的合并请求 #18'],
  ['Merge branch "feature/x" into "develop"','合并更新：将分支 feature/x 合入 develop'],
  ['Merge branch feature/x into develop','合并更新：将分支 feature/x 合入 develop'],
  ['Merge remote-tracking branch "origin/main" into "feature/x"','合并更新：将远端分支 origin/main 合入 feature/x']
 ];
 for(const [source,expected] of examples){assert.equal(L.subject(source),expected);assert.equal(L.needsTranslation(source),false);assert(!/Merge|pull request|remote-tracking| into /.test(L.subject(source)));}
 for(const source of ['Merge pull request service','Merge branch here','Merge pull request # into main','Merge pull request into develop'])assert.equal(L.needsTranslation(source),true,source);
 // Non-template commit behavior, including unknown modules, remains intact.
 assert.equal(L.subject('feat(developer-center): 上线游戏下架工单指引与理由校验 (#5345)'),'新增功能（developer-center）：上线游戏下架工单指引与理由校验 (#5345)');
 assert.equal(L.stashInfo({subject:"WIP on main: abc1234 Merge pull request #5380 into 'develop'"}).subtitle,'基于：合并更新：合入合并请求 #5380 到 develop');
});

test('中文释义保留真实分支名，未知提交不猜译', () => {
  assert.equal(subject('feat(input): add mobile touch controls across gameplay'), '新增功能（输入控制）：为游戏操作添加移动端触控');
  assert.equal(subject('style(story): 地面透视网格加密'), '样式调整（剧情）：地面透视网格加密');
  assert.equal(subject("Merge remote-tracking branch 'origin/huhutest' into 搜打撤"), '合并更新：将远端分支 origin/huhutest 合入 搜打撤');
  assert.equal(subject('feat(custom)!: unknown future change'), '新增功能（custom） · 含不兼容变更：unknown future change');
  assert.equal(subject('unknown future change'), 'unknown future change');
});

test('文件状态区分暂存、未暂存、未跟踪与冲突', () => {
  assert.equal(fileStatus({ status: 'M.' }), '已暂存修改');
  assert.equal(fileStatus({ status: '.M' }), '未暂存修改');
  assert.equal(fileStatus({ status: 'RM' }), '已暂存重命名、未暂存修改');
  assert.equal(fileStatus({ status: '??', untracked: true }), '未跟踪');
  assert.equal(fileStatus({ status: 'UU', conflict: true }), '冲突待处理');
});
test('截图新增提交完整中文，陌生说明必须进入翻译队列', () => {
 const L=require('../labels.js');
 for(const source of ['feat(battle): add initial MVP cinematic and quick preview','fix(input): filter isolated pointer-lock mouse spikes','feat(drive): add chassis stabilization and rounded track colliders']){
  assert(!L.needsTranslation(source));assert(!/[a-z]/i.test(L.subject(source)));
 }
 assert(L.needsTranslation('feat(camera): add smooth follow after teleport'));
 assert(L.needsTranslation('fix(input): crashes'));
 assert(!L.needsTranslation('feat(story): 添加 HUD 和 2D 网格'));
 assert(!L.needsTranslation("Merge branch 'feature/future' into main"));
});
test('未知提交读取动态缓存，异常缓存不覆盖显示或触发原型键', () => {
 const L=require('../labels.js'),source='fix(input): ignore repeated keyup events';assert(L.needsTranslation(source));
 L.loadTranslations({[source]:'修复问题（输入控制）：忽略重复的按键松开事件',bad:'still English'});
 assert(!L.needsTranslation(source));assert.equal(L.subject(source),'修复问题（输入控制）：忽略重复的按键松开事件');assert.equal(L.subject('bad'),'bad');assert.equal(L.subject('__proto__'),'__proto__');
});
test('真实模型保留的英文类型与全角冒号仍显示中文，旧缓存也能修正', () => {
 const L=require('../labels.js');
 L.loadTranslations({'fix(input): repeated release':'fix(input)：忽略重复的 keyup 事件','feat(camera): teleport follow':'feat(camera): 传送后平滑跟随车辆'});
 assert.equal(L.subject('fix(input): repeated release'),'修复问题（输入控制）：忽略重复的 keyup 事件');
 assert.equal(L.subject('feat(camera): teleport follow'),'新增功能（镜头）：传送后平滑跟随车辆');
});
test('stash 摘要移除 Git 前缀、升级标识和自动同步基准原文', () => {
 const L=require('../labels.js');
 for(const raw of ['On main: local-upgrade-20261120-preserve-existing-work','On main: local-upgrade-preserve-existing-work']) {
  assert.deepEqual(L.stashInfo({subject:raw}),{title:'升级前自动保留的本地改动',subtitle:'',branch:'main',auto:true,raw,source:''});
 }
 const auto=L.stashInfo({subject:'WIP on feature/test: abc1234 [1793783174615] sync at 2026/11/4 17:06:14'});
 assert.equal(auto.title,'临时备份');assert.equal(auto.subtitle,'基于自动同步快照');assert.equal(auto.branch,'feature/test');
 const index=L.stashInfo({subject:'index on main: abcdef1 fix: 修复输入'});
 assert.equal(index.title,'临时备份');assert.equal(index.subtitle,'基于：修复问题：修复输入');
 assert.equal(L.stashInfo({subject:'On main: feat(ui): 新增界面'}).title,'新增功能（界面）：新增界面');
 assert.equal(L.stashInfo({subject:'On main: abcdef123 feat(ui): 新增界面'}).title,'临时备份');
 assert.equal(L.stashInfo({subject:'On main: 我的临时工作'}).title,'我的临时工作');
 assert.equal(L.stashInfo(null).title,'本地备份');
});
test('本地规则按中文模块归纳文件、动作和行数，不堆文件名', () => {
 const L=require('../labels.js'),files=[
  {path:'panel.js',status:'.M',add:40,remove:5}, {path:'panel.html',status:'M.',add:10,remove:2},
  {path:'node/git.cjs',status:'.M',add:20,remove:3}, {path:'tests/local.test.cjs',status:'??',untracked:true,add:60,remove:0},
  {path:'tests/git.test.cjs',status:'.M',add:5,remove:1}
 ];
 const summary=L.workspaceSummary({files,count:5});
 assert.match(summary.headline,/界面与交互/);assert.match(summary.headline,/自动化测试/);assert.match(summary.headline,/Git 读取与后台服务/);
 assert.match(summary.statsText,/5 个文件 · \+135 \/ -11 行 · 含 1 个新文件/);
 assert(summary.bullets.length>=2&&summary.bullets.length<=4);assert(!summary.bullets.join('').includes('panel.js'));
 assert.match(summary.bullets.join(''),/自动化测试：新增 1 个、修改 1 个测试文件/);
 assert.match(L.workspaceSummary({files,additions:200,deletions:30}).statsText,/\+200 \/ -30/);
 assert.equal(L.workspaceSummary({files:[{path:'file.txt',status:'.M'}]}).statsText,'1 个文件');
 assert.equal(L.workspaceSummary({files:[]}).headline,'工作区没有未提交改动');
 for(const [path,module] of [['style.css','样式与视觉'],['graph.js','流线与图形布局'],['labels.js','中文说明与标签'],['panel-repos.js','仓库与账号管理'],['node/team.cjs','团队协作与同步'],['README.md','项目配置与文档'],['src/camera/follow.gd','镜头']]) {
  assert.match(L.workspaceSummary({files:[{path,status:'.M'}]}).headline,new RegExp(module));
 }
});
test('阶段内的动作标签只显示简短动作，保留旧 fileStatus 契约', () => {
 const L=require('../labels.js');
 assert.equal(L.stageFileBadge({status:'MM'},'staged'),'修改');assert.equal(L.stageFileBadge({status:'.M'},'unstaged'),'修改');
 assert.equal(L.stageFileBadge({status:'A.'},'staged'),'新增');assert.equal(L.stageFileBadge({status:'.D'},'unstaged'),'删除');
 assert.equal(L.stageFileBadge({status:'R.'},'staged'),'重命名');assert.equal(L.stageFileBadge({status:'??'},'untracked'),'新文件');
 assert.equal(L.stageFileBadge({status:'UU',conflict:true},'conflicts'),'冲突');
 assert.equal(L.fileStatus({status:'.M'}),'未暂存修改');
});
test('备份的英文名称与基准提交可复用模型译文，中文及升级备份不入队',()=>{
 const L=require('../labels.js'),base='feat(panel): add workspace flow',name='my english scratch backup';
 const wip={subject:'WIP on main: 6e6489e '+base},custom={subject:'On main: '+name};
 assert.equal(L.stashInfo(wip).source,base);assert.equal(L.stashInfo(custom).source,name);
 L.loadTranslations({[base]:'新增功能（面板）：添加工作区流线',[name]:'我的临时工作备份'});
 assert.equal(L.stashInfo(wip).subtitle,'基于：新增功能（面板）：添加工作区流线');
 assert.equal(L.stashInfo(custom).title,'我的临时工作备份');assert.equal(L.stashInfo(custom).source,'');assert.equal(L.stashInfo(wip).source,'');
 const auto=L.stashInfo({subject:'On main: local-upgrade-20261120-preserve-existing-work'});
 assert.equal(auto.title,'升级前自动保留的本地改动');assert.equal(auto.source,'');
 assert.equal(L.stashInfo({subject:'On main: 我的中文备份'}).source,'');
 assert.equal(L.stashInfo({subject:'WIP on main: 6e6489e [1793783174615] sync at 2026/11/4 17:06:14'}).source,'');
 // 直接用自动同步标题命名的备份是机器文案，不该占一次模型调用。
 const synced=L.stashInfo({subject:'On main: [1793783174615] sync at 2026/11/4 17:06:14'});
 assert.equal(synced.source,'');assert.equal(synced.title,'自动同步快照');
 assert.equal(L.stashInfo({subject:'On main: '+ 'long title '.repeat(151)}).source,'');
});
