(() => {
  if(document.querySelector('#mv-spike-host'))return;
  const host=document.createElement('div');host.id='mv-spike-host';host.style.cssText='position:fixed;right:12px;bottom:12px;z-index:2147483647;';
  const root=host.attachShadow({mode:'open'});
  root.innerHTML='<style>:host{font:14px system-ui;color:#14251e}.box{background:#f5fff9;border:2px solid #286747;border-radius:12px;padding:12px;width:310px;box-shadow:0 3px 20px #0004}button,input,select{font:inherit;margin:4px;padding:5px}label{display:block}input[type=number]{width:84px}input[type=range]{width:275px}small{display:block}#state{white-space:pre-wrap;margin:8px 0}button{cursor:pointer}</style><div class="box"><strong>Moment Vault 技术验证</strong><div id="state" role="status">未录制</div><div id="editor"><button id="enter">进入选段／刷新播放器</button><select id="source" aria-label="目标视频"></select><label>起点 A（秒）<input id="a" type="number" step="0.1" min="0" value="0"></label><input id="ar" aria-label="拖动起点" type="range" step="0.1" min="0" max="15" value="0"><label>终点 B（秒）<input id="b" type="number" step="0.1" min="0" value="5"></label><input id="br" aria-label="拖动终点" type="range" step="0.1" min="0" max="15" value="5"><button id="preview">仅预览选区</button><button id="pageStart">页面按钮开始（授权实验）</button><small>Alt+Shift+R：开始／提前结束。到 B 自动结束。先在扩展测试页配置两个目录。</small></div><button id="stop">提前结束录制</button><button id="close">退出选段并恢复观看</button></div>';
  document.documentElement.append(host);
  const keyHelp=root.querySelector('#editor small');
  keyHelp.textContent='正在检查录制快捷键…';
  chrome.runtime.sendMessage({target:'worker',type:'shortcut-status'}).then(result=>{
    keyHelp.textContent=result?.shortcut ? result.shortcut+'：开始／提前结束。到 B 自动结束。先配置测试保存目录。' : '录制快捷键未绑定，请先在 Edge 的扩展快捷键设置中配置。';
  }).catch(()=>{keyHelp.textContent='无法读取录制快捷键，请检查扩展连接。';});
  const $=selector=>root.querySelector(selector);
  let videos=[],video,original,mode='idle',timer,preview=false,raf;
  const state=text=>{$('#state').textContent=text;};
  function range(){const a=Number($('#a').value),b=Number($('#b').value);if(!video||!Number.isFinite(video.duration)||a<0||a>=b||b>video.duration)throw new Error('请先选择视频及有效的 A/B 区间');return {a,b};}
  function clear(){clearInterval(timer);if(video?.cancelVideoFrameCallback && raf)video.cancelVideoFrameCallback(raf);raf=null;}
  function enter(){
    if(mode==='recording'||mode==='preparing')throw new Error('录制期间不能更换源视频');
    videos=[...document.querySelectorAll('video')].filter(v=>v.getBoundingClientRect().width>100 && Number.isFinite(v.duration) && v.duration>0);
    videos.sort((a,b)=>b.getBoundingClientRect().width*b.getBoundingClientRect().height-a.getBoundingClientRect().width*a.getBoundingClientRect().height);
    $('#source').replaceChildren(...videos.map((v,index)=>{const option=document.createElement('option');option.value=index;option.textContent='视频 '+(index+1)+' · '+v.duration.toFixed(1)+' 秒';return option;}));
    if(!videos.length)throw new Error('没有找到可定位的普通视频；先播放一次后刷新');
    selectVideo();
  }
  function selectVideo(){
    const next=videos[Number($('#source').value)];
    if(video===next&&original)return;
    if(video&&original){video.currentTime=original.time;video.playbackRate=original.rate;if(!original.paused)video.play().catch(()=>{});}
    video=next;original={time:video.currentTime,paused:video.paused,rate:video.playbackRate,url:location.href,source:video.currentSrc};
    video.pause();const a=Math.max(0,Math.min(video.currentTime,video.duration-1));
    for(const id of ['ar','br'])$('#'+id).max=video.duration;
    $('#a').value=$('#ar').value=a.toFixed(1);$('#b').value=$('#br').value=Math.min(video.duration,a+5).toFixed(1);
    state('已选择视频；尚未录制');
  }
  const guard=fn=>async()=>{try{await fn();}catch(error){state(error.message);}};
  $('#enter').onclick=guard(enter);$('#source').onchange=guard(selectVideo);
  for(const edge of ['a','b'])for(const id of [edge,edge+'r'])$('#'+id).oninput=guard(()=>{
    if(mode==='recording'||mode==='preparing')return;
    preview=false;clear();const value=$('#'+id).value;$('#'+edge).value=$('#'+edge+'r').value=value;
    video?.pause();if(video)video.currentTime=Number(value);state('预览端点 '+edge.toUpperCase()+'：'+value+' 秒；未录制');
  });
  function checkIdentity(){if(!video?.isConnected||location.href!==original.url||video.currentSrc!==original.source)throw new Error('来源已变化');}
  async function seek(time){if(Math.abs(video.currentTime-time)<0.02 && video.readyState>=2)return;
    await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{video.removeEventListener('seeked',done);reject(new Error('定位超时'));},10000);const done=()=>{clearTimeout(timeout);resolve();};video.addEventListener('seeked',done,{once:true});video.currentTime=time;});}
  function watch(recording){
    clear();const {b}=range();let busy=false;const started=Date.now();
    const tick=()=>{
      if(busy)return;
      try{
        checkIdentity();
        if(recording)state('录制中 · 源位置 '+video.currentTime.toFixed(2)+' / '+b+' 秒');
        if(video.currentTime>=b || video.ended){busy=true;video.pause();clear();if(recording)chrome.runtime.sendMessage({target:'worker',type:'stop',reason:'selected-end'});else{preview=false;state('选区预览结束；未录制');}}
        if(Date.now()-started>Math.max(20,(b-Number($('#a').value))+15)*1000)throw new Error('播放超时或持续缓冲');
      }catch(error){busy=true;clear();video?.pause();state(error.message);if(recording)chrome.runtime.sendMessage({target:'worker',type:'stop',reason:'interrupted:'+error.message});}
    };
    timer=setInterval(tick,30);
    if(video.requestVideoFrameCallback){const frame=()=>{tick();if(!busy)raf=video.requestVideoFrameCallback(frame);};raf=video.requestVideoFrameCallback(frame);}
  }
  $('#preview').onclick=guard(async()=>{if(mode!=='idle')throw new Error('当前不能试播');const {a}=range();checkIdentity();video.pause();await seek(a);preview=true;watch(false);await video.play();state('仅预览；未录制');});
  $('#pageStart').onclick=guard(()=>chrome.runtime.sendMessage({target:'worker',type:'page-start'}));
  $('#stop').onclick=guard(()=>chrome.runtime.sendMessage({target:'worker',type:'stop',reason:'manual-button'}));
  $('#close').onclick=guard(async()=>{
    if(mode==='recording')await chrome.runtime.sendMessage({target:'worker',type:'stop',reason:'manual-close'});
    if(mode==='preparing')throw new Error('正在准备，请稍后再退出');
    clear();preview=false;
    if(video&&original){checkIdentity();video.pause();await seek(original.time);video.playbackRate=original.rate;if(!original.paused)await video.play();}
    state('已恢复进入前的观看位置');$('#editor').style.display='none';
  });
  chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
    if(message.target!=='content')return;
    (async()=>{
      try{
        if(message.type==='show'){host.style.display='';$('#editor').style.display='';return {ok:true};}
        if(message.type==='prepare'){
          if(!video)throw new Error('先点击进入选段并设置 A/B');
          checkIdentity();const selected=range();clear();preview=false;mode='preparing';video.pause();await seek(selected.a);
          const r=video.getBoundingClientRect();if(r.x<0||r.y<0||r.right>innerWidth||r.bottom>innerHeight)throw new Error('请先让目标视频完整显示在窗口内');
          state('准备录制；正在定位与获取捕捉流');
          return {ok:true,...selected,source:location.href,title:document.title,rect:{x:r.x,y:r.y,width:r.width,height:r.height},viewport:{width:innerWidth,height:innerHeight},originalTime:original.time};
        }
        if(message.type==='play'){mode='recording';$('#editor').style.display='none';video.playbackRate=1;watch(true);await video.play();return {ok:true,actualStart:video.currentTime};}
        if(message.type==='stop'){clear();video.pause();mode='saving';state('正在保存实际视频…');return {ok:true,actualEnd:video.currentTime};}
        if(message.type==='status'){clear();mode='idle';$('#editor').style.display='';state(message.message);return {ok:true};}
      }catch(error){mode='idle';return {ok:false,error:error.message};}
    })().then(sendResponse);return true;
  });
})();
