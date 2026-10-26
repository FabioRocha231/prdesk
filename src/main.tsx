import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("#root missing from index.html");

if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("mock")) {
  const { disableViewTransitions, installMocks, replayKeys } = await import("./dev/mock");
  installMocks();
  disableViewTransitions();
  replayKeys();
}

// No StrictMode: its double-mounted effects would attach each PTY session twice and drop its backlog.
createRoot(root).render(<App />);
