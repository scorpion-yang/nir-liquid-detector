// V12 protocol: ABF0 service, A5 command frames, 5A/07 ADC batch frames.
const uuid = short => `0000${short}-0000-1000-8000-00805f9b34fb`;
const checksum = bytes => bytes.reduce((sum, value) => (sum + value) & 255, 0);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const abortError = () => new DOMException('Detection stopped', 'AbortError');

export class MoPodDevice extends EventTarget {
  status = 'disconnected'; name = ''; led = false; battery = null; temperature = null;
  device = null; command = null; current = null; previousRound = null; writes = Promise.resolve();
  get connected() { return this.status === 'connected' && this.device?.gatt?.connected; }
  emit() { this.dispatchEvent(new Event('change')); }
  async connect() {
    if (this.connected || this.status === 'connecting') return;
    if (!isSecureContext || !navigator.bluetooth) throw new Error('Use Android Chrome or desktop Chrome/Edge over HTTPS for Bluetooth.');
    this.status = 'connecting'; this.emit();
    try {
      this.device = await navigator.bluetooth.requestDevice({filters:[{services:[uuid('abf0')]}]});
      this.name = this.device.name || 'MoPod';
      this.device.addEventListener('gattserverdisconnected', () => {
        this.status='disconnected'; this.command=null; this.led=false; this.previousRound=null;
        this.current?.finish(new Error('Bluetooth connection interrupted.'));
        this.emit(); this.dispatchEvent(new Event('disconnected'));
      });
      const server=await this.device.gatt.connect(); const service=await server.getPrimaryService(uuid('abf0'));
      this.command=await service.getCharacteristic(uuid('abf1'));
      for (const short of ['abf2','abf3']) {
        try {
          const characteristic=await service.getCharacteristic(uuid(short));
          await characteristic.startNotifications();
          characteristic.addEventListener('characteristicvaluechanged',event=>this.receive(event.target.value));
        } catch(error) { if(short==='abf2')throw error; }
      }
      this.status='connected'; this.previousRound=null; this.emit();
      await this.write(0x40,[]);
    } catch(error) {
      this.device?.gatt?.disconnect(); this.status='disconnected';this.command=null;this.emit();throw error;
    }
  }
  write(id, params=[]) {
    const frame=new Uint8Array(4+params.length);frame.set([0xa5,id,params.length]);frame.set(params,3);frame[frame.length-1]=checksum(frame.subarray(0,-1));
    const operation=this.writes.catch(()=>{}).then(async()=>{
      if(!this.command)throw new Error('Device is not connected.');
      await this.command.writeValueWithResponse(frame);
    });
    this.writes=operation;return operation;
  }
  async configure(signal) {
    if(signal?.aborted)throw abortError();
    await this.write(0x10,[1]); this.led=true; this.emit(); await sleep(100);
    if(signal?.aborted)throw abortError();
    await this.write(0x24,[1]);
    // 1500 ms little-endian, count 1 (host drives rounds), speed 20%.
    await this.write(0x25,[0xdc,0x05,0,0,1,0,20]);this.previousRound=null;
  }
  async collect(signal) {
    if(signal.aborted)throw abortError();
    if(this.current)throw new Error('A collection is already in progress.');
    let finish;
    const done=new Promise((resolve,reject)=>{
      const ctx={samples:new Map(),round:null,settled:false};
      const abort=()=>finish(abortError());
      const timeout=setTimeout(()=>finish(new Error(`Incomplete sample: ${ctx.samples.size}/224 valid points received.`)),4500);
      finish=(error)=>{
        if(ctx.settled)return; ctx.settled=true;clearTimeout(timeout);signal.removeEventListener('abort',abort);
        if(error)reject(error); else resolve(Array.from(ctx.samples.values()).sort((a,b)=>a.sampleIndex-b.sampleIndex));
      };
      ctx.finish=finish;this.current=ctx;signal.addEventListener('abort',abort,{once:true});
    });
    // Install rejection handler before a command can fail or abort arrives.
    done.catch(()=>{});
    try {
      await this.write(0x30,[2]);
      const samples=await done;this.previousRound=this.current.round;return samples;
    } catch(error) { finish(error);throw error; }
    finally {
      this.current=null;
      if(this.connected) { await this.write(0x30,[0]); await sleep(45); }
    }
  }
  receive(view) {
    const bytes=new Uint8Array(view.buffer,view.byteOffset,view.byteLength);
    if(bytes.length<3||bytes[0]!==0x5a||checksum(bytes.subarray(0,-1))!==bytes.at(-1))return;
    if(bytes[1]===0x02&&bytes.length>=5){this.led=Boolean(bytes[2]);this.emit();return;}
    const ctx=this.current;
    if(!ctx||ctx.settled||bytes[1]!==0x07||bytes.length!==5+bytes[3]*16)return;
    const round=bytes[2];
    if(ctx.round!==null&&ctx.round!==round)return;
    if(this.previousRound!==null&&round===this.previousRound)return;
    for(let i=0;i<bytes[3];i++){
      const o=4+i*16, sampleIndex=view.getUint32(o,true);
      if(ctx.round===null){if(sampleIndex!==0)continue;ctx.round=round;}
      if(sampleIndex>=224||ctx.samples.has(sampleIndex))continue;
      const espTimeUs=view.getUint32(o+4,true)+view.getUint32(o+8,true)*0x100000000;
      ctx.samples.set(sampleIndex,{sampleIndex,espTimeUs,ch2:view.getUint16(o+12,true),ch3:view.getUint16(o+14,true),roundIndex:round});
    }
    if(ctx.samples.size===224){
      const samples=Array.from(ctx.samples.values()).sort((a,b)=>a.sampleIndex-b.sampleIndex);
      if(samples.some((p,i)=>i&&p.espTimeUs<=samples[i-1].espTimeUs)){ctx.finish(new Error('Invalid sample timestamps.'));return;}
      ctx.finish();
    }
  }
  async shutdown() {
    let error;
    if(this.connected){
      try{await this.write(0x30,[0]);}catch(e){error=e;}
      try{await this.write(0x10,[0]);this.led=false;this.emit();}catch(e){error ||= e;}
    }
    if(error)throw error;
  }
  async disconnect() {this.current?.finish(abortError());await this.shutdown();this.device?.gatt?.disconnect();}
}
