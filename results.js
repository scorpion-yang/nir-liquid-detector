export const APPLICATIONS = {
  safety:{name:'Safety',subtitle:'Hazard screening',title:'Safety Screening',sampleLabel:'Identified Liquid',assessmentLabel:'Flammability',fallback:'unknown',icon:'safety'},
  food:{name:'Food',subtitle:'Freshness & quality',title:'Fruit Freshness',sampleLabel:'Detected Fruit',assessmentLabel:'Freshness State',fallback:'unavailable',icon:'food'},
  pharma:{name:'Pharma',subtitle:'Identification & quality',title:'Pharmaceutical Assessment',sampleLabel:'Detected Sample',assessmentLabel:'Composition Assessment',fallback:'unavailable',icon:'pharma'},
  water:{name:'Water Quality',subtitle:'Water analysis',title:'Water Quality Monitoring',sampleLabel:'Detected Contaminant',assessmentLabel:'Monitoring Status',fallback:'inconclusive',icon:'water'},
};
export const STATES = {
  safety:{
    flammable:{label:'Flammable Liquid',tone:'danger',icon:'warning',description:'Flammable liquid identified. Handle with caution.'},
    not_flammable:{label:'Not Classified as Flammable',tone:'neutral',icon:'info',description:'Not classified as flammable. Other hazards may still be present.'},
    unknown:{label:'Unknown Liquid',tone:'neutral',icon:'info',description:'The liquid could not be reliably identified.'},
    undetermined:{label:'Flammability Undetermined',tone:'neutral',icon:'info',description:'Verified flammability information is unavailable for this sample.'},
  },
  food:{
    fresh:{label:'Fresh',tone:'success',icon:'leaf',description:'The sample is consistent with the fresh reference group.'},
    intermediate:{label:'Intermediate',tone:'caution',icon:'leaf',description:'The sample is consistent with the intermediate reference group.'},
    aged:{label:'Aged',tone:'warning',icon:'leaf',description:'The sample is consistent with the aged reference group.'},
    unavailable:{label:'Unable to determine freshness state',tone:'neutral',icon:'info',description:'A reliable freshness assessment is not available.'},
  },
  pharma:{
    consistent:{label:'Consistent with Reference',tone:'success',icon:'check',description:'The sample is consistent with the reference formulation.'},
    slight:{label:'Slight Deviation',tone:'caution',icon:'warning',description:'A slight difference from the reference formulation was detected.'},
    significant:{label:'Significant Deviation',tone:'danger',icon:'warning',description:'The sample differs from the reference formulation.'},
    unavailable:{label:'Assessment Unavailable',tone:'neutral',icon:'info',description:'A reliable reference formulation assessment is not available.'},
  },
  water:{
    no_target:{label:'No Target Contaminant Detected',tone:'neutral',icon:'water',description:'The target contaminant was not detected within the validated scope.'},
    detected:{label:'Organic Contamination Detected',tone:'warning',icon:'warning',description:'Ethylene glycol has been detected in the water sample.'},
    high:{label:'High-Concentration Intrusion',tone:'danger',icon:'warning',description:'A high concentration of the target contaminant was detected.'},
    inconclusive:{label:'Inconclusive',tone:'neutral',icon:'info',description:'The presence of the target contaminant could not be reliably determined.'},
  },
};

const defaultSamples={safety:'—',food:'Apple',pharma:'Oral Suspension',water:'Ethylene Glycol'};
export function normalizeResult(type,input={},source='live_model'){
  if(!Object.hasOwn(APPLICATIONS,type))throw new Error('Unknown application.');
  const config=APPLICATIONS[type];
  const isDemo=source==='demo';
  let status=config.fallback;
  const evidence=input.evidence;
  const verified=Boolean(evidence?.modelId&&evidence?.validationId&&input.reliable===true);
  if((isDemo||verified)&&Object.hasOwn(STATES[type],input.status))status=input.status;
  let sampleName=isDemo||verified?String(input.sampleName||defaultSamples[type]):defaultSamples[type];
  // Identity prediction alone is not evidence of flammability, particularly for mixtures.
  if(type==='safety'&&!isDemo&&verified&&status!=='unknown'){
    const hazard=input.hazard;
    if(!hazard?.referenceId||hazard.verified!==true||hazard.sampleName!==sampleName
      ||!['pure','mixture'].includes(hazard.sampleKind)
      ||(hazard.sampleKind==='mixture'&&!hazard.compositionValidationId))status='undetermined';
    else if(['flammable','not_flammable'].includes(status)&&hazard.classification!==status)status='undetermined';
  }
  if(type==='safety'&&status==='unknown')sampleName='—';
  if(type==='water'&&!isDemo&&status==='high'&&!input.highThresholdValidationId)status='inconclusive';
  const output={type,status,sampleName,source,observedAt:Date.now()};
  const c=input.concentration;
  const supported=(type==='water'&&['detected','high'].includes(status))||(type==='safety'&&status!=='unknown');
  const expectedAnalyte=type==='water'?'Ethylene Glycol':sampleName;
  if(supported&&c&&typeof c.value==='number'&&Number.isFinite(c.value)&&c.value>=0&&c.value<=100
    &&c.unit==='vol%'&&c.analyte===expectedAnalyte
    &&(isDemo||(verified&&c.validated===true&&c.modelId&&c.validationId))){
    output.concentration={value:c.value,unit:c.unit,analyte:c.analyte};
  }
  return output;
}
export function demoResult(type,status){
  const defaults={safety:'flammable',food:'fresh',pharma:'significant',water:'detected'};
  const selected=status&&Object.hasOwn(STATES[type],status)?status:defaults[type];
  return normalizeResult(type,{
    status:selected,sampleName:type==='safety'?'Ethanol':defaultSamples[type],
    concentration:type==='water'?{value:50.2,unit:'vol%',analyte:'Ethylene Glycol'}:undefined,
  },'demo');
}
export class ApplicationModels extends EventTarget {
  providers=new Map(); results=new Map();
  register(type,provider,metadata){
    if(!Object.hasOwn(APPLICATIONS,type)||typeof provider!=='function')throw new Error('Invalid application provider.');
    if(!metadata?.modelId||!metadata.validationId)throw new Error('A model and validation reference are required.');
    if(type==='safety'&&metadata.liquidCount!==31)throw new Error('Safety requires the validated 31-liquid classifier.');
    this.providers.set(type,{provider,metadata});this.dispatchEvent(new Event('change'));
  }
  setResult(type,payload){const result=normalizeResult(type,payload);this.results.set(type,result);this.dispatchEvent(new Event('change'));return result;}
  async scan(type,signal,collect){
    const entry=this.providers.get(type);
    if(!entry)return normalizeResult(type);
    const samples=await collect(signal);
    const payload=await entry.provider(samples,{signal});
    if(signal.aborted)throw new DOMException('Cancelled','AbortError');
    return this.setResult(type,{...payload,evidence:{modelId:entry.metadata.modelId,validationId:entry.metadata.validationId}});
  }
}
