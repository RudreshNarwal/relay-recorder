import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

// A regression here would send a grant to the wrong origin, omit PKCE, or expose provider errors.
test('OAuth authorization fixes redirects, scopes, issuer and PKCE by purpose',async()=>{
 const {authorizationURL,oauthKinds}=await import('../packages/core/src/oauth-providers');
 const app={clientId:'client',clientSecret:'secret'},redirect='https://relay.example/api/v1/oauth/callback/google_calendar',verifier='v'.repeat(64);
 const url=new URL(authorizationURL('google_calendar',app,'state',verifier,redirect));
 assert.equal(url.origin,'https://accounts.google.com');assert.equal(url.searchParams.get('redirect_uri'),redirect);
 assert.equal(url.searchParams.get('code_challenge'),createHash('sha256').update(verifier).digest('base64url'));
 assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('state'),'state');
 assert.ok(url.searchParams.get('scope')!.includes('calendar.events.readonly'));assert.ok(!url.searchParams.get('scope')!.includes('gmail'));
 assert.equal(Object.keys(oauthKinds).length,12);
});

test('OAuth token exchanges are bounded, preserve rotating grants and redact failures',async()=>{
 const {exchangeGrant}=await import('../packages/core/src/oauth-providers');let calls=0;
 const result=await exchangeGrant('google_calendar',{clientId:'client',clientSecret:'secret'},{code:'code',verifier:'v'.repeat(64),redirectURI:'https://relay.example/api/v1/oauth/callback/google_calendar'},async(url,init)=>{
  calls++;assert.equal(String(url),'https://oauth2.googleapis.com/token');assert.equal(init?.redirect,'error');
  const data=new URLSearchParams(String(init?.body));assert.equal(data.get('code_verifier'),'v'.repeat(64));assert.equal(data.get('client_secret'),'secret');
  return Response.json({access_token:'access',refresh_token:'rotated',expires_in:3600,scope:'openid email https://www.googleapis.com/auth/calendar.events.readonly',token_type:'Bearer'});
 });
 assert.equal(calls,1);assert.equal(result.refreshToken,'rotated');assert.equal(result.accessToken,'access');
 await assert.rejects(exchangeGrant('google_calendar',{clientId:'client',clientSecret:'secret'},{refreshToken:'refresh'},async()=>new Response('secret refresh access',{status:401})),error=>error instanceof Error&&!/secret|refresh access/.test(error.message));
 await assert.rejects(exchangeGrant('gmail',{clientId:'client',clientSecret:'secret'},{code:'x',redirectURI:'https://relay.example/callback'},async()=>Response.json({access_token:'access',token_type:'Bearer',scope:'openid email'})),/scope/i);
});

test('provider-specific OAuth grants use correct Basic, JSON and form boundaries',async()=>{
 const {exchangeGrant}=await import('../packages/core/src/oauth-providers');
 for(const kind of ['github','slack','jira','confluence','linear','notion','teams','outlook','microsoft_calendar','zoom'] as const){
  const value=await exchangeGrant(kind,{clientId:'client',clientSecret:'secret'},{code:'code',redirectURI:'https://relay.example/callback'},async(url,init)=>{
   assert.ok(String(url).startsWith('https://'));assert.equal(init?.redirect,'error');
   if(['notion','zoom'].includes(kind))assert.equal(new Headers(init?.headers).get('authorization'),'Basic '+Buffer.from('client:secret').toString('base64'));
   return Response.json({access_token:'access',token_type:'Bearer',expires_in:3600,refresh_token:'refresh',...(kind==='slack'?{ok:true}:{})});
  });assert.equal(value.accessToken,'access');
 }
});
