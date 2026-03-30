import { useEffect, useState } from "react";
import { apiFetch } from "./api";
import type { Page, Bot, Overview } from "./types";
import { Sidebar } from "./components/Sidebar";
import { DashboardPage } from "./pages/DashboardPage";
import { CollectionsPage } from "./pages/CollectionsPage";
import { CrudPage } from "./pages/CrudPage";
import { formsConfig, workflowsConfig, rulesConfig, agentsConfig } from "./pages/crudConfigs";
import { UsersPage, FilesPage, KnowledgePage, SessionsPage, CronsPage } from "./pages/ReadPage";
import { LogsPage } from "./pages/LogsPage";
import { DocsPage } from "./pages/DocsPage";

const PAGE_TITLES: Record<Page, string> = {
  dashboard:   "Dashboard",
  collections: "Collections",
  users:       "Users",
  files:       "Files",
  knowledge:   "Knowledge",
  sessions:    "Sessions",
  forms:       "Forms",
  workflows:   "Workflows",
  rules:       "Rules",
  agents:      "Agents",
  crons:       "Crons",
  docs:        "Knowledge Docs",
  logs:        "Live Logs",
};

function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const [botId, setBotId] = useState("");
  const [bots, setBots] = useState<Bot[]>([]);

  useEffect(() => {
    apiFetch<Overview>("/overview")
      .then(data => {
        if (data.bots.length > 0) setBotId(data.bots[0].id);
      })
      .catch(() => {});
    apiFetch<Bot[]>("/bots").then(setBots).catch(() => {});
  }, []);

  const renderPage = () => {
    if (page === "dashboard") return <DashboardPage />;
    if (page === "logs") return <LogsPage />;
    if (!botId) return (
      <div className="flex items-center justify-center py-32 text-[#8b949e] text-sm">
        Select a bot from the sidebar to get started
      </div>
    );
    switch (page) {
      case "collections": return <CollectionsPage botId={botId} />;
      case "users":       return <UsersPage botId={botId} />;
      case "files":       return <FilesPage botId={botId} />;
      case "knowledge":   return <KnowledgePage botId={botId} />;
      case "sessions":    return <SessionsPage botId={botId} />;
      case "crons":       return <CronsPage botId={botId} />;
      case "forms":       return <CrudPage config={formsConfig} botId={botId} />;
      case "workflows":   return <CrudPage config={workflowsConfig} botId={botId} />;
      case "rules":       return <CrudPage config={rulesConfig} botId={botId} />;
      case "agents":      return <CrudPage config={agentsConfig} botId={botId} />;
      case "docs":        return <DocsPage botId={botId} />;
      default:            return null;
    }
  };

  return (
    <div className="flex h-screen bg-[#0d1117] text-[#e6edf3] overflow-hidden" style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      <Sidebar page={page} setPage={setPage} botId={botId} setBotId={setBotId} bots={bots} />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Topbar */}
        <header className="h-12 flex items-center px-6 border-b border-[#21262d] bg-[#0d1117] shrink-0">
          <span className="text-sm font-medium text-[#e6edf3]">{PAGE_TITLES[page]}</span>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-y-auto px-6 py-6">
          {renderPage()}
        </main>
      </div>
    </div>
  );
}

export default App;
