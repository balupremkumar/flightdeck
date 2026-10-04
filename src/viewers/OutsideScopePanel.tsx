// OutsideScopePanel.tsx — shown when a read is refused with outside-read-scope.
// Lazy chunk; the drawer passes its own open/reveal/copy handlers.
export default function OutsideScopePanel({ name, onOpen, onReveal, onCopy }: {
  name: string; onOpen: () => void; onReveal: () => void; onCopy: () => void;
}) {
  return (
    <div className="prv-state">
      <code className="prv-icode">{name}</code>
      <strong className="prv-state-title">This file is outside your workspaces</strong>
      <div className="prv-actions">
        <button className="prv-retry" onClick={onOpen}>Open externally</button>
        <button className="prv-retry" onClick={onReveal}>Reveal in Explorer</button>
        <button className="prv-retry" onClick={onCopy}>Copy path</button>
      </div>
      <span className="prv-note">Flightdeck only reads files in open workspaces, D:\Dev\ai and ~/.claude</span>
    </div>
  );
}
