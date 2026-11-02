import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Player} from '../apps/web/components/player';
import type {Video,Transcript} from '../apps/web/components/api';

test('player exposes captions only for ready timed text on the published revision',()=>{
 const video={id:'video',status:'ready',publishedRevisionId:'revision',duration:10} as Video;
 const transcript={id:'text',revisionId:'revision',status:'ready',timing:'word',language:'fr',updatedAt:'2026-10-26T10:00:00Z',segments:[{start:0,end:1,text:'Bonjour'}]} as Transcript;
 const render=(value:Transcript|null)=>renderToStaticMarkup(React.createElement(Player,{video,transcript:value,videoRef:{current:null}}));
 for(const value of [null,{...transcript,status:'processing'},{...transcript,revisionId:'older'},{...transcript,timing:'none' as const}]){
  const html=render(value);assert.doesNotMatch(html,/<track|Toggle captions/);
 }
 const before=render(transcript);assert.match(before,/<track/);assert.match(before,/srcLang="fr"/);assert.match(before,/Toggle captions/);
 const after=render({...transcript,updatedAt:'2026-10-26T10:05:00Z'});
 assert.notEqual(before.match(/<track[^>]+src="([^"]+)/)?.[1],after.match(/<track[^>]+src="([^"]+)/)?.[1],'Corrections must cause a fresh caption request');
});
