export type TranscriptPartial = { type:"transcript_partial"; seq:number; text:string; t_start_ms:number; t_end_ms:number };
export type TranscriptFinal = { type:"transcript_final"; seq:number; text:string; t_start_ms:number; t_end_ms:number; speaker_id:string };
export type SpeakerAssigned = { type:"speaker_assigned"; speaker_id:string; color_hint:string };
export type Ack = { type:"ack"; of:string; session_id:string };
export type ErrorMsg = { type:"error"; code:string; message:string };
export type ServerMsg = TranscriptPartial | TranscriptFinal | SpeakerAssigned | Ack | ErrorMsg;

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
  start(meetingName: string, numSpeakers?: number | null) {
    const msg: any = { type: "start", meeting_name: meetingName, source: "aggregate" };
    if (numSpeakers && numSpeakers > 0) msg.num_speakers = numSpeakers;
    this.send(msg);
  }
  stop() { this.send({ type:"stop" }); }
  rename(id: string, name: string, color: string) { this.send({ type:"speaker_rename", speaker_id:id, name, color }); }
  sendAudio(buf: ArrayBuffer) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(buf); }
  private send(o: any) { this.ws?.send(JSON.stringify(o)); }
  close() { this.ws?.close(); }
}
