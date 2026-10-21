const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

test('diagnostic samples stay bounded while retaining input, draw and presentation counters',()=>{
  const source=readFileSync(path.join(__dirname,'../extension/capture-diagnostics.js'),'utf8').replace('export function','function');
  const sandbox={};vm.createContext(sandbox);vm.runInContext(source,sandbox);
  let time=0;
  const video={currentTime:0,readyState:2,getVideoPlaybackQuality(){return {totalVideoFrames:Math.round(time/33),droppedVideoFrames:2};}};
  const observations=sandbox.captureDiagnostics(video,()=>time);
  for(let index=0;index<200;index++){
    time+=250;video.currentTime=time/1000;
    observations.presented({mediaTime:video.currentTime});observations.drew();
  }
  observations.drawFailed();
  const result=observations.finish();
  assert.equal(result.drawCalls,200);
  assert.equal(result.presentedCallbacks,200);
  assert.equal(result.drawErrors,1);
  assert.equal(result.lastMediaTime,50);
  assert.equal(result.inputTime,50);
  assert.equal(result.samples.length,64);
  assert.ok(result.samples[0].elapsedMs>0,'Old samples should be dropped without resetting totals');
  assert.equal(result.samples.at(-1).elapsedMs,50000);
  assert.equal(result.droppedFrames,2);
});
