import {Suspense} from 'react';
import {AppShell} from '../../components/shell';
import {BrandingPage} from '../../components/branding';
export default function Page(){return <Suspense><AppShell><BrandingPage/></AppShell></Suspense>;}
