import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GITHUB_API_URL, safeGithubUrl, normalizeGithubOverview, retainGithubOverview, githubDeploymentLabel, githubSummary } from '../github-core.mjs';
import { initializeGithubOverview } from '../github.mjs';
import { MICROSOFT_DEPLOYMENT, microsoftSessionKey, clearMicrosoftSession, connectMicrosoftServices } from '../microsoft-session.mjs';
import { INTRANET_DEPLOYMENT_IDS, intranetScope } from '../intranet-core.mjs';
const at='2026-11-05T12:00:00Z';
const project=(key,extras={})=>({name:key==='dashboard'?'dashboard-personnel':'private-fixture',repository:`Soaresbm1/${key==='dashboard'?'dashboard-personnel':'private-fixture'}`,private:key!=='dashboard',archived:false,checkedAt:at,
 deployment:{state:'ready',status:'success',at,url:'https://github.com/Soaresbm1/dashboard-personnel/actions/runs/1'},
 pulls:{state:'ready',count:1,hasMore:false,items:[{number:2,title:'Modification de test',draft:false}]},...extras});
const body=(overrides={})=>({schemaVersion:2,owner:'Soaresbm1',state:'ready',checkedAt:at,hasMore:false,projects:[project('dashboard',overrides.dashboard),project('intranet',overrides.intranet)]});
const normalized=(value=body())=>normalizeGithubOverview(value);
test('Only exact repository HTTPS URLs are accepted',()=>{
 for(const url of ['javascript:alert(1)','http://github.com/Soaresbm1/dashboard-personnel/a','https://github.com.evil.test/Soaresbm1/dashboard-personnel/a','https://user@github.com/Soaresbm1/dashboard-personnel/a','https://github.com:444/Soaresbm1/dashboard-personnel/a','https://github.com/Soaresbm1/dashboard-personnel-evil/a'])assert.equal(safeGithubUrl(url,'Soaresbm1/dashboard-personnel'),null);
});
test('Dynamic repositories stay confined to Soaresbm1 and duplicate or unsafe names fail closed',()=>{
 assert.equal(normalized().projects.length,2);
 for(const value of [null,{}, {...body(),owner:'ISP-SPI'}, {...body(),projects:[project('dashboard'),project('dashboard')]}, {...body(),projects:[project('dashboard',{repository:'ISP-SPI/dashboard-personnel'})]}, {...body(),projects:[project('dashboard',{name:'../x'})]}, {...body(),projects:Array(31).fill(project('dashboard'))}])assert.throws(()=>normalized(value));
});
test('Missing access is unknown, purges private metadata, and no CI state becomes a publication',()=>{
 const missing=normalized({...body(),state:'not_connected',projects:[]});
 assert.equal(githubSummary(missing).repositories,'Dépôts : —');
 assert.throws(()=>normalized({...body(),state:'access_denied'}));
 assert.throws(()=>normalized(body({dashboard:{deployment:{state:'ready',status:'tests_passed'}}})));
 assert.equal(githubDeploymentLabel({state:'ready',status:'untracked'}),'Production non renseignée');
});
test('Summary counts all accessible repositories and marks incomplete counts explicitly',()=>{
 assert.equal(githubSummary(normalized()).detail,'2 PR ouvertes');
 assert.match(githubSummary(normalized(body({intranet:{pulls:{state:'access_denied'}}}))).detail,/1\+.*lecture partielle/);
 assert.throws(()=>normalized(body({dashboard:{pulls:{state:'ready',count:-1,hasMore:false,items:[]}}})));
});
test('Titles are text, PR links are rebuilt, and transient failures retain dates without restoring denied access',()=>{
 const old=normalized(body({intranet:{pulls:{state:'ready',count:1,hasMore:false,items:[{number:7,title:'<img onerror=fixture>',url:'javascript:bad',draft:true}]}}}));
 assert.equal(old.projects[1].pulls.items[0].url,'https://github.com/Soaresbm1/private-fixture/pull/7');
 const next=normalized(body({intranet:{deployment:{state:'unavailable'},pulls:{state:'rate_limited'}}}));
 const kept=retainGithubOverview(next,old);assert.equal(kept.projects[1].pulls.count,1);assert.equal(kept.projects[1].pulls.stale,true);
 assert.equal(retainGithubOverview({state:'unavailable'},old).stale,true);
 const denied=retainGithubOverview(normalized({...body(),state:'access_denied',projects:[]}),old);assert.equal(denied.projects.length,0);
 const removed=retainGithubOverview(normalized({...body(),projects:[]}),old);assert.equal(removed.projects.length,0);
});

