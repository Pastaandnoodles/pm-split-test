import { useEffect, useState, type ReactNode } from 'react';
import { GROUP_LABEL } from '../domain/printers';
import type { Group } from '../domain/types';

export function GroupTag({ group }: { group: Group }) {
  return <span className={`gtag g-${group}`}>{GROUP_LABEL[group]}</span>;
}

export function Sheet({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div style={{ flex: 1 }}>{title}</div>
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T | undefined;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg" role="group">
      {options.map((o) => (
        <button key={o.value} type="button" className="btn" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Check({ label, checked, onChange, disabled }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="check" style={disabled ? { opacity: 0.5 } : undefined}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** Number input that keeps the raw text while typing and reports undefined when empty. */
export function NumberField({
  label,
  value,
  onChange,
  step = 'any',
  min,
  max,
  suffix,
  placeholder,
  onBlur,
}: {
  label: ReactNode;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  step?: string;
  min?: number;
  max?: number;
  suffix?: string;
  placeholder?: string;
  onBlur?: () => void;
}) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => {
    if (value === undefined ? text !== '' : Number(text) !== value) setText(value === undefined ? '' : String(value));
  }, [value]);
  return (
    <label className="field">
      <span>
        {label}
        {suffix ? ` (${suffix})` : ''}
      </span>
      <input
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        max={max}
        placeholder={placeholder}
        value={text}
        onBlur={onBlur}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        onChange={(e) => {
          setText(e.target.value);
          const n = e.target.value === '' ? undefined : Number(e.target.value);
          onChange(n === undefined || Number.isNaN(n) ? undefined : n);
        }}
      />
    </label>
  );
}

/** Number field that saves only when editing finishes (blur or Enter), so each change is one audit entry. */
export function CommitNumberField({ value, onCommit, ...rest }: Omit<Parameters<typeof NumberField>[0], 'onChange' | 'onBlur'> & { onCommit: (v: number | undefined) => void }) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  return <NumberField {...rest} value={local} onChange={setLocal} onBlur={() => local !== value && onCommit(local)} />;
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  list,
  caps,
}: {
  label: ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  list?: string;
  caps?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type="text" value={value} placeholder={placeholder} list={list} onChange={(e) => onChange(e.target.value)} autoCapitalize={caps ? 'characters' : 'sentences'} autoCorrect={caps ? 'off' : undefined} />
    </label>
  );
}

/** Two-tap destructive button: the first tap arms it, the second confirms. */
export function ConfirmButton({ children, onConfirm, className = 'btn small danger', disabled }: { children: ReactNode; onConfirm: () => void; className?: string; disabled?: boolean }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      className={className}
      disabled={disabled}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else setArmed(true);
      }}
    >
      {armed ? 'Tap again to confirm' : children}
    </button>
  );
}

export function fmtPct(x: number | null | undefined, digits = 1): string {
  return x === null || x === undefined || !Number.isFinite(x) ? 'â€“' : `${(x * 100).toFixed(digits)}%`;
}

export function fmtNum(x: number | null | undefined, digits = 0): string {
  return x === null || x === undefined || !Number.isFinite(x) ? 'â€“' : x.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function fmtMoney(x: number | null | undefined): string {
  return x === null || x === undefined || !Number.isFinite(x) ? 'â€“' : x.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}

export function fmtTime(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'â€“';
}

/** Downscales a camera photo to at most 1280px on the long side and re-encodes as JPEG. */
export async function compressImage(file: File, maxSide = 1280, quality = 0.8): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode photo'))), 'image/jpeg', quality));
}
