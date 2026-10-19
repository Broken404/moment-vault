// Tab capture can center the viewport inside a frame of a different aspect ratio.
export function captureGeometry(frame, viewport, rect) {
  const values=[frame.width,frame.height,viewport.width,viewport.height,rect.x,rect.y,rect.width,rect.height];
  if(!values.every(Number.isFinite)||frame.width<=0||frame.height<=0||viewport.width<=0||viewport.height<=0||rect.width<=0||rect.height<=0||rect.x<0||rect.y<0||rect.x+rect.width>viewport.width||rect.y+rect.height>viewport.height)throw new Error('Invalid capture geometry');
  const scale=Math.min(frame.width/viewport.width,frame.height/viewport.height);
  const paddingX=(frame.width-viewport.width*scale)/2;
  const paddingY=(frame.height-viewport.height*scale)/2;
  return {x:paddingX+rect.x*scale,y:paddingY+rect.y*scale,width:rect.width*scale,height:rect.height*scale,
    outputWidth:Math.max(2,Math.round(rect.width*scale/2)*2),outputHeight:Math.max(2,Math.round(rect.height*scale/2)*2),scale,paddingX,paddingY};
}
