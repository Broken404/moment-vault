import {config, roots, saveItem, promote, snapshot} from './files.js';
const output = document.querySelector('#output');
const log = async (operation, result) => {
  const entry = {at: new Date().toISOString(), operation, result};
  output.textContent = JSON.stringify(entry, null, 2);
  console.log('MV-SPIKE', entry);
  if (globalThis.SPIKE_CONFIG) {
    await fetch(`${SPIKE_CONFIG.base}/api/evidence`, {method:'POST', headers:{'Content-Type':'application/json','X-Spike-Token':SPIKE_CONFIG.token}, body:JSON.stringify(entry)}).catch(() => {});
  }
};
function button(id, operation) {
  document.querySelector(`#${id}`).onclick = async () => { try { await log(id, await operation()); } catch(error){ await log(id, {status:'failed', name:error.name, error:error.message}); } };
}
for (const kind of ['draft','library']) button(kind, async () => {
  const handle = await showDirectoryPicker({id:`mv-spike-${kind}`, mode:'readwrite'});
  await config(kind, handle);
  return {name:handle.name, permission:await handle.queryPermission({mode:'readwrite'})};
});
button('restore', async () => {
  const result = {};
  for (const kind of ['draft','library']) { const h=await config(kind); result[kind]=h ? {name:h.name,permission:await h.queryPermission({mode:'readwrite'})}:null; }
  return result;
});
button('write', async () => {
  const blob = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#245b47"/><text x="30" y="100" fill="white">Moment Vault self-made test</text></svg>'], {type:'image/svg+xml'});
  const result=await saveItem(blob,'svg',{collectedAt:new Date().toISOString(),source:'self-made test',notes:'Disposable file read/write test'});
  await config('lastItem',result.item);
  return {...result, files:await snapshot(await (await roots()).draft.getDirectoryHandle(result.item))};
});
button('promote', async () => { const item=await config('lastItem'); if(!item)throw new Error('Write a test item first');return promote(item); });
for(const kind of ['draft','library']) button(`open-${kind}`,async()=>{
  if(!globalThis.SPIKE_CONFIG)throw new Error('Local helper not configured');
  const response=await fetch(`${SPIKE_CONFIG.base}/api/open`,{method:'POST',headers:{'Content-Type':'application/json','X-Spike-Token':SPIKE_CONFIG.token},body:JSON.stringify({root:kind})});
  const result=await response.json();if(!response.ok)throw new Error(result.error);return result;
});
button('fixture', async()=> { const tab=await chrome.tabs.create({url:'http://127.0.0.1:43817/fixture.html'});return {tabId:tab.id}; });
button('refresh',async()=>chrome.storage.local.get(['session','lastResult','lastError']));
chrome.storage.onChanged.addListener(async(changes)=>{if(changes.lastResult || changes.lastError)await log('capture-result',await chrome.storage.local.get(['lastResult','lastError']));});
