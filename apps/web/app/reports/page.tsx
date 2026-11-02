import {Suspense} from 'react';
import {AppShell} from '../../components/shell';
import {ReportsPage} from '../../components/reports';
export default function Page(){return <Suspense><AppShell><ReportsPage/></AppShell></Suspense>;}
