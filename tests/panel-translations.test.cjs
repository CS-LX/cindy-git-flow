'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto');

// Exercise the real Host queue and KV byte limit with a simulated model only.
function host(initial = {}) {
  let config = structuredClone(initial);
  const subjects = [], batches = [];
  const context = vm.createContext({crypto, TextEncoder, setTimeout: () => 0,
    BroadcastChannel: class { postMessage() {} },
    fetch: async (_url, opts) => {
      if (opts) config = JSON.parse(opts.body);
      return {ok: true, json: async () => structuredClone(config)};
    },
    cindy: {onHostMessage() {}, send: async message => {
      if (message.kind !== 'oneshot_text') return;
      const input = JSON.parse(message.prompt.split('输入数据：\n')[1]);
      batches.push(input.length); subjects.push(...input.map(i => i.source));
      return {ok: true, text: JSON.stringify(input.map(i => ({id:i.id, text:'已翻译：' + i.source})))};
    }}
  });
  vm.runInContext(fs.readFileSync(require.resolve('../main.js'), 'utf8'), context);
  const translate = vm.runInContext('translateSubjects', context);
  return {subjects, batches, translate, get config() { return structuredClone(config); }};
}
function panel(backend, initial = backend.config) {
  const nodes = new Map();
  const element = key => {
    if (!nodes.has(key)) nodes.set(key, {hidden:true, value:'', scrollTop:0, dataset:{}, setAttribute() {}, classList:{toggle() {}}, querySelector() { return null; }});
    return nodes.get(key);
  };
  const context = vm.createContext({console, initial, document:{hidden:false, querySelector:element, querySelectorAll:()=>[]},
    GitBridge:{request:(_method,params)=>backend.translate(params)}, GitFetchSchedule:{FetchSchedule:class {}}});
  for (const file of ['labels.js', 'timeline.js']) vm.runInContext(fs.readFileSync(require.resolve('../'+file), 'utf8'), context);
  const source = fs.readFileSync(require.resolve('../panel.js'), 'utf8').split("$('#repository-lock').onclick")[0];
  vm.runInContext(source, context);
  vm.runInContext(`config=initial; GitLabels.loadTranslations(config.translationCache);
    dir='/repo'; state={commits:[], refs:[]}; graphKey='ready';
    renderScope=()=>{}; renderAttention=()=>{}; repaintTranslations=()=>{};
    renderGraph=()=>{}; renderBranches=()=>{}; renderTeam=()=>{}; syncTeam=()=>{};`, context);
  return {run:code=>vm.runInContext(code,context), context, element};
}
const refs = Array.from({length:620}, (_,i)=>({sha:'sha'+i, subject:'unknown change '+i, remote:i%2===0, author:'human'}));
test('empty translations stop after one RPC and display stalled status with explicit retry',async()=>{
 let calls=0;const backend={config:{},translate:async()=>{if(++calls>3)throw Error('unexpected recursive RPC');return {translations:{}};}};
 const p=panel(backend);p.run('state.commits=[{sha:"stalled",subject:"untranslatable title"}]');
 await p.run('translatePending()');assert.equal(calls,1);assert.equal(p.run('translationBusy'),false);assert.equal(p.run('translationStalled.size'),1);assert.equal(p.run('untranslatedSubjects().length'),0);
 assert.equal(p.element('#translation-row').hidden,false);assert(p.element('#translation-status').textContent.includes('1 条标题暂时无法翻译'));assert.equal(p.element('#retry-translation').hidden,false);
 await p.run('translatePending()');assert.equal(calls,1);
 let cleared=false;backend.translate=async params=>{calls++;cleared=p.run('translationStalled.size')===0;return {translations:Object.fromEntries(params.subjects.map(s=>[s,'已完成的中文译文']))};};
 await p.run('translatePending(true)');assert(cleared);assert.equal(calls,2);assert.equal(p.run('translationStalled.size'),0);assert.equal(p.element('#translation-row').hidden,true);
});
test('partial translation adopts nineteen results, stalls only the omitted title and continues new work',async()=>{
 const calls=[],backend={config:{},translate:async params=>{
  calls.push([...params.subjects]);return {translations:Object.fromEntries(params.subjects.filter(s=>s!=='partial title 0').map(s=>[s,'译文 '+s]))};
 }};
 const p=panel(backend);p.run('state.commits=Array.from({length:20},(_,i)=>({sha:"partial"+i,subject:"partial title "+i}))');
 await p.run('translatePending()');assert.equal(calls.length,1);assert.equal(p.run('translationStalled.size'),1);assert(p.run('translationStalled.has("partial title 0")'));
 assert.equal(p.run('state.commits.filter(c=>!GitLabels.needsTranslation(c.subject)).length'),19);await p.run('translatePending()');assert.equal(calls.length,1);
 p.run('state.commits=[...state.commits,{sha:"fresh",subject:"fresh pending title"}]');await p.run('translatePending()');assert.equal(calls.length,2);assert.deepEqual(calls[1],['fresh pending title']);
});
test('partial progress continues later batches while malformed or empty values cannot spin',async()=>{
 const batches=[],backend={config:{},translate:async params=>{batches.push([...params.subjects]);return {translations:Object.fromEntries(params.subjects.map(s=>[s,s==='invalid title 0'?'':s==='invalid title 1'?'English only':'中文译文 '+s]))};}};
 const p=panel(backend);p.run('state.commits=Array.from({length:21},(_,i)=>({sha:"invalid"+i,subject:"invalid title "+i}))');await p.run('translatePending()');
 assert.equal(batches.length,2);assert.deepEqual(batches[1],['invalid title 20']);assert.equal(p.run('translationStalled.size'),2);assert.equal(p.run('untranslatedSubjects().length'),0);await p.run('translatePending()');assert.equal(batches.length,2);
});
test('stalled results from an old repository do not repopulate the new repository set',async()=>{
 let finish;const p=panel({config:{},translate:()=>new Promise(resolve=>{finish=resolve;})});p.run('state.commits=[{sha:"old",subject:"old stalled title"}]');const request=p.run('translatePending()');
 p.run('generation++;dir="/new";translationStalled.clear();state.commits=[]');finish({translations:{}});await request;assert.equal(p.run('translationStalled.size'),0);assert.equal(p.run('translationBusy'),false);
});
test('Git merge templates do not produce translation requests on timeline or branch pages',async()=>{
 const h=host(),p=panel(h);
 p.context.mergeTitles=["Merge pull request #5380 into 'develop'","Merge pull request #5358 into 'develop'","Merge pull request #5379 into 'develop'","Merge branch 'feature/x' into 'develop'","Merge remote-tracking branch 'origin/huhutest' into main",'Merge pull request #42 from alice/feature'];
 p.run('state.commits=mergeTitles.map((subject,i)=>({sha:"merge"+i,subject,parents:[]}));state.refs=state.commits.map(c=>({...c,remote:false}));');
 await p.run('translatePending()');p.run("switchTab('branches')");await p.run('translatePending()');
 assert.equal(h.subjects.length,0);assert.equal(h.batches.length,0);assert.equal(p.run('untranslatedSubjects().length'),0);
});

