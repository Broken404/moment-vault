import {saveItem} from './files.js';
import {captureGeometry} from './capture-geometry.js';
import {captureDiagnostics} from './capture-diagnostics.js';
let stream, outputStream, video, canvas, context, audio, drawId, recording, chunks=[], selection, lastBlob, saveMode, geometry, captureFrame;
let diagnostics, observerId, rawRecording, rawChunks=[];
async function release() {
  clearInterval(drawId);
  if(observerId!==undefined)video?.cancelVideoFrameCallback?.(observerId);
  observerId=undefined;
  if(rawRecording?.state==='recording')rawRecording.stop();
  if(recording?.state==='recording')recording.stop();
  for(const track of new Set([...(stream?.getTracks() || []),...(outputStream?.getTracks() || [])]))track.stop();
  video?.pause();if(video)video.srcObject=null;
  await audio?.close().catch(()=>{});
  stream=null;outputStream=null;audio=null;video=null;recording=null;rawRecording=null;diagnostics=null;
}
async function prepare(message) {
  await release();
  selection=message.selection;
  saveMode=message.saveMode || 'browser-fsa';
  if(message.diagnosticCapture&&(selection.source!==SPIKE_CONFIG.base+'/fixture.html'||saveMode!=='native-scratch'))throw new Error('Raw diagnostic control requires the self-made fixture and isolated native-scratch saving');
  stream=await navigator.mediaDevices.getUserMedia({audio:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:message.streamId}},video:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:message.streamId,maxWidth:2560,maxHeight:1440}}});
  video=document.createElement('video');video.muted=true;video.srcObject=stream;
  await video.play();
  if(video.readyState<2)await new Promise((resolve,reject)=>{video.onloadeddata=resolve;setTimeout(()=>reject(new Error('Captured video did not become ready')),8000);});
  const audioTracks=stream.getAudioTracks();
  if(audioTracks.length){audio=new AudioContext();audio.createMediaStreamSource(stream).connect(audio.destination);await audio.resume();}
  canvas=document.createElement('canvas');
  captureFrame={width:video.videoWidth,height:video.videoHeight};
  geometry=captureGeometry(captureFrame,selection.viewport,selection.rect);
  canvas.width=geometry.outputWidth;canvas.height=geometry.outputHeight;
  context=canvas.getContext('2d',{alpha:false});
  if(message.diagnosticCapture){
    diagnostics=captureDiagnostics(video);
    const observedVideo=video, observedDiagnostics=diagnostics;
    const presented=(_time,frame)=>{
      if(video!==observedVideo||diagnostics!==observedDiagnostics)return;
      observedDiagnostics.presented(frame);
      observerId=observedVideo.requestVideoFrameCallback(presented);
    };
    if(video.requestVideoFrameCallback)observerId=video.requestVideoFrameCallback(presented);
  }
  const draw=()=>{
    try{context.drawImage(video,geometry.x,geometry.y,geometry.width,geometry.height,0,0,canvas.width,canvas.height);diagnostics?.drew();}
    catch(error){diagnostics?.drawFailed();throw error;}
  };
  draw();drawId=setInterval(draw,1000/30);
  outputStream=canvas.captureStream(30);for(const track of audioTracks)outputStream.addTrack(track);
  const mimeType=['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'].find(type=>MediaRecorder.isTypeSupported(type));
  if(!mimeType)throw new Error('No supported WebM recorder');
  recording=new MediaRecorder(outputStream,{mimeType,videoBitsPerSecond:4000000});
  chunks=[];recording.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
  recording.onerror=event=>chrome.runtime.sendMessage({target:'worker',type:'stop',reason:'recorder-error'});
  rawChunks=[];
  if(diagnostics){
    rawRecording=new MediaRecorder(stream,{mimeType,videoBitsPerSecond:4000000});
    rawRecording.ondataavailable=event=>{if(event.data.size)rawChunks.push(event.data);};
    rawRecording.onerror=()=>chrome.runtime.sendMessage({target:'worker',type:'stop',reason:'diagnostic-recorder-error'});
  }
  return {ok:true,width:canvas.width,height:canvas.height,mimeType,audioTracks:audioTracks.length,diagnosticCapture:!!diagnostics};
}
async function endRecording(recorder){
  if(recorder?.state==='recording')await new Promise(resolve=>{recorder.onstop=resolve;recorder.stop();});
}
async function writeBlob(blob,metadata){
  if(saveMode!=='native-scratch')return saveItem(blob,'webm',metadata);
  const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob);});
  // The MIME codecs parameter itself contains a comma (vp9,opus).
  const marker=';base64,', offset=dataUrl.indexOf(marker);
  if(offset<0)throw new Error('Recorded media could not be encoded for saving');
  const response=await fetch(SPIKE_CONFIG.base+'/api/save',{method:'POST',headers:{'Content-Type':'application/json','X-Spike-Token':SPIKE_CONFIG.token},body:JSON.stringify({base64:dataUrl.slice(offset+marker.length),extension:'webm',metadata})});
  const result=await response.json();if(!response.ok)throw new Error(result.error);return result;
}
async function stop(metadata) {
  if(!recording || recording.state!=='recording')throw new Error('Recorder is not running');
  const mimeType=recording.mimeType;
  const observations=diagnostics?.finish();
  await Promise.all([endRecording(recording),endRecording(rawRecording)]);
  const blob=new Blob(chunks,{type:mimeType});
  if(!blob.size)throw new Error('No media data received');
  // Keep the in-memory blob on a failed write for inspection/retry; do not report success.
  lastBlob=blob;
  const measured={...metadata,mimeType,capture:'tabCapture-to-canvas',width:canvas.width,height:canvas.height,captureFrame,geometry,audioTracks:stream.getAudioTracks().length,...(observations?{diagnostics:observations,diagnosticRole:'cropped-baseline'}:{})};
  const result=await writeBlob(blob,measured);
  let diagnosticControl;
  if(observations){
    const rawBlob=new Blob(rawChunks,{type:rawRecording.mimeType});
    if(!rawBlob.size)throw new Error('Raw diagnostic control produced no media');
    diagnosticControl=await writeBlob(rawBlob,{...measured,capture:'tabCapture-direct',width:captureFrame.width,height:captureFrame.height,diagnosticRole:'raw-tab-control'});
  }
  lastBlob=null;
  return {ok:true,...result,...(diagnosticControl?{diagnosticControl}:{} )};
}
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  if(message.target!=='offscreen')return;
  (async()=>{
    try{
      if(message.type==='prepare')return await prepare(message);
      if(message.type==='start'){if(!recording)throw new Error('Prepare first');recording.start(250);rawRecording?.start(250);return {ok:true};}
      if(message.type==='stop'){try{return await stop(message.metadata);}finally{await release();}}
      if(message.type==='release'){await release();return {ok:true};}
    }catch(error){await release();return {ok:false,error:error.message};}
  })().then(sendResponse);return true;
});
