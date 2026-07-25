import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import FantasystaApp from "./FantasystaApp.jsx";
import TeamRegistration from "./TeamRegistration.jsx";
import AdminResults from "./AdminResults.jsx";
import LegacyPredictorApp from "./App.jsx";

// FANTASYСТА живёт на главном адресе. ?test=team / ?test=admin — прямые
// ссылки на отдельные экраны в изоляции (без общего каркаса), для отладки.
// ?legacy=1 — старый интерфейс ЧМ-прогнозиста, на всякий случай не удалён.
const params = new URLSearchParams(window.location.search);
const screen = params.get("test");
const legacy = params.get("legacy") === "1";

const root = createRoot(document.getElementById("root"));
root.render(
  legacy ? <LegacyPredictorApp /> :
  screen === "team" ? <TeamRegistration /> :
  screen === "admin" ? <AdminResults /> :
  <FantasystaApp />
);