const settle=()=>new Promise(resolve=>setImmediate(resolve));
const owner={tenantId:MICROSOFT_DEPLOYMENT.tenantId,localAccountId:MICROSOFT_DEPLOYMENT.ownerObjectId,homeAccountId:'fixture-owner',username:'fixture@example.test'};
function harness(options={}) {
  const nodes=new Map(), calls=[], writes=[], storage=new Map(options.remembered===false?[]:[[microsoftSessionKey(INTRANET_DEPLOYMENT_IDS),'1']]);
  class Element {
    constructor(){this.textContent='';this.hidden=false;this.disabled=false;this.dataset={};this.attrs={};this.listeners=new Map();}
    get href(){return this.attrs.href;} set href(v){this.attrs.href=v;}
    get title(){return this.attrs.title;} set title(v){this.attrs.title=v;}
    setAttribute(k,v){this.attrs[k]=v;} removeAttribute(k){delete this.attrs[k];}
    replaceChildren(...children){this.children=children;}
    addEventListener(k,f){this.listeners.set(k,f);} removeEventListener(k){this.listeners.delete(k);}
  }
  for(const id of ['github-overview','github-refresh','github-status','intranet-config-form','github-repository','github-repository-count','github-account-detail','github-selected','github-selected-deployment','github-selected-pulls','github-selected-checked'])nodes.set(`#${id}`,new Element());
  const listeners=new Map(), win={navigator:{onLine:true},addEventListener(k,f){listeners.set(k,f);},removeEventListener(k){listeners.delete(k);}};
  const storageApi={getItem:k=>storage.get(k)??null,setItem(k,v){writes.push([k,v]);storage.set(k,v);},removeItem(k){storage.delete(k);}}; win.localStorage=storageApi;
  const doc={createElement:()=>new Element(),baseURI:'https://example.test/dashboard/',hidden:false,querySelector:k=>nodes.get(k)};
  let application, tokenFailure=false;
  class PublicClientApplication {
    constructor(){application=this;this.accounts=options.remembered===false?[]:[options.account||owner];}
    async initialize(){await options.initialize?.();}
    getAllAccounts(){return this.accounts;} getActiveAccount(){return null;} setActiveAccount(){}
    async acquireTokenSilent(req){calls.push(['token',req]);if(tokenFailure)throw {errorCode:'interaction_required'};return options.token?.(req)||{accessToken:'fixture-ms-token',account:owner};}
    async loginPopup(req){calls.push(['popup',req]);this.accounts=[owner];return {accessToken:'fixture-ms-token',account:owner};}
    async clearCache(){this.accounts=[];}
  }
  const auto={started:false,config:null,disposed:false};
  const instance=initializeGithubOverview({document:doc,window:win,storage:storageApi,loadSdk:async()=>({PublicClientApplication}),
    autoRefreshFactory(config){auto.config=config;return {start(){auto.started=true;},stop(){auto.started=false;},dispose(){auto.disposed=true;auto.started=false;}};},
    fetch:async(url,request)=>{calls.push(['fetch',url,request]);return options.fetch?.(url,request)||new Response(JSON.stringify(body()),{status:200});}});
  return {nodes,doc,win,storageApi,writes,auto,instance,calls,get app(){return application;},expire(){tokenFailure=true;}};
}
test('Remembered owner loads only the fixed API with the existing delegated scope and no popup or persisted data', async () => {
  const h=harness();await settle();await settle();
  assert.equal(h.calls.filter(c=>c[0]==='popup').length,0);assert.equal(h.calls.filter(c=>c[0]==='fetch').length,1);
  const request=h.calls.find(c=>c[0]==='fetch');assert.equal(request[1],GITHUB_API_URL);assert.equal(request[2].method,'GET');assert.equal(request[2].credentials,'omit');assert.equal(request[2].redirect,'error');
  assert.deepEqual(h.calls.find(c=>c[0]==='token')[1].scopes,[intranetScope(INTRANET_DEPLOYMENT_IDS)]);
  assert.equal(h.nodes.get('#github-selected-pulls').textContent,'1 modification en attente');assert.equal(h.nodes.get('#github-selected-deployment').textContent,'Publication réussie');
  assert.deepEqual(h.writes,[]);assert.equal(h.auto.config.intervalMs,300000);h.instance.dispose();
});
test('Other accounts and disconnected pages do not fetch data or open authentication popups', async () => {
  for (const options of [{remembered:false},{account:{...owner,localAccountId:'00000000-0000-4000-8000-000000000001'}}]) {
    const h=harness(options);await settle();assert.equal(h.calls.length,0);assert.equal(h.nodes.get('#github-selected-pulls').textContent,'Modifications : —');h.instance.dispose();
  }
});
test('A network failure keeps last values dated; a successful empty response replaces old counts', async () => {
  let mode='good';const h=harness({fetch(){if(mode==='network')throw new TypeError('fixture');return new Response(JSON.stringify(mode==='empty'?body({dashboard:{pulls:{state:'ready',count:0,hasMore:false,items:[]}},intranet:{pulls:{state:'ready',count:0,hasMore:false,items:[]}}}):body()),{status:200});}});
  await settle();await settle();mode='network';await h.instance.refresh();assert.match(h.nodes.get('#github-selected-pulls').textContent,/Dernières données.*1 modification/);
  assert.match(h.nodes.get('#github-selected-checked').textContent,/Données du/);
  mode='empty';await h.instance.refresh();assert.equal(h.nodes.get('#github-selected-pulls').textContent,'0 modifications en attente');h.instance.dispose();
});
test('Expired Microsoft access clears private metadata and stops refreshing until central sign-in', async () => {
  const h=harness();await settle();await settle();h.expire();await h.instance.refresh();
  assert.equal(h.nodes.get('#github-selected-deployment').href,undefined);assert.equal(h.nodes.get('#github-selected-pulls').title,undefined);
  assert.equal(h.nodes.get('#github-selected-pulls').textContent,'Modifications : —');assert.equal(h.auto.started,false);h.instance.dispose();
});
test('Sign-out discards an in-flight API response and clears private titles', async () => {
  let finish;const h=harness({fetch:()=>new Promise(resolve=>{finish=resolve;})});await settle();
  await clearMicrosoftSession({application:h.app,account:owner,config:INTRANET_DEPLOYMENT_IDS,storage:h.storageApi,window:h.win});
  finish(new Response(JSON.stringify(body()),{status:200}));await settle();assert.equal(h.nodes.get('#github-selected-pulls').textContent,'Modifications : —');assert.equal(h.auto.started,false);h.instance.dispose();
});
test('Central Microsoft sign-in restores GitHub without another popup', async () => {
  const h=harness({remembered:false});await settle();
  await connectMicrosoftServices({application:h.app,config:INTRANET_DEPLOYMENT_IDS,storage:h.storageApi,window:h.win,redirectUri:'https://example.test/dashboard/auth-redirect.html'});
  assert.equal(h.calls.filter(c=>c[0]==='popup').length,1);assert.equal(h.calls.filter(c=>c[0]==='fetch').length,1);h.instance.dispose();
});
test('Invalid API payloads and explicit permission denial remove the prior snapshot', async () => {
  for(const kind of ['invalid','denied']) {let initial=true;const h=harness({fetch:()=>new Response(JSON.stringify(initial?body():{}),{status:!initial&&kind==='denied'?403:200})});await settle();await settle();initial=false;await h.instance.refresh();assert.equal(h.nodes.get('#github-selected-pulls').textContent,'Modifications : —');assert.equal(h.nodes.get('#github-selected-pulls').title,undefined);h.instance.dispose();}
});

test('Repository selection survives refresh and removed repositories cannot leave private options or links', async () => {
  let mode='all'; const h=harness({fetch:()=>new Response(JSON.stringify({...body(),projects:mode==='all'?body().projects:mode==='one'?[project('dashboard')]:[]}),{status:200})});
  await settle();await settle();const selector=h.nodes.get('#github-repository');
  assert.equal(selector.children.length,2);assert.match(selector.children[1].textContent,/privé/);
  selector.value='Soaresbm1/private-fixture';selector.listeners.get('change')();
  assert.equal(h.nodes.get('#github-selected-pulls').href,'https://github.com/Soaresbm1/private-fixture/pulls');
  await h.instance.refresh();assert.equal(selector.value,'Soaresbm1/private-fixture');
  mode='one';await h.instance.refresh();assert.equal(selector.children.length,1);assert.equal(selector.value,'Soaresbm1/dashboard-personnel');
  mode='none';await h.instance.refresh();assert.equal(selector.children.length,0);assert.equal(h.nodes.get('#github-selected-pulls').href,undefined);
  h.instance.dispose();
});
