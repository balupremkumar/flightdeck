export function shouldBulkSelect(
  shiftKey: boolean,
  target: { closest(selector: string): unknown } | null,
): boolean {
  return shiftKey && target !== null && target.closest(".phead, .pband") !== null;
}
