// All intervals use one monotonic browser clock, independent of wall-clock changes.
export function createRunClock() {
  return {monotonicMs:performance.now(),epochMs:Date.now()};
}
export function markTime(clock) {
  const elapsedMs=performance.now()-clock.monotonicMs;
  return {elapsedMs,utc:new Date(clock.epochMs+elapsedMs).toISOString()};
}
const number=value=>Number.isFinite(value)?value.toFixed(3):'';
const interval=(start,end)=>start&&end?number(end.elapsedMs-start.elapsedMs):'';
const cell=value=>{
  const text=String(value??'');
  return /[",\r\n]/.test(text)?'"'+text.replace(/"/g,'""')+'"':text;
};
export const TIMING_COLUMNS=[
  'Round_Status','Valid_Samples',
  'Start_Command_Time_UTC','Start_Command_Ack_Time_UTC','Data_Complete_Time_UTC',
  'Inference_Start_Time_UTC','Result_Ready_Time_UTC',
  'Start_Command_Elapsed_ms','Data_Complete_Elapsed_ms','Inference_Start_Elapsed_ms','Result_Ready_Elapsed_ms',
  'Acquisition_Elapsed_ms','Inference_Elapsed_ms','Data_To_Inference_Start_ms','Total_Response_Elapsed_ms',
  'Start_Interval_ms','Round_Error',
];
export function timingCells(round,previousStart){
  const t=round.timing||{};
  return [
    round.status||'',round.samples?.length??0,
    t.startCommand?.utc||'',t.startCommandAck?.utc||'',t.dataComplete?.utc||'',
    t.inferenceStart?.utc||'',t.resultReady?.utc||'',
    number(t.startCommand?.elapsedMs),number(t.dataComplete?.elapsedMs),
    number(t.inferenceStart?.elapsedMs),number(t.resultReady?.elapsedMs),
    interval(t.startCommand,t.dataComplete),interval(t.inferenceStart,t.resultReady),
    interval(t.dataComplete,t.inferenceStart),interval(t.startCommand,t.resultReady),
    interval(previousStart,t.startCommand),round.error||'',
  ];
}
export function buildQuickCsv(record,rounds){
  const predictions=new Map(record.points.map(p=>[p.roundNumber,p]));
  const header=['Round','Time_s','Concentration_percent','Sample_Index','ESP_Time_us',
    'Elapsed_In_Round_ms','CH2_mV','CH3_mV','Device_Round_Index',...TIMING_COLUMNS];
  const rows=[header];let previousStart;
  for(const round of rounds.slice().sort((a,b)=>a.roundNumber-b.roundNumber)){
    const samples=round.samples||[],first=samples[0]?.espTimeUs,prediction=predictions.get(round.roundNumber);
    // Old V5 records have no timing; leave those fields blank instead of inventing it.
    const values=timingCells(round,previousStart);
    if(round.timing?.startCommand)previousStart=round.timing.startCommand;
    const prefix=[round.roundNumber,(round.roundNumber*1.5).toFixed(1),prediction?prediction.concentration.toFixed(6):''];
    for(const sample of samples)rows.push([...prefix,sample.sampleIndex,sample.espTimeUs,
      number((sample.espTimeUs-first)/1000),sample.ch2,sample.ch3,sample.roundIndex,...values]);
    // Preserve dispatched attempts with zero points, without fabricating a raw sample.
    if(!samples.length&&round.timing?.startCommand)rows.push([...prefix,'','','','','','',...values]);
  }
  return '\ufeff'+rows.map(row=>row.map(cell).join(',')).join('\r\n');
}
