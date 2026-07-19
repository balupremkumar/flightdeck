import "./App.css";
import { useApp } from "./store";
import { NewWorkspace } from "./NewWorkspace";
import { Cockpit } from "./Cockpit";

export default function App() {
  const count = useApp((s) => s.workspaces.length);
  const creating = useApp((s) => s.creating);
  if (count === 0) return <NewWorkspace />;
  return (
    <>
      <Cockpit />
      {creating && <NewWorkspace />}
    </>
  );
}
