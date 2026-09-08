import { saveBlob } from '../utils/download';
export function csvText(rows: unknown[][]): string {
  return rows
    .map((row) =>
      row
        .map((value) => {
          let text = String(value ?? '');
          if (/^[\s]*[=+@-]|^[\t\r\n]/.test(text)) text = "'" + text;
          return '"' + text.replaceAll('"', '""') + '"';
        })
        .join(','),
    )
    .join('\r\n');
}
export function exportCsv(rows: unknown[][], name: string): void {
  saveBlob(new Blob(['\uFEFF', csvText(rows)], { type: 'text/csv;charset=utf-8' }), name);
}
