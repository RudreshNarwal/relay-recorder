import {z} from 'zod';
const color=z.string().regex(/^#[0-9a-f]{6}$/i);
function luminance(color:string){return [1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0);}
export function contrast(a:string,b:string){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
const primary=color.refine(v=>contrast(v,'#ffffff')>=4.5,'Primary color must support readable white text (4.5:1 contrast)');
const accent=color.refine(v=>contrast(v,'#26252d')>=4.5,'Accent color must support readable dark text (4.5:1 contrast)');
export const brandSchema=z.object({logoAssetId:z.uuid().nullable(),primaryColor:primary,accentColor:accent,displayName:z.string().trim().min(1).max(80),headerText:z.string().max(200),footerText:z.string().max(300),showRelayCredit:z.boolean(),thumbnailStyle:z.enum(['plain','branded'])}).strict();
export type BrandSettings=z.infer<typeof brandSchema>;
export const defaultBrand:BrandSettings={logoAssetId:null,primaryColor:'#7254dc',accentColor:'#f0ecfc',displayName:'Relay',headerText:'A little more human.',footerText:'Made for sharing ideas.',showRelayCredit:true,thumbnailStyle:'plain'};
export const safeDestination=z.string().max(2048).refine(value=>{
 if(/[\s\u0000-\u001f\u007f]/.test(value))return false;
 try{const url=new URL(value);return url.protocol==='https:'&&!!url.hostname&&!url.username&&!url.password;}catch{return false;}
},'Use a complete HTTPS URL without credentials or whitespace');
export const ctaSchema=z.object({id:z.uuid(),label:z.string().trim().min(1).max(80),url:safeDestination,start:z.number().finite().nonnegative(),end:z.number().finite().positive()}).strict().refine(c=>c.end>c.start,'CTA end must follow its start');
export const brandOverrideSchema=brandSchema.pick({primaryColor:true,accentColor:true,headerText:true,footerText:true,showRelayCredit:true,thumbnailStyle:true}).partial().strict();
export const presentationSchema=z.object({ctas:z.array(ctaSchema).max(3),overrides:brandOverrideSchema.default({})}).strict().refine(v=>new Set(v.ctas.map(c=>c.id)).size===v.ctas.length,'CTA identities must be unique');
export type Presentation=z.infer<typeof presentationSchema>&{version:number;revisionId:string|null};
