import {saveItem} from './files.js';
let stream, outputStream, video, canvas, context, audio, drawId, recording, chunks=[], selection, lastBlob, saveMode;
async function release() {
  clearInterval(drawId);
  if(recording?.state==='recording')recording.stop();
  for(const track of new Set([...(stream?.getTracks() || []),...(outputStream?.getTracks() || [])]))track.stop();
  video?.pause();if(video)video.srcObject=null;
  await audio?.close().catch(()=>{});
  stream=null;outputStream=null;audio=null;video=null;recording=null;
}
async function prepare(message) {
  await release();
  selection=message.selection;
  saveMode=message.saveMode || 'browser-fsa';
  stream=await navigator.mediaDevices.getUserMedia({audio:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:message.streamId}},video:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:message.streamId,maxWidth:2560,maxHeight:1440}}});
  video=document.createElement('video');video.muted=true;video.srcObject=stream;
  await video.play();
  if(video.readyState<2)await new Promise((resolve,reject)=>{video.onloadeddata=resolve;setTimeout(()=>reject(new Error('Captured video did not become ready')),8000);});
  const audioTracks=stream.getAudioTracks();
  if(audioTracks.length){audio=new AudioContext();audio.createMediaStreamSource(stream).connect(audio.destination);await audio.resume();}
  canvas=document.createElement('canvas');
  const sx=video.videoWidth/selection.viewport.width, sy=video.videoHeight/selection.viewport.height;
  const r=selection.rect;
  canvas.width=Math.max(2,Math.round(r.width*sx/2)*2);canvas.height=Math.max(2,Math.round(r.height*sy/2)*2);
  context=canvas.getContext('2d',{alpha:false});
  const draw=()=>context.drawImage(video,r.x*sx,r.y*sy,r.width*sx,r.height*sy,0,0,canvas.width,canvas.height);
  draw();drawId=setInterval(draw,1000/30);
  outputStream=canvas.captureStream(30);for(const track of audioTracks)outputStream.addTrack(track);
  const mimeType=['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'].find(type=>MediaRecorder.isTypeSupported(type));
  if(!mimeType)throw new Error('No supported WebM recorder');
  recording=new MediaRecorder(outputStream,{mimeType,videoBitsPerSecond:4000000});
  chunks=[];recording.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
  recording.onerror=event=>chrome.runtime.sendMessage({target:'worker',type:'stop',reason:'recorder-error'});
  return {ok:true,width:canvas.width,height:canvas.height,mimeType,audioTracks:audioTracks.length};
}
async function stop(metadata) {
  if(!recording || recording.state!=='recording')throw new Error('Recorder is not running');
  const mimeType=recording.mimeType;
  await new Promise(resolve=>{recording.onstop=resolve;recording.stop();});
  const blob=new Blob(chunks,{type:mimeType});
  if(!blob.size)throw new Error('No media data received');
  // Keep the in-memory blob on a failed write for inspection/retry; do not report success.
  lastBlob=blob;
  const measured={...metadata,mimeType,capture:'tabCapture-to-canvas',width:canvas.width,height:canvas.height,audioTracks:stream.getAudioTracks().length};
  let result;
  if(saveMode==='native-scratch'){
    const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob);});
    // The MIME codecs parameter itself contains a comma (vp9,opus).
    const marker=';base64,', offset=dataUrl.indexOf(marker);
    if(offset<0)throw new Error('Recorded media could not be encoded for saving');
    const response=await fetch(SPIKE_CONFIG.base+'/api/save',{method:'POST',headers:{'Content-Type':'application/json','X-Spike-Token':SPIKE_CONFIG.token},body:JSON.stringify({base64:dataUrl.slice(offset+marker.length),extension:'webm',metadata:measured})});
    result=await response.json();if(!response.ok)throw new Error(result.error);
  }else result=await saveItem(blob,'webm',measured);
  lastBlob=null;
  return {ok:true,...result};
}
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(message.target!=='offscreen')return;
  (async()=>{
    try{
      if(message.type==='prepare')return await prepare(message);
      if(message.type==='start'){if(!recording)throw new Error('Prepare first');recording.start(250);return {ok:true};}
      if(message.type==='stop'){try{return await stop(message.metadata);}finally{await release();}}
      if(message.type==='release'){await release();return {ok:true};}
    }catch(error){await release();return {ok:false,error:error.message};}
  })().then(sendResponse);return true;
});
