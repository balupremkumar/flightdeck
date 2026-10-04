import { Preview } from "./Preview";
import { IconPanelRight } from "./Icons";
import { useUI } from "./ui";
import type { PreviewMode } from "./previewSplit";

/** QL-708: the Preview plus its pin/unpin button, mounted either as the
 *  overlay drawer (Cockpit root) or inside the split panel (beside the grid). */
export function PreviewHost({ mode }: { mode: PreviewMode }) {
  const toggle = useUI((s) => s.togglePreviewPinned);
  const pinned = mode === "split";
  return (
    <Preview
      mode={mode}
      actions={
        <button
          className={"prv-pin" + (pinned ? " on" : "")}
          onClick={toggle}
          aria-pressed={pinned}
          title={pinned ? "Unpin preview (back to drawer)" : "Pin preview beside the panes"}
          aria-label={pinned ? "Unpin preview" : "Pin preview as split"}
        >
          <IconPanelRight size={14} />
        </button>
      }
    />
  );
}
