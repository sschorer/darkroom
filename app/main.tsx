import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

const root = document.getElementById("root");
// No `!` — a missing root means index.html changed and we want to know why,
// not a null-deref three frames deep.
if (!root) throw new Error("#root not found in index.html");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
