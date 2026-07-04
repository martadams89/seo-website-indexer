/**
 * Reusable client-side table sorting. `useSort` returns a sorted copy of the
 * rows plus the current sort state; `<SortTh>` is a clickable header that
 * toggles asc → desc → asc and shows the active direction. Numbers sort
 * numerically, everything else sorts naturally (locale-aware, numeric-aware);
 * null/undefined always sink to the bottom.
 */
import { useMemo, useState } from 'react';
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';

export type SortDir = 'asc' | 'desc';
export interface SortState { key: string; dir: SortDir }

export function useSort<T extends Record<string, unknown>>(rows: T[], initial: SortState | null = null) {
  const [sort, setSort] = useState<SortState | null>(initial);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const { key, dir } = sort;
    const factor = dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;   // nulls last, regardless of direction
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * factor;
      return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' }) * factor;
    });
  }, [rows, sort]);

  function requestSort(key: string) {
    setSort(s => (s && s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  }

  return { sorted, sort, requestSort };
}

export function SortTh({ label, sortKey, sort, onSort, align = 'left', width }: {
  label: React.ReactNode;
  sortKey: string;
  sort: SortState | null;
  onSort: (key: string) => void;
  align?: 'left' | 'right' | 'center';
  width?: string | number;
}) {
  const active = sort?.key === sortKey;
  const Icon = !active ? ChevronsUpDown : sort!.dir === 'asc' ? ChevronUp : ChevronDown;
  return (
    <th
      className={`sort-th${active ? ' active' : ''}`}
      style={{ textAlign: align, width, cursor: 'pointer', userSelect: 'none' }}
      onClick={() => onSort(sortKey)}
      aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <span className="sort-th-inner" style={{ justifyContent: align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start' }}>
        {label}<Icon size={11} className="sort-th-icon" />
      </span>
    </th>
  );
}
