'use client';
import { ErrorNote, Logo } from '../components/ui';
export default function ErrorPage({reset}:{error:Error;reset:()=>void}){return <main className="session-card"><Logo/><h2>A small interruption.</h2><p>This page could not load. Your recordings are still stored safely on your server.</p><ErrorNote error="Please try again. If this continues, contact your server owner."/><button className="button primary" onClick={reset}>Try again</button></main>;}
