/** 따옴표·쉼표·줄바꿈을 처리하는 CSV 읽기 (첫 줄 = 머리글) */
export function parseCsv(text: string): string[][] {
  text = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let f = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') (f += '"'), i++;
      else if (ch === '"') q = false;
      else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') row.push(f), (f = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(f), rows.push(row), (row = []), (f = '');
    } else f += ch;
  }
  if (f || row.length) row.push(f), rows.push(row);
  return rows.filter((r) => r.some((x) => x.trim()));
}

/** 머리글 이름으로 꺼내 쓰는 행 목록 */
export function csvRecords(text: string): Record<string, string>[] {
  const [head, ...body] = parseCsv(text);
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}
