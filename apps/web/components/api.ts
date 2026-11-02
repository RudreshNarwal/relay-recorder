import type {BrandSettings,Presentation} from '@core/branding';
import type {TranscriptionSelection} from '../../../packages/core/src/transcription';
export type User = { id: string; name: string; email: string; isAdmin: boolean };
export type Workspace = { id: string; name: string; role: string };
export type Folder = { id: string; name: string; workspaceId: string; parentId?: string };
export type Video = { id: string; clientId?: string; workspaceId: string; ownerId: string; title: string; description: string; status: string; duration: number; createdAt: string; updatedAt: string; folderId: string | null; archived: boolean; favorite: boolean; watchLater: boolean; publishedRevisionId: string | null; thumbnailUrl: string | null; playbackUrl: string | null; transcriptionMode: string; transcription?:TranscriptionSelection; mediaKind?: 'video'|'audio'; visibility: string; error?: string };
export type Clip = { videoId: string; revisionId?: string; start: number; end: number };
export type Blur = { start: number; end: number; x: number; y: number; width: number; height: number };
export type Revision = { id: string; status: string; duration: number; createdAt: string; edit: { clips: Clip[]; blurs: Blur[]; thumbnailTime?: number;presentation?:import('@core/presentation').Presentation } };
export type Segment = { start: number; end: number; text: string; words?: { start: number; end: number; text: string }[] };
export type Transcript = { id: string; updatedAt?:string; version?:string; revisionId: string; language: string; segments: Segment[]; text?:string; timing?:'word'|'segment'|'none';provider?:string;model?:string;userEdited?:boolean; status: string; error?: string };
export type Comment = { id: string; userId: string; userName: string; body: string; timestamp: number | null; timestamps?:number[]; revisionId: string; parentId: string | null; createdAt: string };
export type AIResult = { revisionId: string; title: string; summary: string; chapters: { start: number; title: string }[]; actionItems: string[]; status: string; provider: string; model: string; userEdited: string[]; error?: string };
export type Share = { token: string; url: string; visibility: string; allowDownload: boolean; emails?: string[] };
export type Detail = { branding?:BrandSettings;presentation?:Presentation;video: Video; transcript: Transcript | null; comments: Comment[]; revisions: Revision[]; ai: AIResult | null; permissions: { edit: boolean; download?: boolean }; share: Share | null };
export class APIError extends Error { constructor(message: string, public status: number, public code?:string) { super(message); } }
export async function api<T = Record<string, unknown>>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && typeof options.body === 'string') headers.set('Content-Type', 'application/json');
  const response = await fetch(path.startsWith('/api/') ? path : `/api/v1${path}`, { ...options, headers, credentials: 'same-origin' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new APIError(typeof data.error === 'string' ? data.error : data.error?.message || data.message || `Request failed (${response.status})`, response.status, typeof data.code==='string'?data.code:undefined);
  return data as T;
}
export function json(method: string, body?: unknown): RequestInit { return { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }; }
export function time(seconds = 0): string { const value = Math.max(0, Math.floor(seconds || 0)); return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`; }
export function date(value: string): string { return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
export function message(error: unknown): string { return error instanceof Error ? error.message : 'Something went wrong. Please try again.'; }
export function media(id: string, asset: string, token?: string, version?: string): string { const params = new URLSearchParams(); if (token) params.set('share', token); if (version) params.set('version', version); return `/api/v1/videos/${id}/media/${asset}${params.size ? `?${params}` : ''}`; }
export function shareQuery(path: string, token?: string): string { return token ? `${path}${path.includes('?') ? '&' : '?'}share=${encodeURIComponent(token)}` : path; }
