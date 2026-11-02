import { Suspense } from 'react';
import { AppShell } from '../components/shell';
import { Library } from '../components/library';
export default function Page() {return <Suspense><AppShell><Library/></AppShell></Suspense>;}
