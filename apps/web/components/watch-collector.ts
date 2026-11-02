import type {WatchInterval} from '@core/analytics';
export type WatchSample={position:number;wall:number;rate:number;playing:boolean;visible:boolean;seeking:boolean};
/** Credit only adjacent, visible playback samples. Seek gaps and stalled clocks reset the anchor. */
export class WatchCollector {
 private previous:WatchSample|null=null;
 private pending:WatchInterval|null=null;
 private sessionId=crypto.randomUUID();
 private sequence=0;
 constructor(private revisionId:string,private kind:'playback'|'preview',private emit:(interval:WatchInterval)=>void){}
 sample(current:WatchSample){
  const previous=this.previous;
  if(previous){
   const wall=current.wall-previous.wall,media=current.position-previous.position;
   const eligible=previous.playing&&previous.visible&&current.visible&&!previous.seeking&&!current.seeking&&current.rate===previous.rate&&wall>0&&wall<=2000&&media>0&&media<=wall/1000*previous.rate+.35;
   if(eligible){
    if(this.pending&&(Math.abs(this.pending.end-previous.position)>.01||this.pending.playbackRate!==current.rate))this.flush();
    this.pending??={eventId:crypto.randomUUID(),sessionId:this.sessionId,revisionId:this.revisionId,sequence:this.sequence,start:previous.position,end:current.position,wallStart:previous.wall,wallEnd:current.wall,playbackRate:current.rate,visible:true,kind:this.kind};
    this.pending={...this.pending,end:current.position,wallEnd:current.wall};
    if(current.wall-this.pending.wallStart>=10000)this.flush();
   }else this.flush();
  }
  this.previous=current;
  if(!current.playing||!current.visible||current.seeking)this.flush();
 }
 private flush(){if(this.pending){const interval=this.pending;this.pending=null;this.sequence++;this.emit(interval);}}
 stop(){this.flush();this.previous=null;}
 reset(){this.pending=null;this.previous=null;this.sessionId=crypto.randomUUID();this.sequence=0;}
}
