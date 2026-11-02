export type SpeechProvider='parakeet'|'deepgram'|'assemblyai'|'openai';
export type TranscriptionSelection={execution:'device'|'server';provider:SpeechProvider;configurationId?:string;configurationVersion?:number;language?:string;model?:string};
export type SpeechCapabilities={languages:string[];timing:'word'|'segment'|'none';diarization:boolean;externalAudio:boolean;maxInputBytes:number;maxInputSeconds:number};
export type TranscriptionPreference='auto'|'local_only'|'server'|{externalConfigurationId:string};
export type LocalModelState={supported:boolean;verified:boolean;runnable:boolean};

export const PARAKEET_LANGUAGES=['bg','hr','cs','da','nl','en','et','fi','fr','de','el','hu','it','lv','lt','mt','pl','pt','ro','ru','sk','sl','es','sv','uk'];
export const SPEECH_MODELS={
 parakeet:{models:['nemo-parakeet-tdt-0.6b-v3'],regions:['self-hosted'],capabilities:{languages:PARAKEET_LANGUAGES,timing:'word',diarization:false,externalAudio:false,maxInputBytes:64*1024**2,maxInputSeconds:1800}},
 deepgram:{models:['nova-3'],regions:['us'],capabilities:{languages:['en'],timing:'word',diarization:true,externalAudio:true,maxInputBytes:64*1024**2,maxInputSeconds:1800}},
 assemblyai:{models:['universal-3-5-pro'],regions:['us','eu'],capabilities:{languages:['en'],timing:'word',diarization:true,externalAudio:true,maxInputBytes:64*1024**2,maxInputSeconds:1800}},
 openai:{models:['gpt-4o-transcribe','gpt-4o-transcribe-diarize'],regions:['provider-default'],capabilities:{languages:['en'],timing:'none',diarization:false,externalAudio:true,maxInputBytes:24*1024**2,maxInputSeconds:600}},
} satisfies Record<SpeechProvider,{models:string[];regions:string[];capabilities:SpeechCapabilities}>;
export function speechCapabilities(provider:SpeechProvider,model:string):SpeechCapabilities{
 const descriptor=SPEECH_MODELS[provider];if(!descriptor.models.includes(model))throw new Error('Unsupported speech model');
 return {...descriptor.capabilities,...(model==='gpt-4o-transcribe-diarize'?{timing:'segment' as const,diarization:true}:{}),languages:[...descriptor.capabilities.languages]};
}

export function resolveTranscriptionSelection(preference:TranscriptionPreference,allowed:TranscriptionSelection[],local:LocalModelState):TranscriptionSelection{
 let selection:TranscriptionSelection|undefined;
 if(typeof preference==='object')selection=allowed.find(s=>s.provider!=='parakeet'&&s.execution==='server'&&s.configurationId===preference.externalConfigurationId);
 else{
  const useDevice=local.supported&&(preference==='local_only'||(preference==='auto'&&local.verified&&local.runnable));
  if(preference!=='local_only'||useDevice)selection=allowed.find(s=>s.provider==='parakeet'&&s.execution===(useDevice?'device':'server'));
 }
 if(!selection)throw new Error('Selected transcription setting is unavailable. Choose an available provider explicitly.');
 return {...selection};
}
