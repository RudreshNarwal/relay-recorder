import { VideoDetail } from '../../../components/video-detail';
export default async function Page({params}:{params:Promise<{token:string}>}){const {token}=await params;return <VideoDetail token={token} embedded/>;}
