export class ConcentrationModels extends EventTarget {
  state='idle'; folds=Array(5).fill('Not loaded'); sessions=[]; metadata=null; error='';
  get ready(){return this.state==='ready';}
  notify(){this.dispatchEvent(new Event('change'));}
  async load(){
    if(this.state==='loading')return;
    this.state='loading';this.error='';this.folds=Array(5).fill('Not loaded');this.notify();
    for(const session of this.sessions)await session.release?.(); this.sessions=[];
    try{
      if(!globalThis.ort)throw new Error('Model runtime unavailable. Check the network and reload.');
      ort.env.wasm.numThreads=1;ort.env.wasm.wasmPaths='https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/';
      const response=await fetch('./model/metadata.json',{cache:'no-store'});
      if(!response.ok)throw new Error('Model metadata could not be loaded.');
      this.metadata=await response.json();
      if(this.metadata.task!=='regression'||this.metadata.seqLen!==224||this.metadata.folds?.length!==5)throw new Error('Unexpected concentration model configuration.');
      for(let i=0;i<5;i++){
        this.folds[i]='Loading';this.notify();
        this.sessions.push(await ort.InferenceSession.create(this.metadata.folds[i].modelPath,{executionProviders:['wasm'],graphOptimizationLevel:'all'}));
        this.folds[i]='Ready';this.notify();
      }
      this.state='ready';this.notify();
    }catch(error){
      this.error=error.message;this.state='error';this.folds=this.folds.map(s=>s==='Loading'?'Failed':s);this.notify();
    }
  }
  async predict(samples){
    if(!this.ready)throw new Error('The concentration models are not loaded.');
    const {features}=globalThis.NIRPreprocessing.prepareFeatures(samples,224);
    const outputs=[];
    for(let i=0;i<5;i++){
      const {mean,std}=this.metadata.folds[i].normalization;
      const normalized=Float32Array.from(features,(value,j)=>(value-Math.fround(mean[j%6]))/Math.fround(std[j%6]));
      const session=this.sessions[i];
      const result=await session.run({[session.inputNames[0]]:new ort.Tensor('float32',normalized,[1,224,6])});
      const value=Number(result[session.outputNames[0]].data[0]);
      if(!Number.isFinite(value))throw new Error('The model returned an invalid prediction.');
      outputs.push(this.metadata.targetMin+Math.min(1,Math.max(0,value))*(this.metadata.targetMax-this.metadata.targetMin));
    }
    return outputs.reduce((sum,n)=>sum+n,0)/5;
  }
}
