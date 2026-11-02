import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {TranscriptPanel} from '../apps/web/components/transcript-panel';
import type {Detail} from '../apps/web/components/api';
import {transcriptDTO} from '../packages/core/src/access';

test('an incomplete inherited transcript exposes retained corrections without offering to overwrite them',()=>{
 const transcript=transcriptDTO({id:'t',revision_id:'r',segments:[{start:0,end:1,text:'Corrected name'}],text:'Corrected name',status:'failed',timing:'word',user_edited:true,error:'A source transcript is unavailable.'});
 const detail={video:{id:'v',workspaceId:'w',status:'ready',publishedRevisionId:'r'},permissions:{edit:true},transcript} as Detail;
 const html=renderToStaticMarkup(React.createElement(TranscriptPanel,{detail,onSaved:async()=>{},onSeek:()=>{}}));
 assert.match(html,/Corrected name/);assert.match(html,/Correct text/);
 assert.match(html,/<button[^>]*disabled=""[^>]*>Retry selected transcription/);
 assert.equal(transcript?.userEdited,true);
});
