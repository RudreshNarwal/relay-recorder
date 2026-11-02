import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {brandSchema,defaultBrand,presentationSchema} from '../packages/core/src/branding';
import {sanitizeLogo} from '../packages/core/src/brand-assets';

test('branding rejects active markup settings, inaccessible colors and unsafe CTA destinations',()=>{
 assert.equal(brandSchema.parse(defaultBrand).displayName,'Relay');
 assert.throws(()=>brandSchema.parse({...defaultBrand,primaryColor:'#ffffff'}));
 assert.throws(()=>brandSchema.parse({...defaultBrand,accentColor:'#000000'}));
 assert.throws(()=>brandSchema.parse({...defaultBrand,css:'body{display:none}'}));
 for(const url of ['javascript:alert(1)','data:text/html,a','http://example.test','https://user:secret@example.test','https://example.test/\nsecret'])assert.throws(()=>presentationSchema.parse({ctas:[{id:crypto.randomUUID(),label:'Go',url,start:0,end:3}]}));
 assert.throws(()=>presentationSchema.parse({ctas:[{id:crypto.randomUUID(),label:'Go',url:'https://example.test',start:4,end:3}]}));
});
test('logos are bounded decoded rasters, re-encoded without metadata',async()=>{
 await assert.rejects(sanitizeLogo(Buffer.from('<svg onload="alert(1)"></svg>')));
 await assert.rejects(sanitizeLogo(Buffer.alloc(2_000_001)));
 const input=await sharp({create:{width:700,height:500,channels:3,background:'#7254dc'}}).withMetadata({exif:{IFD0:{Artist:'private metadata'}}}).png().toBuffer();
 const result=await sanitizeLogo(input),metadata=await sharp(result).metadata();
 assert.equal(metadata.format,'webp');assert.equal(metadata.width,512);assert.equal(metadata.exif,undefined);
 const huge=await sharp({create:{width:2100,height:2100,channels:3,background:'white'}}).png().toBuffer();await assert.rejects(sanitizeLogo(huge));
});
