import {icon,escapeHTML as esc,plot,download,csvCell} from './ui.js';
import {MoPodDevice,abortError} from './device.js';
import {ConcentrationModels} from './models.js';
import {RecordStore} from './storage.js';
import {APPLICATIONS,STATES,ApplicationModels,demoResult,normalizeResult} from './results.js';

const device=new MoPodDevice(), models=new ConcentrationModels(), store=new RecordStore(), applications=new ApplicationModels();
const content=document.querySelector('#content');
const defaults={keepAwake:true,autoSave:true,demo:false};
let settings={...defaults};
try{settings={...defaults,...JSON.parse(localStorage.getItem('mopod-v5-settings')||'{}')};}catch{}
let route=[], records=[], storageReady=false, activeRecord=null, quick=null, appJob=null, wakeLock=null, toastTimer;
let historyType='all', historyDate='all';
const demoStates={}, logs=[];
const now=()=>Date.now();
const dateText=time=>new Date(time).toLocaleString('en-GB',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
const recordName=record=>record.type==='quick'?'Quick Scan':APPLICATIONS[record.type]?.name||'Detection';
const button=(action,label,style='primary',glyph='',disabled=false)=>`<button class="button ${style}" data-action="${action}" ${disabled?'disabled':''}>${glyph?icon(glyph):''}${label}</button>`;
function toast(message){clearTimeout(toastTimer);const t=document.querySelector('#toast');t.textContent=message;t.hidden=false;toastTimer=setTimeout(()=>t.hidden=true,4800);}
function log(message){logs.push(`${new Date().toLocaleTimeString('en-GB')} ${message}`);if(logs.length>100)logs.shift();}
function busy(){return Boolean(quick?.processing||appJob);}
function saveSettings(){try{localStorage.setItem('mopod-v5-settings',JSON.stringify(settings));}catch{toast('Settings could not be saved in this browser.');}}
async function confirmAction(title,message){
  const dialog=document.querySelector('#confirmDialog');document.querySelector('#confirmTitle').textContent=title;document.querySelector('#confirmMessage').textContent=message;
  dialog.returnValue='cancel';dialog.showModal();return new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm'),{once:true}));
}
function go(path){location.hash='/'+path;}
function getRoute(){return (location.hash.slice(1)||'/home').replace(/^\//,'').split('/').filter(Boolean);}
function renderNavigation(){
  const current=route[0], active=current==='history'?'history':current==='models'?'models':current==='settings'?'settings':'home';
  document.querySelector('#navigation').innerHTML=[['home','analysis','Analysis'],['history','history','History'],['models','model','Model'],['settings','settings','Settings']].map(([path,glyph,label])=>`<a href="#/${path}" ${active===path?'class="active" aria-current="page"':''}>${icon(glyph)}<span>${label}</span></a>`).join('');
  const back=document.querySelector('#back');back.hidden=current==='home';back.innerHTML=icon('back');
  const bt=document.querySelector('#bluetooth');bt.innerHTML=icon('bluetooth');bt.classList.toggle('connected',device.connected);bt.classList.toggle('connecting',device.status==='connecting');bt.disabled=busy()||device.status==='connecting';bt.title=device.connected?'Device connected':'Connect device';
  document.querySelector('#menu').innerHTML=icon('more');
}
function deviceStrip(){return `<section class="card connection-strip"><span class="dot ${device.connected?'online':''}" style="${device.connected?'background:#32c558':''}"></span><div><strong class="small">${device.status==='connecting'?'Connecting…':device.connected?'Device connected':'Device disconnected'}</strong><div class="device-name muted">${esc(device.name||'Connect your MoPod')}</div></div>${!device.connected?`<button class="inline-link" data-action="connect" ${busy()?'disabled':''}>Connect</button>`:''}</section>`;}
function devicePicture(){return `<div class="device-drawing" aria-hidden="true"><svg viewBox="0 0 100 110"><defs><linearGradient id="deviceFront" x2="1" y2="1"><stop stop-color="#fff"/><stop offset="1" stop-color="#cdd4d8"/></linearGradient></defs><path d="m10 19 42-9 37 12-1 69-40 11-36-16Z" fill="url(#deviceFront)" stroke="#c1cbd1"/><path d="m10 19 38 14 41-11M48 33v69" fill="none" stroke="#bac6cc"/><ellipse cx="51" cy="21" rx="6" ry="2.5" fill="#1ba5f5"/><circle cx="67" cy="56" r="3" fill="#28647a"/><circle cx="61" cy="85" r="4" fill="none" stroke="#a8b7c0"/><circle cx="74" cy="82" r="4" fill="none" stroke="#a8b7c0"/><path d="M20 43v4m7-2v4m7-2v4M20 53v4m7-2v4m7-2v4M20 63v4m7-2v4m7-2v4" stroke="#7e8e99" stroke-width="2"/></svg></div>`;}
function homePage(){
  return `<button class="card device-card" data-action="device-info">${devicePicture()}<div class="device-body"><span class="device-status ${device.connected?'connected':''}"><span class="dot"></span>${device.status==='connecting'?'Connecting…':device.connected?'Device connected':'Device disconnected'}</span><span class="device-name">${esc(device.name||'MoPod')}</span><span class="telemetry"><span>Battery —</span><span>Temp —</span></span></div>${icon('chevron')}</button><h1 class="section-title">Application scenarios</h1><section class="scenarios" aria-label="Application scenarios">${Object.entries(APPLICATIONS).map(([key,app])=>`<a class="card scenario-card ${key}" href="#/application/${key}">${icon(app.icon)}<strong>${app.name}</strong><span>${app.subtitle}</span></a>`).join('')}</section><a class="button primary quick-entry" href="#/quick">${icon('play')}Quick Scan</a>${settings.demo?'<div class="notice"><span class="demo-badge">Demo Mode</span> Application results are illustrative.</div>':''}`;
}
function quickPage(){return `<h1 class="page-title">Quick Scan</h1><p class="subtitle">Real-time concentration detection</p>${deviceStrip()}<section class="card controls">${button('start-quick','Start Detection','primary','play',busy()||!device.connected||!models.ready)}${button('stop-quick','Stop Detection','danger','stop',!quick?.running)}</section><section class="card quick-result" aria-live="polite"><span class="label">Detection result</span><div id="quickValue" class="result-value"></div><div id="quickDetail" class="quick-detail"></div></section><section class="card chart-card"><h2>Concentration over time</h2><canvas class="chart" id="quickChart" aria-label="Predicted concentration over cumulative time" role="img"></canvas>${button('export-quick','Download CSV','secondary export-button','download',!quick?.record?.points.length)}</section><div id="quickNotice"></div><details class="card"><summary>Activity log</summary><pre class="activity-log">${esc(logs.join('\n'))}</pre></details>`;}
function updateQuick(){
  if(route[0]!=='quick')return;
  const points=quick?.record?.points||[],latest=points.at(-1);
  document.querySelector('#quickValue').textContent=latest?`${latest.concentration.toFixed(2)}%`:quick?.running?'Detecting…':'Ready';
  let detail=latest?'Predicted concentration':quick?.processing?'Waiting for concentration data':'Tap Start Detection to begin';
  if(!models.ready&&!quick?.processing)detail=models.state==='loading'?'Preparing detection…':models.state==='error'?'Detection unavailable':'Preparing detection…';
  document.querySelector('#quickDetail').innerHTML=`<span>${esc(detail)}</span><span>${latest?`${latest.timeSeconds.toFixed(1)} s`:''}</span>`;
  document.querySelector('[data-action="start-quick"]').disabled=busy()||!device.connected||!models.ready;
  document.querySelector('[data-action="stop-quick"]').disabled=!quick?.running;
  document.querySelector('[data-action="export-quick"]').disabled=!points.length;
  const message=quick?.error||models.error||'';
  document.querySelector('#quickNotice').innerHTML=message?`<p class="notice error">${esc(message)}</p>`:'';
  plot(document.querySelector('#quickChart'),points);
}
function selectedResult(type){return settings.demo?demoResult(type,demoStates[type]):applications.results.get(type)||normalizeResult(type);}
function resultCard(result){
  const app=APPLICATIONS[result.type], state=STATES[result.type][result.status];
  const sampleLabel=result.type==='water'&&!['detected','high'].includes(result.status)?'Target Contaminant':app.sampleLabel;
  return `<section class="card application-result tone-${state.tone}" aria-live="polite"><div class="sample-block"><span class="label">${sampleLabel}</span><div class="sample-name">${esc(result.sampleName)}</div></div><span class="label assessment-label">${app.assessmentLabel}</span><div class="state-symbol">${icon(state.icon)}</div><h2 class="state-title">${state.label}</h2><p class="result-description">${state.description}</p>${result.concentration?`<div class="concentration-inset"><span class="label">${result.type==='safety'?esc(result.concentration.analyte)+' Concentration':'Predicted Concentration'}</span><strong>${result.concentration.value.toFixed(1)}</strong> <small>${result.concentration.unit}</small></div>`:''}<div class="result-source">${result.source==='demo'?'Illustrative result':result.status===app.fallback?'No verified result available':'Model prediction'}</div></section>`;
}
function applicationPage(type){
  if(!Object.hasOwn(APPLICATIONS,type))return notFound();
  const app=APPLICATIONS[type];
  const result=selectedResult(type);
  return `<div class="result-page"><div class="heading-row"><div class="icon-tile ${type}">${icon(app.icon)}</div><h1>${app.title}</h1>${settings.demo?'<span class="demo-badge">Demo Mode</span>':''}</div>${resultCard(result)}<div class="result-actions">${button('scan-'+type,appJob?.type===type?'Detecting…':'Scan Again','primary','reload',busy())}${button('home','Back to Home','secondary','home')}</div></div>`;
}
function historyPage(){
  const filtered=records.filter(r=>(historyType==='all'||r.type===historyType)&&(historyDate==='all'||new Date(r.startedAt).toDateString()===new Date(historyDate).toDateString()));
  const dates=[...new Set(records.map(r=>new Date(r.startedAt).toLocaleDateString('en-CA')))];
  return `<div class="title-actions"><h1 class="page-title">History</h1><button class="button secondary" data-action="filter">Filter</button></div><div class="filters"><select id="typeFilter" aria-label="Filter record type"><option value="all">All types</option>${['quick',...Object.keys(APPLICATIONS)].map(type=>`<option value="${type}" ${historyType===type?'selected':''}>${type==='quick'?'Quick Scan':APPLICATIONS[type].name}</option>`).join('')}</select><select id="dateFilter" aria-label="Filter date"><option value="all">All dates</option>${dates.map(date=>`<option ${historyDate===date?'selected':''} value="${date}">${esc(date)}</option>`).join('')}</select></div>${!filtered.length?`<div class="card empty">${icon('history')}<h2>${records.length?'No matching records':'No records yet'}</h2><p class="subtitle">Your completed and interrupted detections will appear here.</p><a class="button primary" href="#/quick">Start a Quick Scan</a></div>`:filtered.map((record,index)=>{
    const prior=filtered[index-1];const date=new Date(record.startedAt).toDateString();let group=date;
    if(date===new Date().toDateString())group='Today';else if(date===new Date(now()-86400000).toDateString())group='Yesterday';
    const latest=record.points?.at(-1);const value=record.type==='quick'?(latest?latest.concentration.toFixed(2)+'%':'No prediction'):STATES[record.type]?.[record.result?.status]?.label||'Unavailable';
    return `${!prior||new Date(prior.startedAt).toDateString()!==date?`<h2 class="section-title">${esc(group)}</h2>`:''}<a class="card record-card" href="#/history/${encodeURIComponent(record.id)}"><div class="record-top">${icon(record.type==='quick'?'play':APPLICATIONS[record.type]?.icon)}<strong>${recordName(record)}</strong><span class="pill ${record.status}">${record.status==='running'?'Detecting':record.status[0].toUpperCase()+record.status.slice(1)}</span>${record.source==='demo'?'<span class="demo-badge">Demo</span>':''}</div><span class="small muted">${dateText(record.startedAt)}</span><div class="record-middle"><div><div class="record-number" style="${record.type==='quick'?'':'font-size:19px'}">${esc(value)}</div><span class="small muted">${record.status==='completed'?'Final prediction':'Last prediction'}</span></div>${record.type==='quick'?`<canvas class="sparkline" data-record-chart="${record.id}" aria-label="Concentration trend"></canvas>`:''}${icon('chevron')}</div><div class="record-bottom">${Math.round((record.durationMs||0)/1000)} s${record.type==='quick'?` · ${record.points.length} results`:''}</div></a>`;
  }).join('')}<p class="small muted" style="text-align:center">${storageReady?'Saved in this browser':'Local storage unavailable'}</p>`;
}
function historyDetail(id){
  const record=records.find(r=>r.id===id)||(quick?.record.id===id?quick.record:null);if(!record)return notFound('Record not found');
  activeRecord=record;
  const points=record.points||[],latest=points.at(-1);
  return `<h1 class="page-title">Record details</h1><section class="card"><div class="record-top"><strong>${recordName(record)}</strong><span class="pill ${record.status}">${esc(record.status)}</span>${record.source==='demo'?'<span class="demo-badge">Demo Mode</span>':''}</div><span class="small muted">${dateText(record.startedAt)}</span>${record.type==='quick'?`<div class="result-value">${latest?latest.concentration.toFixed(2)+'%':'—'}</div><span class="small muted">${record.status==='completed'?'Final prediction':'Last prediction'} · ${Math.round(record.durationMs/1000)} s · ${points.length} results</span>`:''}</section>${record.type==='quick'?`<section class="card chart-card"><h2>Concentration over time</h2><canvas id="historyChart" class="chart" role="img" aria-label="Recorded concentration curve"></canvas></section><section class="card"><h2 class="section-title" style="margin-top:0">Prediction summary</h2><div class="summary-stats">${[['Minimum',points.length?Math.min(...points.map(p=>p.concentration)):null],['Maximum',points.length?Math.max(...points.map(p=>p.concentration)):null],['Final',latest?.concentration]].map(([name,n])=>`<div><span>${name}</span><strong>${n==null?'—':n.toFixed(2)+'%'}</strong></div>`).join('')}</div></section>`:resultCard(record.result)}${button('export-record','Download CSV','primary','download')}${button('delete-record','Delete record','danger','trash',busy()&&quick?.record.id===record.id)}<p class="small muted" style="text-align:center">Deletion requires confirmation.</p>`;
}
const modelItems=[['concentration','Concentration','model'],...Object.entries(APPLICATIONS).map(([key,a])=>[key,a.name,a.icon])];
function modelPage(){return `<h1 class="page-title">Model</h1><p class="subtitle">Select a model</p><div class="model-list">${modelItems.map(([type,name,glyph])=>`<a class="card model-entry" href="#/models/${type}"><span class="icon-tile ${type}">${icon(glyph)}</span><strong>${name}</strong>${icon('chevron')}</a>`).join('')}</div>`;}
function modelDetail(type){
  const item=modelItems.find(row=>row[0]===type);if(!item)return notFound();
  const concentration=type==='concentration';const provider=applications.providers.get(type);
  return `<h1 class="page-title">${item[1]}</h1><p class="subtitle">Model details</p><section class="card"><div class="detail-heading"><div class="icon-tile ${type}">${icon(item[2])}</div><h2>${concentration?'Concentration Model':item[1]+' Model'}</h2></div><div class="rows detail-grid"><div class="row"><span class="row-label">Status</span><span class="row-value">${concentration?(models.ready?'Ready':models.state==='loading'?'Loading':'Not loaded'):provider?'Configured':'Not configured'}</span></div><div class="row"><span class="row-label">${concentration?'Version':'Model ID'}</span><span class="row-value">${concentration?'V8 · Five-fold ensemble':esc(provider?.metadata.modelId||'—')}</span></div><div class="row"><span class="row-label">Input</span><span class="row-value">224 samples · CH2 + CH3</span></div>${concentration?'<div class="row"><span class="row-label">Output range</span><span class="row-value">0–100%</span></div><div class="row"><span class="row-label">Solution system</span><span class="row-value">To be confirmed</span></div>':''}</div></section>${concentration?`<section class="card"><span class="label">MODEL LOADING</span><div class="fold-grid">${models.folds.map((state,i)=>`<div class="fold">Fold ${i+1}<strong>${state}</strong></div>`).join('')}</div><p class="notice">Average of 5 models. Use with the matching trained solution system.</p>${button('reload-models','Reload Models','primary','reload',busy()||models.state==='loading')}${models.error?`<p class="notice error">${esc(models.error)}</p>`:''}</section>`:`<section class="card"><p class="small muted">${type==='safety'?'Requires the validated 31-liquid classifier and verified hazard references.':type==='food'?'Apple reference groups: Fresh, Intermediate, Aged.':type==='pharma'?'Reference formulation comparison. This does not determine expiry or pharmacopoeial compliance.':'Target: ethylene glycol. Identification and concentration require separate validated support.'}</p>${settings.demo?`<label class="label" for="demoState">Demo result</label><select id="demoState" data-type="${type}">${Object.entries(STATES[type]).map(([key,value])=>`<option value="${key}" ${(demoStates[type]||demoResult(type).status)===key?'selected':''}>${value.label}</option>`).join('')}</select>`:''}<a class="button ${settings.demo?'primary':'secondary'}" style="margin-top:15px" href="#/application/${type}">${settings.demo?'Preview Demo Result':'Open Result Page'}</a></section>`}`;
}
function settingsPage(){
  const row=(glyph,label,value,action='')=>`<${action?'button':'div'} class="row" ${action?`data-action="${action}"`:''}>${icon(glyph)}<span class="row-label">${label}</span>${value?`<span class="row-value">${value}</span>`:''}${action?icon('chevron'):''}</${action?'button':'div'}>`;
  const toggle=(key,label,glyph)=>`<label class="row">${icon(glyph)}<span class="row-label">${label}</span><input class="switch" type="checkbox" data-setting="${key}" aria-label="${label}" ${settings[key]?'checked':''} ${busy()&&key!=='keepAwake'?'disabled':''}></label>`;
  return `<h1 class="page-title">Settings</h1><h2 class="group-label">DEVICE</h2><section class="card rows">${row('link','Bluetooth device',device.status==='connecting'?'Connecting…':device.connected?'Connected':'Disconnected','connect')}${row('info','Device information',esc(device.name||'—'),'device-info')}${device.connected?row('bluetooth','Disconnect device','','disconnect'):''}</section><h2 class="group-label">DETECTION</h2><section class="card rows">${toggle('keepAwake','Keep screen awake','eye')}${row('info','Auto-stop limit','600 s')}${toggle('demo','Demo Mode','play')}</section><h2 class="group-label">DATA & STORAGE</h2><section class="card rows">${toggle('autoSave','Auto-save records','history')}${row('download','Export all records','','export-all')}<button class="row destructive" data-action="clear-records" ${busy()?'disabled':''}>${icon('trash')}<span class="row-label">Clear local records</span>${icon('chevron')}</button><p class="small muted">${storageReady?'Records are stored in this browser.':'Local record storage is unavailable.'}</p></section><h2 class="group-label">ABOUT</h2><section class="card rows">${row('info','App version','V5')}${row('info','About MoPod','','about')}</section>`;
}
function notFound(message='Page not found'){return `<div class="card empty"><h1>${message}</h1><a class="button primary" href="#/home">Back to Home</a></div>`;}
function render(preserveScroll=false){
  route=getRoute();const scroll=content.scrollTop;const [page,id]=route;
  renderNavigation();activeRecord=null;
  content.innerHTML=page==='home'?homePage():page==='quick'?quickPage():page==='application'?applicationPage(id):page==='history'?(id?historyDetail(decodeURIComponent(id)):historyPage()):page==='models'?(id?modelDetail(id):modelPage()):page==='settings'?settingsPage():notFound();
  content.scrollTop=preserveScroll?scroll:0;
  if(page==='quick'){updateQuick();if(models.state==='idle')void models.load();}
  if(page==='history'){
    if(id&&activeRecord?.type==='quick')plot(document.querySelector('#historyChart'),activeRecord.points);
    else document.querySelectorAll('[data-record-chart]').forEach(canvas=>plot(canvas,records.find(r=>r.id===canvas.dataset.recordChart)?.points||[],{mini:true}));
  }
}
async function refreshRecords(){if(storageReady){records=await store.list();if(route[0]==='history')render(true);}}
async function persist(record,round){
  if(!record.autoSave||!storageReady)return;
  try{if(round)await store.saveRound(record.id,round.roundNumber,round.samples);await store.save(structuredClone(record));}
  catch(error){record.autoSave=false;toast('Record storage failed. Download this run before leaving the page.');log(error.message);}
}
async function requestWake(){
  if(!settings.keepAwake||!busy()||document.visibilityState!=='visible'||wakeLock)return;
  try{wakeLock=await navigator.wakeLock?.request('screen');wakeLock?.addEventListener('release',()=>wakeLock=null);}catch(error){log(`Screen wake lock: ${error.message}`);}
}
async function releaseWake(){try{await wakeLock?.release();}catch{}wakeLock=null;}
function createRecord(type,source='live_model'){
  return {id:crypto.randomUUID(),type,source,startedAt:now(),durationMs:0,status:'running',points:[],autoSave:settings.autoSave,modelId:type==='quick'?models.metadata?.modelName:applications.providers.get(type)?.metadata.modelId||null};
}
async function startQuick(){
  if(busy())return;
  if(!device.connected){toast('Connect your MoPod first.');return;}
  if(!models.ready){toast('The concentration model is not ready.');return;}
  const controller=new AbortController(),record=createRecord('quick');
  const job={record,controller,running:true,processing:true,error:'',rawRounds:[],chain:Promise.resolve(),inferenceErrors:0,reason:'completed'};quick=job;
  log('Quick Scan started.');render(true);void requestWake();await persist(record);
  const timeout=setTimeout(()=>{job.reason='completed';controller.abort();},600000);
  try{
    await device.configure(controller.signal);
    for(let roundNumber=1;roundNumber<=400&&!controller.signal.aborted;roundNumber++){
      const samples=await device.collect(controller.signal);
      const round={roundNumber,samples};job.rawRounds.push(round);
      // Schedule inference separately: the next collect starts without awaiting it.
      job.chain=job.chain.then(async()=>{
        try{
          const concentration=await models.predict(samples);
          record.points.push({roundNumber,timeSeconds:roundNumber*1.5,concentration});
          record.durationMs=now()-record.startedAt;updateQuick();
        }catch(error){job.inferenceErrors++;job.error=`Prediction unavailable: ${error.message}`;log(job.error);updateQuick();}
        await persist(record,round);
      });
    }
  }catch(error){
    if(error.name!=='AbortError'){job.reason='interrupted';job.error=error.message;log(error.message);}
  }finally{
    clearTimeout(timeout);job.running=false;
    try{await device.shutdown();}catch(error){job.reason='interrupted';job.error=`Device stop failed: ${error.message}`;}
    updateQuick();await job.chain;job.processing=false;
    record.durationMs=now()-record.startedAt;record.status=job.reason;
    if(job.inferenceErrors&&record.status==='completed')record.status='interrupted';
    await persist(record);await refreshRecords();await releaseWake();
    log(`Quick Scan ${record.status}.`);if(route[0]==='quick')render(true);else{render(true);toast(`Quick Scan ${record.status}.`);}
  }
}
function stopQuick(reason='stopped'){if(quick?.running){quick.reason=reason;quick.running=false;quick.controller.abort();updateQuick();}}
async function scanApplication(type){
  if(busy())return;
  if(settings.demo){applications.results.delete(type);render(true);await saveApplicationResult(demoResult(type,demoStates[type]));return;}
  if(!applications.providers.has(type)){applications.setResult(type,{});render(true);toast('This application model is not configured. No result was generated.');return;}
  if(!device.connected){toast('Connect your MoPod first.');return;}
  const controller=new AbortController();appJob={type,controller};render(true);void requestWake();
  try{
    await device.configure(controller.signal);
    const result=await applications.scan(type,controller.signal,async signal=>{
      const samples=await device.collect(signal);await device.shutdown();return samples;
    });
    await saveApplicationResult(result);
  }catch(error){applications.setResult(type,{});toast(error.message);}
  finally{try{await device.shutdown();}catch(error){toast(error.message);}appJob=null;await releaseWake();render(true);}
}
async function saveApplicationResult(result){
  const record=createRecord(result.type,result.source);record.result=result;record.status='completed';
  await persist(record);await refreshRecords();
}
async function connect(){if(busy()){toast('Stop the current detection before changing the device.');return;}try{await device.connect();}catch(error){toast(error.message);}}
async function exportRecord(record){
  if(!record)return;
  if(record.type!=='quick'){
    const result=record.result;download(`mopod_${record.type}_${record.id}.csv`,'\ufeff'+['Application,Source,Sample,Result,Concentration,Unit,Started_at',[
      record.type,result.source,result.sampleName,STATES[record.type][result.status].label,result.concentration?.value??'',result.concentration?.unit??'',new Date(record.startedAt).toISOString(),
    ].map(csvCell).join(',')].join('\r\n'));return;
  }
  const rounds=quick?.record.id===record.id?quick.rawRounds:storageReady?await store.rounds(record.id):[];
  const predictions=new Map(record.points.map(p=>[p.roundNumber,p]));
  const rows=['Round,Time_s,Concentration_percent,Sample_Index,ESP_Time_us,Elapsed_In_Round_ms,CH2_mV,CH3_mV,Device_Round_Index'];
  for(const round of rounds){const first=round.samples[0]?.espTimeUs;const prediction=predictions.get(round.roundNumber);for(const sample of round.samples)rows.push([
    round.roundNumber,(round.roundNumber*1.5).toFixed(1),prediction?prediction.concentration.toFixed(6):'',sample.sampleIndex,sample.espTimeUs,((sample.espTimeUs-first)/1000).toFixed(3),sample.ch2,sample.ch3,sample.roundIndex,
  ].join(','));}
  if(!rounds.length){toast('Raw samples are not available for this record.');return;}
  download(`concentration_${new Date(record.startedAt).toISOString().replace(/[:.]/g,'-')}.csv`,'\ufeff'+rows.join('\r\n'));
}
async function handleAction(action){
  if(action==='home'){go('home');return;}
  if(action==='connect'){await connect();return;}
  if(action==='device-info'){go('settings/device');return;}
  if(action==='start-quick'){void startQuick();return;}
  if(action==='stop-quick'){stopQuick();return;}
  if(action.startsWith('scan-')){void scanApplication(action.slice(5));return;}
  if(action==='export-quick'){await exportRecord(quick?.record);return;}
  if(action==='export-record'){await exportRecord(activeRecord);return;}
  if(action==='filter'){document.querySelector('#typeFilter')?.focus();return;}
  if(action==='reload-models'){if(!busy())await models.load();return;}
  if(action==='delete-record'){
    if(!activeRecord)return;const id=activeRecord.id;
    if(busy()&&quick?.record.id===id)return;
    if(await confirmAction('Delete record?','This removes this detection and its locally stored samples.')){await store.delete(id);if(quick?.record.id===id)quick=null;await refreshRecords();go('history');}
    return;
  }
  if(action==='clear-records'){
    if(busy())return;
    if(await confirmAction('Clear all records?','This permanently removes detection history stored in this browser.')){await store.clear();records=[];quick=null;render(true);toast('Local records cleared.');}return;
  }
  if(action==='export-all'){
    if(!storageReady){toast('Local storage is unavailable.');return;}
    const all=await store.list();const bundle=[];
    for(const record of all)bundle.push({record,rounds:record.type==='quick'?await store.rounds(record.id):[]});
    download('mopod-v5-records.json',JSON.stringify({version:5,exportedAt:new Date().toISOString(),records:bundle},null,2),'application/json');return;
  }
  if(action==='disconnect'){
    if(busy()){toast('Stop the current detection before disconnecting.');return;}
    await device.disconnect();render(true);return;
  }
  if(action==='about'){go('settings/about');}
}
function settingsSubpage(type){
  if(type==='device')return `<h1 class="page-title">Device information</h1>${deviceStrip()}<section class="card rows detail-grid"><div class="row"><span class="row-label">Device name</span><span class="row-value">${esc(device.name||'—')}</span></div><div class="row"><span class="row-label">Connection</span><span class="row-value">Bluetooth Low Energy</span></div><div class="row"><span class="row-label">Battery / temperature</span><span class="row-value">Not provided by device</span></div><div class="row"><span class="row-label">Filter position</span><span class="row-value">Telemetry unavailable</span></div></section>${button(device.connected?'disconnect':'connect',device.connected?'Disconnect':'Connect to ESP32','secondary','bluetooth',busy())}`;
  return `<h1 class="page-title">About MoPod</h1><section class="card"><h2>MoPod V5</h2><p class="small muted">A mobile near-infrared sensing interface. Quick Scan uses the bundled V8 five-fold concentration model. Application-specific models must be configured separately.</p><p class="notice">Demo Mode contains illustrative results and is not a measurement.</p><p class="small muted">Records are kept in this browser. Export records before clearing browser data.</p></section>`;
}
// Special settings routes share the same shell and bottom navigation.
const renderBase=render;
function routeRender(preserve=false){renderBase(preserve);if(route[0]==='settings'&&route[1]){content.innerHTML=settingsSubpage(route[1]);if(!preserve)content.scrollTop=0;}}

document.addEventListener('click',event=>{
  const target=event.target.closest('[data-action]');if(target&&!target.disabled)handleAction(target.dataset.action).catch(error=>toast(error.message));
});
document.querySelector('#back').addEventListener('click',()=>{
  if(route[0]==='history'&&route[1])go('history');else if(route[0]==='models'&&route[1])go('models');else if(route[0]==='settings'&&route[1])go('settings');else go('home');
});
document.querySelector('#bluetooth').addEventListener('click',()=>void connect());
document.addEventListener('change',async event=>{
  const target=event.target;
  if(target.dataset.setting){
    const key=target.dataset.setting;
    if(busy()&&key!=='keepAwake'){target.checked=settings[key];return;}
    settings[key]=target.checked;saveSettings();
    if(key==='keepAwake'){if(settings[key])void requestWake();else void releaseWake();}
    if(key==='demo'){applications.results.clear();toast(settings.demo?'Demo Mode enabled. Application results are illustrative.':'Live mode enabled. Only verified model results will be shown.');}
    routeRender(true);
  }
  if(target.id==='typeFilter'){historyType=target.value;render();}
  if(target.id==='dateFilter'){historyDate=target.value;render();}
  if(target.id==='demoState')demoStates[target.dataset.type]=target.value;
});
window.addEventListener('hashchange',()=>routeRender());
device.addEventListener('change',()=>{if(route[0]==='quick'){renderNavigation();const strip=document.querySelector('.connection-strip');if(strip)strip.outerHTML=deviceStrip();updateQuick();}else routeRender(true);});
device.addEventListener('disconnected',()=>{if(quick?.running){quick.reason='interrupted';quick.error='Bluetooth connection interrupted.';quick.controller.abort();}appJob?.controller.abort();});
models.addEventListener('change',()=>{if(route[0]==='quick')updateQuick();else if(route[0]==='models')routeRender(true);});
applications.addEventListener('change',()=>{if(route[0]==='application'||route[0]==='models')routeRender(true);});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void requestWake();});
window.addEventListener('resize',()=>{updateQuick();if(route[0]==='history')routeRender(true);});
window.addEventListener('pagehide',()=>{if(quick?.running)stopQuick('interrupted');appJob?.controller.abort();void device.shutdown().catch(()=>{});});
// Stable integration interface: real application adapters never fall back to demo data.
window.MoPod={
  version:'V5',registerApplication:(type,provider,metadata)=>applications.register(type,provider,metadata),
  updateApplicationResult:(type,payload)=>applications.setResult(type,payload),
  openApplication:type=>go('application/'+type),
};
if(!location.hash)history.replaceState(null,'','#/home');routeRender();
store.open().then(async()=>{storageReady=true;await refreshRecords();if(route[0]==='settings'||route[0]==='history')routeRender(true);}).catch(error=>{log(error.message);toast('Local storage unavailable. Records will not be saved.');});
