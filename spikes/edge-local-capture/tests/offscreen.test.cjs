// Replays the real message handler with the API surface allowed in offscreen.
// These are lifecycle/save regression tests, not codec or platform evidence.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function harness({saveFailure=false,empty=false}={}){
  let listener,request,fsSaved=false,audioClosed=false;
  const track=name=>({name,stopped:false,stop(){this.stopped=true;}});
  const sourceTracks=[track('source-video'),track('source-audio')];
  const outputTrack=track('canvas-video');
  const source={getTracks:()=>sourceTracks,getAudioTracks:()=>[sourceTracks[1]]};
  const outputTracks=[outputTrack];
  const video={readyState:2,videoWidth:640,videoHeight:360,play:async()=>{},pause(){},srcObject:null};
  class Recorder{
    static isTypeSupported(){return true;}
    constructor(stream,options){this.mimeType=options.mimeType;this.state='inactive';}
    start(){this.state='recording';}
    stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable?.({data:new Blob(empty?[]:['test-recorded-bytes'])});this.onstop?.();});}
  }
  class Reader{
    readAsDataURL(blob){blob.arrayBuffer().then(data=>{this.result='data:video/webm;base64,'+Buffer.from(data).toString('base64');this.onload();});}
  }
  const context={Blob,console,queueMicrotask,setInterval,clearInterval,setTimeout,clearTimeout,
    MediaRecorder:Recorder,FileReader:Reader,
    navigator:{mediaDevices:{getUserMedia:async()=>source}},
    document:{createElement:type=>type==='video'?video:{getContext:()=>({drawImage(){}}),captureStream:()=>({getTracks:()=>outputTracks,addTrack:t=>outputTracks.push(t)})}},
    AudioContext:class{createMediaStreamSource(){return {connect(){}};}resume(){return Promise.resolve();}close(){audioClosed=true;return Promise.resolve();}},
    SPIKE_CONFIG:{base:'http://127.0.0.1:43817',token:'unit-test-only'},
    chrome:{runtime:{onMessage:{addListener:callback=>listener=callback},sendMessage:async()=>{}}},
    fetch:async(url,options)=>{request={url,body:JSON.parse(options.body)};return {ok:!saveFailure,json:async()=>saveFailure?{error:'injected write failure'}:{item:'spike-unit',bytes:19}};},
    saveItem:async()=>{fsSaved=true;return {item:'spike-fsa-unit'};}
  };
  const sourceCode=readFileSync(path.join(__dirname,'../extension/offscreen.js'),'utf8').replace(/^import \{saveItem\} from '\.\/files\.js';\r?\n/,'');
  vm.runInNewContext(sourceCode,context,{filename:'offscreen.js'});
  const call=(type,data={})=>new Promise(resolve=>listener({target:'offscreen',type,...data},{},resolve));
  return {call,sourceTracks,outputTrack,get request(){return request;},get fsSaved(){return fsSaved;},get audioClosed(){return audioClosed;}};
}
const selection={a:2,b:6,rect:{x:0,y:0,width:640,height:360},viewport:{width:640,height:360}};
async function prepare(h,saveMode='native-scratch'){
  assert.equal((await h.call('prepare',{streamId:'unit',selection,saveMode})).ok,true);
  assert.equal((await h.call('start')).ok,true);
}

test('native save works when chrome exposes runtime only',async()=>{
  const h=harness();await prepare(h);
  const result=await h.call('stop',{metadata:{source:'self-made',collectedAt:'2026-10-19'}});
  assert.equal(result.ok,true,result.error);
  assert.equal(h.request.url,'http://127.0.0.1:43817/api/save');
  assert.equal(h.request.body.metadata.source,'self-made');
  assert.equal(Buffer.from(h.request.body.base64,'base64').toString(),'test-recorded-bytes');
  assert.equal(h.fsSaved,false);
});
test('stop releases source, generated canvas track and audio context',async()=>{
  const h=harness();await prepare(h);await h.call('stop',{metadata:{}});
  assert.ok(h.sourceTracks.every(t=>t.stopped));
  assert.equal(h.outputTrack.stopped,true,'Generated canvas capture track must also stop');
  assert.equal(h.audioClosed,true);
});
test('configured browser-fsa mode is distinct from native mode',async()=>{
  const h=harness();await prepare(h,'browser-fsa');const result=await h.call('stop',{metadata:{}});
  assert.equal(result.ok,true,result.error);assert.equal(h.fsSaved,true);assert.equal(h.request,undefined);
});
test('write failure is reported and capture is released',async()=>{
  const h=harness({saveFailure:true});await prepare(h);const result=await h.call('stop',{metadata:{}});
  assert.equal(result.ok,false);assert.match(result.error,/injected write failure/);assert.ok(h.sourceTracks.every(t=>t.stopped));
});
test('empty media is not saved as a successful recording',async()=>{
  const h=harness({empty:true});await prepare(h);const result=await h.call('stop',{metadata:{}});
  assert.equal(result.ok,false);assert.match(result.error,/No media data/);assert.equal(h.request,undefined);
});