test('Maker wake commits do not produce translation requests on timeline or branch pages',async()=>{
 const h=host(),p=panel(h);
 p.context.wakeTitles=['chore: wake maker build server','chore(build): wake maker build server','🚀 chore( build ): wake maker build server'];
 p.run('state.commits=wakeTitles.map((subject,i)=>({sha:"wake"+i,subject,parents:[]}));state.refs=state.commits.map(c=>({...c,remote:false}));');
 await p.run('translatePending()');p.run("switchTab('branches')");await p.run('translatePending()');
 assert.equal(h.subjects.length,0);assert.equal(h.batches.length,0);assert.equal(p.run('untranslatedSubjects().length'),0);
});

test('620 visible branch titles drain once; refresh/tab changes preserve all session results', async t => {
  const h = host(), p = panel(h); p.context.refs = refs;
  p.run('state.refs=refs; state.commits=refs.slice(0,180);');
  await p.run('translatePending()');
  assert.equal(h.subjects.length,180, 'timeline must not translate all 620 branch tips');
  p.run("switchTab('branches')"); await p.run('translatePending()');
  // switchTab starts the queue synchronously; wait for its async batches to finish.
  for (let i=0; p.run('translationBusy') && i<100; i++) await new Promise(r=>setImmediate(r));
  assert.equal(h.subjects.length,620); assert.equal(h.batches.length,31);
  assert.equal(new Set(h.subjects).size,620); assert.equal(p.run('untranslatedSubjects().length'),0);
  for (let i=0;i<5;i++) {
    p.run('state={...state,refs:state.refs.map(r=>({...r})),commits:state.commits.map(c=>({...c}))}; GitLabels.loadTranslations(initial.translationCache);');
    p.run("switchTab('timeline'); switchTab('branches')"); await p.run('translatePending()');
  }
  assert.equal(h.subjects.length,620);
  assert.equal(Object.keys(h.config.translationCache).length,400);
  // A new panel only knows the persisted 400. It translates the missing 220
  // once, then its live cache again contains all 620 even as KV evicts old rows.
  const reopenedHost = host(h.config), reopened = panel(reopenedHost); reopened.context.refs=refs;
  reopened.run("state.refs=refs; tab='branches'"); await reopened.run('translatePending()');
  assert.equal(reopenedHost.subjects.length,220); assert.equal(reopenedHost.batches.length,11);
  assert.equal(new Set(reopenedHost.subjects).size,220);
  await reopened.run('translatePending()'); assert.equal(reopenedHost.subjects.length,220);
  t.diagnostic('620 titles: 31 model batches / 620 unique / 0 repeats; 5 refresh/tab cycles: 0 extra; reopen: 400 cache hits + 220 unique (11 batches), 0 repeats');
});

