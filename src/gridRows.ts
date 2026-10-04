/** Arrange N panes into rows of pane indices; each divider is draggable so any
 *  pane can be resized.
 *
 *  R1: rows are index-contiguous with a column cap by tier (2 up to 4 panes, 3
 *  up to 9, 4 up to 16, then ceil(sqrt(n))), so adding a pane only appends to
 *  the last row or opens a new one: nothing already placed changes row except
 *  at the tier boundaries (4 -> 5 and 9 -> 10). A pane that changes row gets a
 *  new React parent and remounts; the terminal survives that (paneSessions), but
 *  the fewer reparents the less the grid visibly jumps. No pure function of n
 *  keeps both "3 in a row" and a 2x2 four. Balu's long-standing layout is 3 in
 *  a row, so 3 -> 4 is treated as a tier boundary too (pane 2 drops to row 2);
 *  harmless now that paneSessions keeps the terminal alive across reparents. */
export function rows(n: number): number[][] {
  if (n <= 0) return [];
  const cols = n === 3 ? 3 : n <= 4 ? 2 : n <= 9 ? 3 : n <= 16 ? 4 : Math.ceil(Math.sqrt(n));
  const r: number[][] = [];
  for (let i = 0; i < n; i += cols) r.push(Array.from({ length: Math.min(cols, n - i) }, (_, k) => i + k));
  return r;
}
