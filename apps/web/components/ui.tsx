'use client';
import { Children, cloneElement, isValidElement, useEffect, useId, useRef } from 'react';
import { X, LoaderCircle, ArrowUpRight, Video } from 'lucide-react';
export function Logo({ compact = false }: { compact?: boolean }) { return <a className="logo" href="/" aria-label="Relay home"><span className="logo-mark"><span /><span /></span>{!compact && 'relay'}<span className="logo-dot" /></a>; }
export function Spinner({ label = 'Loading…' }: { label?: string }) { return <div className="loading"><LoaderCircle className="spin" size={20} /><span>{label}</span></div>; }
export function ErrorNote({ error }: { error: string }) { return error ? <div className="error-note" role="alert">{error}</div> : null; }
export function Modal({ title, children, onClose, wide = false }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  // Start on the title so the dialog is announced by name and no button wears a focus ring before the user tabs.
  useEffect(() => { const el = dialog.current; el?.showModal(); el?.querySelector<HTMLElement>('.modal-heading h2')?.focus(); return () => el?.close(); }, []);
  return <dialog ref={dialog} aria-labelledby={titleId} className={`modal ${wide ? 'modal-wide' : ''}`} onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) onClose(); }}><div className="modal-heading"><h2 id={titleId} tabIndex={-1}>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={20} /></button></div>{children}</dialog>;
}
export function Empty({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) { return <div className="empty-state"><div className="empty-art"><Video size={35} strokeWidth={1.4} /><span className="empty-spark">✦</span></div><h2>{title}</h2><p>{children}</p>{action}</div>; }
export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  const generatedId = useId(); let controlId = generatedId; let assigned = false;
  function connect(nodes: React.ReactNode): React.ReactNode {
    return Children.map(nodes, node => {
      if (!isValidElement<{ id?: string; children?: React.ReactNode; 'aria-describedby'?: string }>(node)) return node;
      if (!assigned && typeof node.type === 'string' && ['input', 'textarea', 'select'].includes(node.type)) {
        assigned = true; controlId = node.props.id || generatedId;
        return cloneElement(node, { id: controlId, ...(hint ? { 'aria-describedby': `${generatedId}-hint` } : {}) });
      }
      return node.props.children ? cloneElement(node, { children: connect(node.props.children) }) : node;
    });
  }
  const controls = connect(children);
  return <div className="field"><label htmlFor={controlId}>{label}</label>{controls}{hint && <small id={`${generatedId}-hint`}>{hint}</small>}</div>;
}
export function External({ href, children }: { href: string; children: React.ReactNode }) { return <a href={href} target="_blank" rel="noreferrer">{children}<ArrowUpRight size={14} /></a>; }

export function TranscriptionLanguageNote() {
  return <details className="language-note"><summary>Transcription languages · 25 supported</summary><p>Parakeet automatically detects Bulgarian, Croatian, Czech, Danish, Dutch, English, Estonian, Finnish, French, German, Greek, Hungarian, Italian, Latvian, Lithuanian, Maltese, Polish, Portuguese, Romanian, Russian, Slovak, Slovenian, Spanish, Swedish, and Ukrainian. Other languages are unsupported. No language selection is needed.</p></details>;
}