test('tab demand matches rendered refs/team/detail and switchTab starts translation', async () => {
  const h=host(), p=panel(h); p.context.refs=refs;
  p.run("state.refs=refs; state.commits=[{sha:'timeline',subject:'timeline private title'}]; team={members:[{subject:'team private title'}]};");
  await p.run('translatePending()'); assert.deepEqual(h.subjects,['timeline private title']);
  p.run("switchTab('team')"); await p.run('translatePending()'); assert.equal(h.subjects.length,1);
  p.run("config.teamUrl='https://team.invalid'; config.teamRepos={'/repo':{enabled:true}}; switchTab('team')");
  for (let i=0;p.run('translationBusy')&&i<100;i++) await new Promise(r=>setImmediate(r));
  assert.deepEqual(h.subjects,['timeline private title','team private title']);
  p.element('#detail').hidden=false; p.run("activeCommitSubject='detail private title'"); await p.run('translatePending()');
  assert.deepEqual(h.subjects,['timeline private title','team private title','detail private title']);
  p.run("tab='branches'; config.showOriginal=true"); await p.run('translatePending()'); assert.equal(h.subjects.length,3);
  p.run("config.showOriginal=false; state.refs=[{remote:null,subject:'not rendered reference'}]");
  p.element('#detail').hidden=true; await p.run('translatePending()'); assert.equal(h.subjects.length,3);
});

test('concurrent refresh requests share one in-flight batch and stale repository errors do not block new work', async () => {
  let release; const requests=[];
  const backend={config:{},translate:params=>{requests.push(params.subjects);return new Promise(resolve=>{release=()=>resolve({translations:Object.fromEntries(params.subjects.map(s=>[s,'译文 '+s]))});});}};
  const p=panel(backend); p.run("state.commits=[{sha:'pending',subject:'pending change'}]");
  const first=p.run('translatePending()'); await p.run('translatePending()'); await p.run('translatePending()');
  assert.equal(requests.length,1); release(); await first; await p.run('translatePending()'); assert.equal(requests.length,1);
  let reject; backend.translate=()=>new Promise((_resolve,fail)=>{reject=fail;});
  p.run("state.commits=[{sha:'old',subject:'old failure'}]");const old=p.run('translatePending()');
  p.run("generation++; dir='/other'; state.commits=[]; translationError=''");reject(new Error('stale failure'));await old;
  assert.equal(p.run('translationError'),'');assert.equal(p.run('translationBusy'),false);
});

test('switching away from 620 branches in flight stops the hidden page after its current batch', async () => {
  let release; const batches=[];
  const result = subjects => ({translations:Object.fromEntries(subjects.map(s=>[s,'译文 '+s]))});
  const backend={config:{},translate:async params=>{
    batches.push([...params.subjects]);
    if (batches.length===1) return new Promise(resolve=>{release=()=>resolve(result(params.subjects));});
    return result(params.subjects);
  }};
  const p=panel(backend);p.context.refs=refs;
  p.run("state.refs=refs;state.commits=[{sha:'fresh',subject:'new visible timeline'}];tab='branches'");
  const draining=p.run('translatePending()'); assert.equal(batches[0].length,20);
  p.run("switchTab('timeline')");release();await draining;
  assert.equal(batches.length,2);assert.deepEqual(batches[1],['new visible timeline']);
});
