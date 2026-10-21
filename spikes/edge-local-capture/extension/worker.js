import {roots} from './files.js';
import './runtime-config.js';
let creating;
async function offscreen() {
  if (!(await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})).length) {
    creating ??= chrome.offscreen.createDocument({url:'offscreen.html',reasons:['USER_MEDIA'],justification:'Explicitly requested short selected-video capture experiment'}).finally(()=>creating=null);
    await creating;
  }
}
const tell = (tabId, type, data={}) => chrome.tabs.sendMessage(tabId,{target:'content',type,...data});
const recorder = (type,data={}) => chrome.runtime.sendMessage({target:'offscreen',type,...data});
async function fail(error,tabId) {
  const lastError={at:new Date().toISOString(),message:error.message};
  await chrome.storage.local.set({lastError,session:{phase:'idle'}});
  if(tabId) await tell(tabId,'status',{phase:'failed',message:error.message}).catch(()=>{});
  await recorder('release').catch(()=>{});
}
async function start(tabId,trigger) {
  const {session} = await chrome.storage.local.get('session');
  if(session && session.phase!=='idle')return;
  await chrome.storage.local.set({session:{phase:'preparing',tabId,trigger},lastError:null});
  try {
    const {saveMode,diagnosticCapture}=await chrome.storage.local.get(['saveMode','diagnosticCapture']);
    if(saveMode!=='native-scratch')await roots();
    const selection=await tell(tabId,'prepare');
    if(!selection?.ok)throw new Error(selection?.error || 'Video selection is not ready');
    await offscreen();
    const streamId=await chrome.tabCapture.getMediaStreamId({targetTabId:tabId});
    const diagnostic=diagnosticCapture===true&&selection.source===SPIKE_CONFIG.base+'/fixture.html';
    const ready=await recorder('prepare',{streamId,selection,saveMode:saveMode || 'browser-fsa',diagnosticCapture:diagnostic});
    if(!ready?.ok)throw new Error(ready?.error || 'Capture stream failed');
    const begun=await recorder('start');
    if(!begun?.ok)throw new Error(begun?.error || 'Recorder did not start');
    await chrome.storage.local.set({session:{phase:'recording',tabId,trigger,selection,startedAt:new Date().toISOString()}});
    const played=await tell(tabId,'play');
    if(!played?.ok)throw new Error(played?.error || 'Source did not play');
  } catch(error){await fail(error,tabId);}
}
async function stop(reason='manual-shortcut') {
  const {session}=await chrome.storage.local.get('session');
  if(session?.phase!=='recording')return;
  await chrome.storage.local.set({session:{...session,phase:'saving'}});
  try {
    const end=await tell(session.tabId,'stop').catch(()=>({actualEnd:null}));
    const result=await recorder('stop',{metadata:{...session.selection,source:session.selection.source,trigger:session.trigger,collectedAt:session.startedAt,stoppedAt:new Date().toISOString(),stopReason:reason,actualStart:session.selection.a,actualEnd:end.actualEnd}});
    if(!result?.ok)throw new Error(result?.error || 'Save failed');
    await chrome.storage.local.set({session:{phase:'idle'},lastResult:result,lastError:null});
    await tell(session.tabId,'status',{phase:'saved',message:'已存入测试草稿箱：'+result.item}).catch(()=>{});
  } catch(error){await fail(error,session.tabId);}
}
let lastCommand=0;
chrome.commands.onCommand.addListener(async command=>{
  if(command!=='record-selection' || Date.now()-lastCommand<400)return;
  lastCommand=Date.now();
  const {session}=await chrome.storage.local.get('session');
  if(session?.phase==='recording')return stop();
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if(tab?.id)await start(tab.id,'extension-command');
});
chrome.action.onClicked.addListener(async tab=>{
  if(!tab.id)return;
  try{await tell(tab.id,'show');}catch{await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});}
});
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(message.target!=='worker')return;
  if(message.type==='shortcut-status'){
    chrome.commands.getAll().then(commands=>sendResponse({ok:true,shortcut:commands.find(command=>command.name==='record-selection')?.shortcut || ''}));return true;
  }
  const task=message.type==='page-start' ? start(sender.tab.id,'page-button') : message.type==='stop' ? stop(message.reason) : null;
  if(task){task.then(()=>sendResponse({ok:true})).catch(error=>sendResponse({ok:false,error:error.message}));return true;}
});
chrome.tabs.onRemoved.addListener(async tabId=>{
  const {session}=await chrome.storage.local.get('session');
  if(session?.tabId===tabId)await stop('source-tab-closed');
});
chrome.runtime.onMessageExternal.addListener((message,sender,sendResponse)=>{
  if(sender.origin!=='http://127.0.0.1:43817' || !sender.url?.startsWith('http://127.0.0.1:43817/'))return;
  (async()=>{
    if(message.action==='status')return {ok:true,build:chrome.runtime.getManifest().version,diagnosticsVersion:1,...await chrome.storage.local.get(['session','lastResult','lastError','saveMode','diagnosticCapture']),commands:await chrome.commands.getAll()};
    if(message.action==='diagnostics'){
      const {session}=await chrome.storage.local.get('session');
      if(session&&session.phase!=='idle')throw new Error('Wait for the current capture to finish');
      await chrome.storage.local.set({diagnosticCapture:true});return {ok:true,diagnosticCapture:true,scope:'self-made fixture only; no capture starts from this action'};
    }
    if(message.action==='fixture'){const tab=await chrome.tabs.create({url:'http://127.0.0.1:43817/fixture.html'});return {ok:true,tabId:tab.id};}
    if(message.action==='native-scratch'){
      const response=await fetch(SPIKE_CONFIG.base+'/api/ready',{method:'POST',headers:{'Content-Type':'application/json','X-Spike-Token':SPIKE_CONFIG.token},body:'{}'});
      const result=await response.json();if(!response.ok)throw new Error(result.error);
      await chrome.storage.local.set({saveMode:'native-scratch'});return {ok:true,...result};
    }
    throw new Error('Unsupported dashboard action');
  })().then(sendResponse).catch(error=>sendResponse({ok:false,error:error.message}));return true;
});
