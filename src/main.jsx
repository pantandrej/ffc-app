import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";
import TeamRegistration from "./TeamRegistration.jsx";
import AdminResults from "./AdminResults.jsx";

const screen = new URLSearchParams(window.location.search).get("test");
const root = createRoot(document.getElementById("root"));
root.render(
  screen === "team" ? <TeamRegistration /> : screen === "admin" ? <AdminResults /> : <App />
);
