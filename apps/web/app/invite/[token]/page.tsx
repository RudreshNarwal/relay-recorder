import { Suspense } from 'react';
import { Approval } from '../../../components/approval';
export default async function Page({params}:{params:Promise<{token:string}>}){const {token}=await params;return <Suspense><Approval inviteToken={token}/></Suspense>;}
