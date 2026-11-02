import {Suspense} from 'react';
import {AppShell} from '../../components/shell';
import {MeetingsPage} from '../../components/meetings';
export default function Page(){return <Suspense><AppShell><MeetingsPage/></AppShell></Suspense>;}
