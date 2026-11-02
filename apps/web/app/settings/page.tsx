import { Suspense } from 'react';
import { AppShell } from '../../components/shell';
import { SettingsPage } from '../../components/settings';
export default function Page(){return <Suspense><AppShell><SettingsPage/></AppShell></Suspense>;}
