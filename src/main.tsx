import React from "react";

  import { createRoot } from "react-dom/client";
  import App from "./app/TrainingScreen.tsx";
  import { StudyProvider } from "./app/study/StudyProvider";
  import "./styles/index.css";

  createRoot(document.getElementById("root")!).render(<StudyProvider><App /></StudyProvider>);
