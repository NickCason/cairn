export type TranscriptPartial = { type:"transcript_partial"; seq:number; text:string; t_start_ms:number; t_end_ms:number };
export type TranscriptFinal = { type:"transcript_final"; seq:number; text:string; t_start_ms:number; t_end_ms:number; speaker_id:string };
export type SpeakerAssigned = { type:"speaker_assigned"; speaker_id:string; color_hint:string };
export type SpeakerMerge = { type:"speaker_merge"; src:string; dst:string };
export type SpeakerRelabel = { type:"speaker_relabel"; seq:number; speaker_id:string };
export type Ack = { type:"ack"; of:string; session_id:string };
export type ErrorMsg = { type:"error"; code:string; message:string };
export type RollingSummaryMsg = { type:"rolling_summary"; idx:number; window_start_s:number; window_end_s:number; bullets:string[]; generated_at:number; merged_from_failed_prior:boolean };
export type RollingReplaceMsg = { type:"rolling_summary_replace"; idx:number; bullets:string[]; generated_at:number; reason:string };
export type FinalSummaryMsg = { type:"final_summary"; ok:boolean; [key:string]:unknown };

export interface SplitRow {
  seq: number;
  text: string;
  speaker_id: string;
  t_start_ms: number;
  t_end_ms: number;
}

export interface TranscriptSplitMsg {
  type: "transcript_split";
  original_seq: number;
  rows: SplitRow[];
}

export type ServerMsg = TranscriptPartial | TranscriptFinal | SpeakerAssigned | SpeakerMerge | SpeakerRelabel | Ack | ErrorMsg | RollingSummaryMsg | RollingReplaceMsg | FinalSummaryMsg | TranscriptSplitMsg;

export class CairnWS {
  private ws: WebSocket | null = null;
  constructor(private url: string, private onMsg: (m: ServerMsg) => void, private onStatus: (s:string)=>void) {}
  connect() {
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.binaryType = "arraybuffer";
      this.ws.onopen = () => { this.onStatus("connected"); resolve(); };
      this.ws.onclose = () => this.onStatus("disconnected");
      this.ws.onerror = (e) => { this.onStatus("error"); reject(e); };
      this.ws.onmessage = (e) => {
        if (typeof e.data === "string") {
          try { this.onMsg(JSON.parse(e.data) as ServerMsg); } catch (err) { console.error("bad msg", err); }
        }
      };
    });
  }
  start(meetingName: string) {
    this.send({ type: "start", meeting_name: meetingName, source: "aggregate" });
  }
  stop() { this.send({ type:"stop" }); }
  rename(id: string, name: string, color: string) { this.send({ type:"speaker_rename", speaker_id:id, name, color }); }
  sendAudio(buf: ArrayBuffer) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(buf); }
  private send(o: any) { this.ws?.send(JSON.stringify(o)); }
  close() { this.ws?.close(); }
}
