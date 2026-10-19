const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const code=readFileSync(path.join(__dirname,'../extension/capture-geometry.js'),'utf8').replace('export function','function');
const {captureGeometry}=vm.runInNewContext(code+'; ({captureGeometry});');
const near=(value,expected)=>assert.ok(Math.abs(value-expected)<0.01,`${value} != ${expected}`);

test('wide viewport is uniformly scaled with top/bottom capture padding',()=>{
  // Actual Edge 0.0.3 experiment: independent X/Y scaling captured the heading.
  const g=captureGeometry({width:2560,height:1440},{width:1699,height:828},{x:24,y:118.22917175292969,width:640,height:360});
  near(g.x,36.16245);near(g.y,274.34178);near(g.width/g.height,640/360);
  near(g.paddingY,96.19776);assert.equal(g.paddingX,0);assert.equal(g.outputHeight,542);
});
test('tall viewport is uniformly scaled with left/right padding',()=>{
  const g=captureGeometry({width:1920,height:1080},{width:800,height:1000},{x:100,y:200,width:400,height:300});
  near(g.x,636);near(g.y,216);near(g.width,432);near(g.height,324);
});
test('matching aspect ratio has no padding',()=>{
  const g=captureGeometry({width:1280,height:720},{width:640,height:360},{x:0,y:0,width:640,height:360});
  assert.equal(g.paddingX,0);assert.equal(g.paddingY,0);assert.equal(g.outputWidth,1280);assert.equal(g.outputHeight,720);
});
test('offscreen or invalid rectangles are rejected',()=>{
  for(const rect of [{x:-1,y:0,width:100,height:100},{x:0,y:0,width:641,height:100},{x:0,y:0,width:NaN,height:100}])
    assert.throws(()=>captureGeometry({width:1280,height:720},{width:640,height:360},rect),/Invalid capture geometry/);
});
