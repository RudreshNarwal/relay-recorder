import {Suspense} from 'react';
import {AppShell} from '../../components/shell';
import {ConnectionsPage} from '../../components/connections';
export default function Page(){return <Suspense><AppShell><ConnectionsPage/></AppShell></Suspense>;}
