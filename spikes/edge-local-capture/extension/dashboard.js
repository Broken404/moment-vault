import {config, roots, saveItem, promote, snapshot} from './files.js';
const output=document.querySelector('#output');
async function api(path,body={}){
  const response=await fetch('/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Spike-Token':SPIKE_CONFIG.token},body:JSON.stringify(body)});
  const data=await response.json();if(!response.ok)throw new Error(data.error);return data;
}
async function extension(action){return new Promise((resolve,reject)=>{
  if(!globalThis.chrome?.runtime?.sendMessage)return reject(new Error('扩展未连接：当前测试浏览器中没有启用此扩展'));
  chrome.runtime.sendMessage(SPIKE_CONFIG.extensionId,{action},result=>{const error=chrome.runtime.lastError;if(error)return reject(new Error(error.message));if(!result?.ok)return reject(new Error(result?.error||'Extension did not respond'));resolve(result);});
});}
function button(id,operation){document.getElementById(id).onclick=async()=>{
  let result;try{result=await operation();}catch(error){result={status:'failed',error:error.message,name:error.name};}
  const entry={at:new Date().toISOString(),operation:id,origin:location.origin,result};output.textContent=JSON.stringify(entry,null,2);await api('evidence',entry).catch(()=>{});
};}
for(const kind of ['draft','library'])button(kind,async()=>{const h=await showDirectoryPicker({id:'mv-spike-'+kind,mode:'readwrite'});await config(kind,h);return {name:h.name,permission:await h.queryPermission({mode:'readwrite'})};});
button('restore',async()=>{const result={};for(const kind of ['draft','library']){const h=await config(kind);result[kind]=h?{name:h.name,permission:await h.queryPermission({mode:'readwrite'})}:null;}return result;});
const svg='<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#245b47"/><text x="30" y="100" fill="white">Moment Vault test</text></svg>';
button('write',async()=>{const result=await saveItem(new Blob([svg],{type:'image/svg+xml'}),'svg',{source:'self-made',collectedAt:new Date().toISOString(),notes:'Browser directory write/read'});await config('lastItem',result.item);return {...result,files:await snapshot(await (await roots()).draft.getDirectoryHandle(result.item))};});
button('promote',async()=>promote(await config('lastItem')));
button('status',()=>extension('status'));
button('native-mode',()=>extension('native-scratch'));
button('diagnostics',()=>extension('diagnostics'));
for(const kind of ['draft','library'])button('open-'+kind,()=>api('open',{root:kind}));
button('native-write',async()=>{const result=await api('save',{extension:'svg',base64:btoa(svg),metadata:{source:'self-made',collectedAt:new Date().toISOString(),notes:'Native helper write/read'}});await config('nativeItem',result.item);return result;});
button('native-promote',async()=>api('promote',{item:await config('nativeItem')}));
button('fixture',()=>extension('fixture'));
button('capture-result',()=>extension('status'));
button('native-promote-recording',async()=>{
  const {session,lastResult}=await extension('status');
  if(session?.phase!=='idle')throw new Error('请等待录制和保存完成');
  if(lastResult?.saveMode!=='native-scratch'||!lastResult.item)throw new Error('没有可入库的辅助录制素材');
  return api('promote',{item:lastResult.item});
});
// Local test telemetry only; this observes state and never starts a capture.
let lastCaptureState;
setInterval(async()=>{
  try{
    const {session,lastResult,lastError}=await extension('status');
    const current=JSON.stringify({session,lastResult,lastError});
    if(current===lastCaptureState)return;
    lastCaptureState=current;
    const entry={at:new Date().toISOString(),operation:'capture-live',origin:location.origin,result:{session,lastResult,lastError}};
    output.textContent=JSON.stringify(entry,null,2);await api('evidence',entry);
  }catch{/* The manual status button explains a missing extension. */}
},1000);
