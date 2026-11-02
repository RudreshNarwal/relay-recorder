import {z} from 'zod';
const text=z.string().trim().min(1).max(150),id=z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const common={name:text,audience:z.string().trim().min(1).max(300),token:z.string().min(1).max(8000).regex(/^[\x21-\x7e]+$/,'Use a token without spaces or line breaks').optional(),oauthAccountId:z.uuid().optional()};
const site=z.string().regex(/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/,'Use your Atlassian site name only');
export const connectionSchema=z.discriminatedUnion('provider',[
 z.object({...common,provider:z.literal('github'),destination:z.object({repository:z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200),issueNumber:z.number().int().positive().optional()}).strict()}).strict(),
 z.object({...common,provider:z.literal('slack'),destination:z.object({channel:z.string().regex(/^[CG][A-Z0-9]{4,40}$/)}).strict()}).strict(),
 z.object({...common,provider:z.literal('jira'),destination:z.object({site,email:z.email(),projectKey:z.string().regex(/^[A-Z][A-Z0-9_]{1,30}$/),issueTypeId:id}).strict()}).strict(),
 z.object({...common,provider:z.literal('confluence'),destination:z.object({site,email:z.email(),spaceId:id,parentId:id.optional()}).strict()}).strict(),
 z.object({...common,provider:z.literal('linear'),destination:z.object({teamId:z.uuid()}).strict()}).strict(),
 z.object({...common,provider:z.literal('notion'),destination:z.object({pageId:z.uuid()}).strict()}).strict(),
 z.object({...common,provider:z.literal('teams'),destination:z.object({teamId:z.uuid(),channelId:z.string().min(1).max(200).regex(/^[A-Za-z0-9:_.@-]+$/)}).strict()}).strict(),
 z.object({...common,provider:z.literal('gmail'),destination:z.object({recipient:z.email().max(254)}).strict()}).strict(),
 z.object({...common,provider:z.literal('outlook'),destination:z.object({recipient:z.email().max(254)}).strict()}).strict(),
]).refine(value=>!!value.token!==!!value.oauthAccountId,'Choose either an OAuth account or a scoped token');
export type ConnectionInput=z.infer<typeof connectionSchema>;
export type IntegrationProvider=ConnectionInput['provider'];
export const connectorFields:Record<IntegrationProvider,{label:string;key:string;optional?:boolean}[]>={
 github:[{label:'Repository (owner/name)',key:'repository'},{label:'Issue or PR number (blank creates an issue)',key:'issueNumber',optional:true}],
 slack:[{label:'Channel ID',key:'channel'}],
 jira:[{label:'Atlassian site (before .atlassian.net)',key:'site'},{label:'Account email',key:'email'},{label:'Project key',key:'projectKey'},{label:'Issue type ID',key:'issueTypeId'}],
 confluence:[{label:'Atlassian site (before .atlassian.net)',key:'site'},{label:'Account email',key:'email'},{label:'Space ID',key:'spaceId'},{label:'Parent page ID',key:'parentId',optional:true}],
 linear:[{label:'Team UUID',key:'teamId'}],notion:[{label:'Parent page UUID',key:'pageId'}],
 teams:[{label:'Team UUID',key:'teamId'},{label:'Channel ID',key:'channelId'}],
 gmail:[{label:'Draft recipient',key:'recipient'}],outlook:[{label:'Draft recipient',key:'recipient'}],
};
export function connectionDTO(r:Record<string,any>){return {id:r.id,provider:r.provider,name:r.name,audience:r.audience,destination:r.destination,version:r.version,status:r.status,createdAt:r.created_at,oauthAccountId:r.oauth_account_id??null};}
export function deliveryDTO(r:Record<string,any>){return {id:r.id,connectionId:r.connection_id,artifactId:r.artifact_id,videoId:r.video_id,revisionId:r.revision_id,status:r.status,externalId:r.external_id,error:r.error,createdAt:r.created_at};}
