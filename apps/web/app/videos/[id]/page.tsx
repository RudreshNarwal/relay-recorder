import { Suspense } from 'react';
import { AppShell } from '../../../components/shell';
import { SignedVideo } from '../../../components/video-detail';
export default async function Page({params}:{params:Promise<{id:string}>}){const {id}=await params;return <Suspense><AppShell><SignedVideo id={id}/></AppShell></Suspense>;}
