'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const patch=['diff --git a/panel.js b/panel.js','index 111..222 100644','--- a/panel.js','+++ b/panel.js','@@ -1,2 +8,2 @@ function test','-old <tag>','+new <tag>',' context'].join('\n');
test('local flow and workspace typography never falls below the panel text scale',()=>{
 const css=fs.readFileSync(require.resolve('../panel.css'),'utf8');
 assert.doesNotMatch(css,/font-size\s*:\s*(?:10|11)px\b/);
 assert.match(css,/\.local-flow-head b\s*\{[^}]*font-size:\s*14px/);
 assert.match(css,/\.ws-patch\s*\{[^}]*font-size:\s*12px/);
});
function panel(impl) {
 const handlers = new Map();
 const nodes=new Map(),calls=[];
 function element(key) {
  if(nodes.has(key))return nodes.get(key);
  let html='';const classes=new Set();
  const el={hidden:true,value:'',scrollTop:0,dataset:{},attributes:{},style:{},htmlWrites:0,classList:{toggle(name,on){const enabled=on??!classes.has(name);if(enabled)classes.add(name);else classes.delete(name);return enabled;},contains(name){return classes.has(name);}},setAttribute(k,v){this.attributes[k]=v;},setPointerCapture(id){this.capturedPointer=id;},querySelector:element,querySelectorAll:()=>[],scrollIntoView(){this.scrolled=true;},focus(){this.focused=true;},contains(){return false;}};
  Object.defineProperty(el,'innerHTML',{get:()=>html,set:value=>{
   html=value;el.htmlWrites++;
   for(const m of value.matchAll(/<(?:div|section|button)\b([^>]*)>/g)) {
    const a=m[1],id=a.match(/\bid="([^"]+)"/),file=a.match(/data-ws-file="([^"]+)"/),stash=a.match(/data-ws-stash="([^"]+)"/);
    const key=id?'#'+id[1]:file?'[data-ws-file="'+file[1]+'"]':stash?'[data-ws-stash="'+stash[1]+'"]':null;
    if(key){element(key).hidden=/\bhidden\b/.test(a);element(key).disabled=/\bdisabled\b/.test(a);}
   }
  }});nodes.set(key,el);return el;
 }
 const context=vm.createContext({console,TextEncoder,TextDecoder,Uint8Array,setTimeout,clearTimeout,document:{hidden:false,querySelector:element,querySelectorAll:()=>[],addEventListener(type,handler){handlers.set(type,handler);}},GitFetchSchedule:{FetchSchedule:class{}},GitChoices:{close(){},set(){}},GitBridge:{request:async(method,params)=>{calls.push({method,params});return impl?impl(method,params):{patch};}}});
 for(const file of ['labels.js','timeline.js'])vm.runInContext(fs.readFileSync(require.resolve('../'+file),'utf8'),context);
 vm.runInContext(fs.readFileSync(require.resolve('../panel.js'),'utf8').split('GitBridge.on(async message =>')[0],context);
 vm.runInContext("dir='/repo'; config={motion:false}; state={dir,branch:'main',head:'abcdef123456',upstream:'origin/main',upstreamExists:true,ahead:0,behind:0,refs:[],remotes:[],commits:[{sha:'abcdef123456',subject:'fix(ui): 修复界面层级',parents:[],author:'test'}],stashes:[{sha:'stash-sha',subject:'On main: local-upgrade-20261120-preserve-existing-work',date:'2026-11-20T00:00:00Z'}],status:{count:4,staged:1,unstaged:1,untracked:1,conflicts:1,additions:35,deletions:7,files:[{path:'panel.js',status:'MM',add:30,remove:7,stagedAdd:20,stagedRemove:5,unstagedAdd:10,unstagedRemove:2},{path:'tests/new.test.cjs',status:'??',untracked:true,add:5,remove:0},{path:'node/conflict.cjs',status:'UU',conflict:true},{path:'old.txt',status:'D.'}]}};showPreferences=()=>{};renderScope=()=>{};renderRemote=()=>{};renderAttention=()=>{};",context);
 return{run:s=>vm.runInContext(s,context),element,calls,context,handlers};
}
test('drag and copy preserve the source worktree after the conversation changes', async () => {
 const p = panel(), sha = 'a'.repeat(40);
 const attrs = p.run(`referenceAttributes('/source worktree', '${sha}')`);
 const reference = attrs.match(/data-commit-reference="([^"]+)"/)[1].replaceAll('&quot;', '"');
 assert.equal(reference, 'Git 提交 ' + sha + '（来源仓库："/source worktree"）');
 assert.equal(p.run(`referenceAttributes('/source worktree', 'auto:${sha}')`), '');
 p.run("dir='/other repository'");
 const item = {dataset:{commitReference:reference},focus(){}};
 const target = {closest:() => item};
 const payload = new Map();
 p.handlers.get('dragstart')({target,dataTransfer:{setData:(type,value) => payload.set(type,value)}});
 assert.deepEqual([...payload], [['text/plain',reference]]);
 let copied;
 p.context.navigator = {clipboard:{writeText:async value => {copied=value;}}};
 await p.handlers.get('click')({target});
 assert.equal(copied,reference);
});
test('commit transfers use the captured source while focus and panel repositories change', async () => {
 const p=panel(), drag=p.handlers.get('dragstart'), click=p.handlers.get('click');
 const copied=[];
 p.context.navigator={clipboard:{writeText:async text=>{copied.push(text);}}};
 for(let i=0;i<500;i++){
   const sha=i.toString(16).padStart(40,'0'), source='/worktree '+(i%5);
   const attrs=p.run(`referenceAttributes(${JSON.stringify(source)}, '${sha}')`);
   const text=attrs.match(/data-commit-reference="([^"]+)"/)[1].replaceAll('&quot;','"');
   p.context.nextFocus=i%3?{workdir:i%2?source:'/other'}:null;
   p.run("activeFocus=nextFocus; lastFocusRevision++; dir='/switched'");
   const item={dataset:{commitReference:text},focus(){}},target={closest:()=>item};
   const expected='Git 提交 '+sha+'（来源仓库：'+JSON.stringify(source)+'）';
   let dragged;
   drag({target,dataTransfer:{setData:(type,value)=>{assert.equal(type,'text/plain');dragged=value;}}});
   await click({target});
   assert.equal(dragged,expected);assert.equal(copied[i],expected);
 }
 assert.equal(p.calls.length,0);
});
test('blocked async clipboard keeps the button and copies only its own reference on Ctrl+C', async () => {
 const p = panel(), button = {dataset:{commitReference:'reference from worktree A'},focus(){}};
 p.context.navigator = {platform:'Win32',clipboard:{writeText:async () => {throw Error('denied');}}};
 button.closest = () => button.dataset.awaitCopy ? button : null;
 p.context.document.activeElement = button;
 const payload = new Map();
 const copy = () => p.handlers.get('copy')({clipboardData:{setData:(k,v)=>payload.set(k,v)},preventDefault(){}});
 await p.handlers.get('click')({target:{closest:()=>button}});
 assert.equal(button.textContent,'按 Ctrl+C 复制');
 copy();
 assert.deepEqual([...payload],[['text/plain','reference from worktree A']]);
 assert.equal(button.textContent,'已复制');
 payload.clear(); copy(); assert.equal(payload.size,0);
 p.context.document.execCommand = command => {assert.equal(command,'copy');copy();return true;};
 await p.handlers.get('click')({target:{closest:()=>button}});
 assert.equal(payload.get('text/plain'),button.dataset.commitReference);
 assert.equal(button.textContent,'已复制');
});
test('locked panel warns only for the current non-repository session and keeps its source', async () => {
 let finish;
 const p = panel(() => new Promise(resolve => { finish = resolve; }));
 const timers = [];
 p.context.setTimeout = callback => { timers.push(callback); return timers.length; };
 p.context.clearTimeout = () => {};
 p.run('repositoryLocked=true; renderFollow=()=>{}');
 const pending = p.run("followConversation({workdir:'/old', revision:1})");
 await p.run("followConversation({workdir:'/repo', revision:2})");
 finish({outsideRepository:true}); await pending;
 assert.equal(timers.length,0);
 const current = p.run("followConversation({workdir:'/outside', revision:3})");
 finish({outsideRepository:true}); await current;
 assert.match(p.element('#session-toast').textContent,/不在 Git 仓库/);
 assert.equal(p.run('dir'),'/repo');
 await p.run("followConversation({workdir:'/outside', revision:3})");
 assert.equal(timers.length,1);
 timers[0](); assert.equal(p.element('#session-toast').hidden,true);
 await p.run("followConversation({workdir:null, revision:4})");
 assert.match(p.element('#session-toast').textContent,/没有关联本机目录/);
});
test('compact backup pill replaces raw toolbar details; local flow stays distinct from history',()=>{
 const html=fs.readFileSync(require.resolve('../panel.html'),'utf8');assert(!html.includes('<details id="stash-entry"'));assert(html.includes('id="stash-pill"'));assert(html.indexOf('id="local-flow"')<html.indexOf('id="graph"'));
 const p=panel();p.run('renderStatus();renderLocalFlow()');assert(p.element('#stash-pill').innerHTML.includes('备份 <b>1</b>'));
 const local=p.element('#local-flow').innerHTML;for(const s of ['工作区改动','本地备份 · 1 份','升级前自动保留的本地改动','data-local="changes"'])assert(local.includes(s));assert(!local.includes('local-upgrade'));assert(!local.includes('On main:'));
 p.run('outgoingActive=true;renderLocalFlow()');assert(p.element('#local-flow').hidden);
 p.run('outgoingActive=false;config.showOriginal=true;renderLocalFlow()');assert(p.element('#local-flow').innerHTML.includes('local-upgrade'));
 p.run('state.status.count=0;state.stashes=[];renderLocalFlow()');assert(p.element('#local-flow').hidden);
});
test('local flow starts with the workspace summary then previews each stage and backup',()=>{
 const p=panel();p.run('renderLocalFlow()');const html=p.element('#local-flow').innerHTML;
 const order=['data-local="changes"','data-local="conflicts"','data-local="staged"','data-local="unstaged"','data-local="untracked"','data-local="stash"'];
 for(let i=1;i<order.length;i++)assert(html.indexOf(order[i-1])<html.indexOf(order[i]),order[i]);
 for(const text of ['工作区改动','冲突待处理','已暂存改动','未暂存改动','未跟踪文件','本地备份 · 1 份','panel.js、old.txt','conflict.cjs','new.test.cjs','2 个文件 · +20 / -5 行','1 个文件 · +10 / -2 行','1 个新文件 · +5 行'])assert(html.includes(text),text);
 assert(!html.includes('ws-stage-pills'));assert(!html.includes('+0 / -0'));assert(!html.includes('local-flow-label'));
 assert.equal(p.run('stageFilesPreview([{path:"a/one.js"},{path:"two.js"},{path:"c/three.js"},{path:"four.js"}])'),'one.js、two.js、three.js 等 4 个文件');
 assert.equal(p.run('stageStatsText({scope:"unstaged",files:[{add:0,remove:0}]})'),'1 个文件');
 assert.equal(p.run('stageStatsText({scope:"untracked",files:[{}]})'),'1 个新文件');
 p.run('state.stashes=[{subject:"WIP on main: abcdef1 fix(ui): 修复显示"}];renderLocalFlow()');assert(p.element('#local-flow').innerHTML.includes('临时备份 · 基于：修复问题（界面）：修复显示'));
});
test('bottom local handle clicks and drags collapse in place and retain a useful count',()=>{
 const p=panel();p.run('renderLocalFlow()');const host=p.element('#local-flow'),handle=p.element('#local-pull-handle');
 assert(host.innerHTML.includes('class="pull-handle local-pull-handle"'));assert(host.innerHTML.includes('class="grip"'));assert(host.innerHTML.includes('收起本地状态'));
 const writes=host.htmlWrites,event={target:{closest:s=>s==='[data-local-toggle]'?{dataset:{localToggle:''},setPointerCapture:id=>{handle.capturedPointer=id;}}:null}};
 host.onclick(event);
 assert(host.classList.contains('collapsed'));assert.equal(p.element('.pull-label').textContent,'展开本地状态 · 4 个改动 · 备份 1');assert.equal(handle.attributes['aria-expanded'],'false');assert(p.element('.local-flow-inner').inert);assert.equal(host.htmlWrites,writes);
 host.onclick(event);assert(!host.classList.contains('collapsed'));assert.equal(p.element('.pull-label').textContent,'收起本地状态');assert(!p.element('.local-flow-inner').inert);
 host.onpointerdown({...event,button:0,pointerId:7,clientY:100});host.onpointerup({...event,pointerId:7,clientY:79});host.onclick(event);
 assert.equal(handle.capturedPointer,7);assert(host.classList.contains('collapsed'));assert.equal(handle.attributes['aria-expanded'],'false');assert.equal(p.element('.pull-label').textContent,'展开本地状态 · 4 个改动 · 备份 1');
 host.onpointerdown({...event,button:0,pointerId:8,clientY:70});host.onpointerup({...event,pointerId:8,clientY:100});host.onclick(event);assert(!host.classList.contains('collapsed'));
 host.onpointerdown({...event,button:0,pointerId:9,clientY:100});host.onpointercancel();host.onpointerup({...event,pointerId:9,clientY:10});assert(!host.classList.contains('collapsed'));
 p.run('renderLocalFlow()');assert.equal(host.htmlWrites,writes);
 const css=fs.readFileSync(require.resolve('../panel.css'),'utf8');assert.match(css,/\.local-flow-collapsible\s*\{[^}]*grid-template-rows:\s*1fr/);assert.match(css,/\.local-flow\.collapsed \.local-flow-collapsible\s*\{[^}]*grid-template-rows:\s*0fr/);assert.match(css,/\.local-flow-track::before/);assert.doesNotMatch(css,/\.local-flow::before/);
});
test('stage nodes open and focus their matching detail section without eagerly reading diffs',async()=>{
 for(const scope of ['conflicts','staged','unstaged','untracked']){
  const p=panel();await p.element('#local-flow').onclick({target:{closest:s=>s==='[data-local]'?{dataset:{local:scope}}:null}});
  const section=p.element('#ws-stage-'+scope);assert(section.scrolled,scope);assert(section.focused,scope);assert(p.element('#detail-body').innerHTML.includes('id="ws-stage-'+scope+'"'));assert(p.element('#detail-body').innerHTML.includes('tabindex="-1"'));assert.equal(p.calls.length,0);
 }
});
test('dirty opens summary, status flow and clean file groups without a model or eager patches',async()=>{
 const p=panel();await p.element('#dirty').onclick();const body=p.element('#detail-body').innerHTML;
 for(const s of ['ws-summary','ws-flow','ws-file','当前基准提交','冲突待处理','已暂存改动','未暂存改动','未跟踪文件','本地备份','未写入 Git 提交记录','+35 新增行','<b>new.test.cjs</b><small>tests</small>'])assert(body.includes(s),s);
 assert(!body.includes('local-upgrade'));assert(!body.includes('未暂存修改'));assert(!body.includes('<b>panel.js</b><small>'));assert.equal(p.calls.length,0);assert(!p.element('#detail').hidden);
});
test('file clicks load one scoped diff, hide Git headers, escape code and reuse the loaded result',async()=>{
 const p=panel();await p.element('#dirty').onclick();const id=p.run('workspaceView.files.findIndex(e=>e.scope==="staged"&&e.file.path==="panel.js")');
 const click={target:{closest:s=>s==='[data-ws-file]'?{dataset:{wsFile:String(id)}}:null}};await p.element('#detail-body').onclick(click);
 assert.equal(p.calls.length,1);assert.equal(p.calls[0].method,'repo/workspace');assert.equal(p.calls[0].params.path,'panel.js');assert.equal(p.calls[0].params.scope,'staged');
 const body=p.element('#ws-diff-'+id).innerHTML;assert(body.includes('第 8 行'));assert(body.includes('new &lt;tag&gt;'));for(const s of ['diff --git','index 111','--- a/','+++ b/','@@'])assert(!body.includes(s),s);
 await p.element('#detail-body').onclick(click);assert(p.element('#ws-diff-'+id).hidden);await p.element('#detail-body').onclick(click);assert.equal(p.calls.length,1);assert(!p.element('#ws-diff-'+id).hidden);
 p.context.special=['diff --git a/x b/x','new file mode 100644','--- /dev/null','+++ b/x','@@ -0,0 +1,1 @@','+++ b/this-is-code'].join('\n');assert(p.run('cleanPatchBody(special)').includes('+++ b/this-is-code'));
});
test('backup pill scrolls and opens first backup; stash files use immutable stash contents',async()=>{
 const p=panel((_m,params)=>{assert(params.stash);return{files:[{path:'panel.js',add:1,remove:1}],patch,additions:1,deletions:1};});await p.element('#stash-pill').onclick();
 assert.equal(p.calls.length,1);assert.equal(p.calls[0].params.stash,'stash-sha');assert(p.element('#ws-stashes').scrolled);assert(p.element('#ws-stashes').focused);assert(!p.element('#ws-stash-body-0').hidden);assert(p.element('#ws-stash-body-0').innerHTML.includes('1 个文件'));
 const id=p.run('workspaceView.files.findIndex(e=>e.stash==="stash-sha")');await p.run('toggleWorkspaceFile('+id+')');assert(p.element('#ws-diff-'+id).innerHTML.includes('第 8 行'));assert(!p.element('#ws-diff-'+id).innerHTML.includes('@@'));assert.equal(p.calls.length,1);
 await p.run('toggleWorkspaceStash(0)');await p.run('toggleWorkspaceStash(0)');assert.equal(p.calls.length,1);
});
test('preview failure is friendly and retryable; closed detail ignores late responses',async()=>{
 let resolve,attempt=0;const p=panel(()=>{if(!attempt++)throw new Error('raw git fatal');return new Promise(r=>{resolve=r;});});await p.element('#dirty').onclick();const id=p.run('workspaceView.files.findIndex(e=>e.scope==="unstaged")');
 await p.run('toggleWorkspaceFile('+id+')');assert(p.element('#ws-diff-'+id).innerHTML.includes('暂时无法读取'));assert(!p.element('#ws-diff-'+id).innerHTML.includes('fatal'));await p.run('toggleWorkspaceFile('+id+')');const pending=p.run('toggleWorkspaceFile('+id+')');
 p.run('closeDetail()');const previous=p.element('#ws-diff-'+id).innerHTML;resolve({patch});await pending;assert.equal(p.element('#ws-diff-'+id).innerHTML,previous);
});
test('stash path matching handles spaces and deleted files',()=>{
 const p=panel();p.context.data=['diff --git a/space name.js b/space name.js','--- a/space name.js','+++ b/space name.js','@@ -1 +1 @@','+space',patch].join('\n');assert(p.run('stashFilePatch(data,"space name.js")').includes('+space'));assert(!p.run('stashFilePatch(data,"space name.js")').includes('new <tag>'));
 p.context.data=['diff --git a/old.js b/old.js','deleted file mode 100644','--- a/old.js','+++ /dev/null','@@ -1 +0,0 @@','-old'].join('\n');assert(p.run('stashFilePatch(data,"old.js")').includes('-old'));
 const slash=String.fromCharCode(92),quoted=slash+'344'+slash+'270'+slash+'255.js';
 p.context.data=['diff --git "a/'+quoted+'" "b/'+quoted+'"','--- "a/'+quoted+'"','+++ "b/'+quoted+'"','@@ -1 +1 @@','+中文'].join('\n');assert(p.run('stashFilePatch(data,"中.js")').includes('+中文'));
});
test('local flow clicks enter the workspace and conflicts use combined diff scope',async()=>{
 const p=panel();await p.element('#local-flow').onclick({target:{closest:()=>({dataset:{local:'changes'}})}});
 assert(p.element('#detail-body').innerHTML.includes('ws-summary'));
 const id=p.run('workspaceView.files.findIndex(e=>e.scope==="conflicts")');await p.run('toggleWorkspaceFile('+id+')');
 assert.equal(p.calls[0].params.scope,'all');assert.equal(p.calls[0].params.path,'node/conflict.cjs');
});
test('visible backups join the existing translation demand without mutating graph rows; original mode skips them',()=>{
 const p=panel();
 p.run('state.stashes=[{sha:"custom",subject:"On main: my english scratch backup"},{sha:"wip",subject:"WIP on main: 6e6489e feat(panel): add workspace flow"}];renderLocalFlow()');
 const sources=Array.from(p.run('untranslatedSubjects()'));assert(sources.includes('my english scratch backup'));assert(sources.includes('feat(panel): add workspace flow'));
 assert.equal(p.run('visibleCommits().length'),1);
 p.run('config.showOriginal=true');assert.equal(p.run('untranslatedSubjects().length'),0);
 p.run('config.showOriginal=false;tab="branches"');assert.equal(p.run('untranslatedSubjects().length'),0);
});
test('translation repaint updates stash title and baseline subtitle while preserving expanded backups and file diffs',async()=>{
 const p=panel((_method,params)=>({files:[{path:'panel.js',add:1,remove:1}],patch}));
 p.run('translationBusy=true;renderGraph=()=>{};state.stashes=[{sha:"custom",subject:"On main: my english scratch backup"},{sha:"wip",subject:"WIP on main: 6e6489e feat(panel): add workspace flow"}]');
 await p.element('#stash-pill').onclick();
 assert(p.element('#detail-body').innerHTML.includes('data-stash-title="0"'));assert(p.element('#detail-body').innerHTML.includes('data-stash-subtitle="1"'));
 const id=p.run('workspaceView.files.findIndex(e=>e.stash==="custom")');await p.run('toggleWorkspaceFile('+id+')');
 const before=p.element('#detail-body').innerHTML,inline=p.element('#ws-diff-'+id).innerHTML;
 p.run('GitLabels.loadTranslations({"my english scratch backup":"我的临时工作备份","feat(panel): add workspace flow":"新增功能（面板）：添加工作区流线"});repaintTranslations()');
 assert.equal(p.element('[data-stash-title="0"]').textContent,'我的临时工作备份');
 assert.equal(p.element('[data-stash-subtitle="1"]').textContent,'基于：新增功能（面板）：添加工作区流线');
 assert.equal(p.element('#detail-body').innerHTML,before);assert.equal(p.element('#ws-diff-'+id).innerHTML,inline);assert(!p.element('#ws-diff-'+id).hidden);assert(!p.element('#ws-stash-body-0').hidden);assert.equal(p.calls.length,1);
 assert.equal(p.run('untranslatedSubjects().length'),0);
 p.run('config.showOriginal=true;repaintTranslations()');assert.equal(p.element('[data-stash-title="0"]').textContent,'On main: my english scratch backup');assert(p.element('[data-stash-subtitle="1"]').hidden);
});
const summaryResult=()=>({points:['整理工作区摘要与文件交互','增加 <本地> 预览验证'],truncated:false,files:4,additions:35,deletions:7,model:'simulated',generatedAt:'2026-11-20T08:00:00Z'});
const summaryClick={target:{closest:s=>s==='#ws-summarize'?{}:null}};
test('model summary requires a click, shares an in-flight request, and updates only the summary card',async()=>{
 let finish;const p=panel(method=>method==='workspace/summarize'?new Promise(r=>{finish=r;}):{patch});
 p.run('renderGraph=()=>{}');await p.element('#dirty').onclick();p.run('render()');
 assert.equal(p.calls.length,0);assert(p.element('#ws-model-summary').innerHTML.includes('生成详细摘要'));assert(p.element('#detail-body').innerHTML.includes('id="ws-model-summary"'));
 const id=p.run('workspaceView.files.findIndex(e=>e.scope==="unstaged")');await p.run('toggleWorkspaceFile('+id+')');
 const body=p.element('#detail-body').innerHTML,diff=p.element('#ws-diff-'+id).innerHTML;
 const pending=p.element('#detail-body').onclick(summaryClick);await p.element('#detail-body').onclick(summaryClick);
 assert.equal(p.calls.filter(c=>c.method==='workspace/summarize').length,1);assert.equal(p.calls.at(-1).params.dir,'/repo');assert(p.element('#ws-summarize').disabled);assert(p.element('#ws-model-summary').innerHTML.includes('正在生成详细摘要…'));
 finish({...summaryResult(),truncated:true});await pending;
 const html=p.element('#ws-model-summary').innerHTML;assert(html.includes('整理工作区摘要与文件交互'));assert(html.includes('&lt;本地&gt;'));assert(html.includes('仅保存在本次面板内'));assert(html.includes('只总结了前一部分'));assert(html.includes('重新生成'));
 assert.equal(p.element('#detail-body').innerHTML,body);assert.equal(p.element('#ws-diff-'+id).innerHTML,diff);assert(!p.element('#ws-diff-'+id).hidden);assert.equal(p.run('modelSummary.status'),'ready');assert(!p.element('#ws-summarize').disabled);
});
test('empty/malformed model points degrade to retryable errors, without automatic retry',async()=>{
 for(const result of [{points:[]},{points:['']},{points:['valid',3]},{points:'not an array'},null]){
  let attempts=0;const p=panel(()=>attempts++?summaryResult():result);p.run('renderGraph=()=>{}');await p.element('#dirty').onclick();await p.element('#detail-body').onclick(summaryClick);
  assert.equal(p.run('modelSummary.status'),'error');assert(p.element('#ws-model-summary').innerHTML.includes('摘要结果格式无效，请重试。'));assert(p.element('#ws-model-summary').innerHTML.includes('重试'));
  p.run('render()');assert.equal(attempts,1);await p.element('#detail-body').onclick(summaryClick);assert.equal(attempts,2);assert.equal(p.run('modelSummary.status'),'ready');
 }
});
test('model failure displays its error and permits an explicit retry; reopening keeps the ready result',async()=>{
 let attempts=0;const p=panel(()=>{if(!attempts++)throw new Error('未配置可用的轻量任务模型');return summaryResult();});
 await p.element('#dirty').onclick();await p.element('#detail-body').onclick(summaryClick);assert(p.element('#ws-model-summary').innerHTML.includes('未配置可用的轻量任务模型'));
 assert.equal(attempts,1);await p.element('#detail-body').onclick(summaryClick);assert.equal(p.run('modelSummary.status'),'ready');
 p.run('closeDetail()');await p.element('#dirty').onclick();assert.equal(attempts,2);assert(p.element('#ws-model-summary').innerHTML.includes('整理工作区摘要与文件交互'));assert(!p.element('#ws-model-summary').innerHTML.includes('摘要已过期'));
 assert(p.calls.every(c=>c.method==='workspace/summarize'));
});
test('each signature field invalidates the visible summary after refresh without dropping its points or generating again',async()=>{
 for(const change of ['state.status.count++','state.status.additions++','state.status.deletions++','state.status.files[0].status="M."','state.status.files[0].path="renamed.js"']){
  const p=panel(()=>summaryResult());p.run('renderGraph=()=>{}');await p.element('#dirty').onclick();await p.element('#detail-body').onclick(summaryClick);
  p.run(change+';render()');const html=p.element('#ws-model-summary').innerHTML;
  assert(html.includes('摘要已过期 · 工作区又有新改动'),change);assert(html.includes('整理工作区摘要与文件交互'));assert(html.includes('重新生成'));assert.equal(p.calls.length,1);
 }
});
test('branch, HEAD, and repository context changes discard the in-memory summary',async()=>{
 for(const change of ['state.head="new-head"','state.branch="new-branch"','dir="/other";state.dir=dir']){
  const p=panel(()=>summaryResult());p.run('renderGraph=()=>{}');await p.element('#dirty').onclick();await p.element('#detail-body').onclick(summaryClick);
  p.run(change+';render()');assert.equal(p.run('modelSummary'),null,change);assert.equal(p.calls.length,1);
  await p.element('#dirty').onclick();assert(p.element('#ws-model-summary').innerHTML.includes('生成详细摘要'));assert.equal(p.calls.length,1);
 }
});
test('summary completion from a closed/reopened detail is discarded and does not leave loading stuck',async()=>{
 let finish;const p=panel(()=>new Promise(r=>{finish=r;}));await p.element('#dirty').onclick();const pending=p.element('#detail-body').onclick(summaryClick);
 p.run('closeDetail()');await p.element('#dirty').onclick();await p.element('#detail-body').onclick(summaryClick);assert.equal(p.calls.length,1);
 finish(summaryResult());await pending;assert.equal(p.run('modelSummary.status'),'idle');assert(!p.element('#ws-summarize').disabled);assert(!p.element('#ws-model-summary').innerHTML.includes('整理工作区摘要与文件交互'));
});
