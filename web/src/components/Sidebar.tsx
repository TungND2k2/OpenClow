import type { Page, Bot } from "../types";

interface NavItem {
  id: Page;
  label: string;
  icon: string;
  group?: string;
}

const navItems: NavItem[] = [
  { id: "dashboard",   label: "Dashboard",   icon: "◈",  group: "main" },
  { id: "collections", label: "Collections", icon: "⊞",  group: "bot" },
  { id: "users",       label: "Users",       icon: "⊙",  group: "bot" },
  { id: "files",       label: "Files",       icon: "◧",  group: "bot" },
  { id: "knowledge",   label: "Knowledge",   icon: "◬",  group: "bot" },
  { id: "sessions",    label: "Sessions",    icon: "◎",  group: "bot" },
  { id: "forms",       label: "Forms",       icon: "◫",  group: "bot" },
  { id: "workflows",   label: "Workflows",   icon: "◈",  group: "bot" },
  { id: "rules",       label: "Rules",       icon: "◭",  group: "bot" },
  { id: "agents",      label: "Agents",      icon: "◯",  group: "bot" },
  { id: "crons",       label: "Crons",       icon: "◷",  group: "bot" },
  { id: "docs",        label: "Knowledge",   icon: "📖", group: "bot" },
  { id: "logs",        label: "Live Logs",   icon: "◉",  group: "system" },
];

interface SidebarProps {
  page: Page;
  setPage: (p: Page) => void;
  botId: string;
  setBotId: (id: string) => void;
  bots: Bot[];
}

export function Sidebar({ page, setPage, botId, setBotId, bots }: SidebarProps) {
  const selectedBot = bots.find(b => b.id === botId);

  const groups = [
    { key: "main",   label: null,         items: navItems.filter(n => n.group === "main") },
    { key: "bot",    label: "Bot Data",   items: navItems.filter(n => n.group === "bot") },
    { key: "system", label: "System",     items: navItems.filter(n => n.group === "system") },
  ];

  return (
    <aside className="w-56 shrink-0 flex flex-col bg-[#0d1117] border-r border-[#21262d] overflow-y-auto">
      {/* Logo */}
      <div className="px-4 py-4 border-b border-[#21262d]">
        <div className="flex items-center gap-2">
          <span className="text-lg">🦀</span>
          <span className="font-bold text-[#e6edf3] tracking-tight">OpenClaw</span>
        </div>
      </div>

      {/* Bot selector */}
      <div className="px-3 py-3 border-b border-[#21262d]">
        <p className="text-[10px] font-semibold text-[#8b949e] uppercase tracking-wider mb-1.5 px-1">Active Bot</p>
        {bots.length === 0 ? (
          <div className="text-xs text-[#8b949e] px-1">No bots available</div>
        ) : (
          <select
            value={botId}
            onChange={e => setBotId(e.target.value)}
            className="w-full bg-[#21262d] border border-[#30363d] text-[#e6edf3] text-xs rounded-lg px-2.5 py-2 focus:outline-none focus:border-[#388bfd] cursor-pointer"
          >
            {bots.map(b => (
              <option key={b.id} value={b.id}>
                {b.botStatus === "active" ? "● " : "○ "}{b.botName || b.name}
              </option>
            ))}
          </select>
        )}
        {selectedBot && (
          <div className="flex items-center gap-1.5 mt-2 px-1">
            <span className={`w-1.5 h-1.5 rounded-full ${selectedBot.botStatus === "active" ? "bg-[#3fb950]" : "bg-[#f85149]"}`} />
            <span className="text-[11px] text-[#8b949e]">{selectedBot.botUsername ? `@${selectedBot.botUsername}` : selectedBot.id.slice(0, 12)}</span>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-3 space-y-4">
        {groups.map(group => (
          <div key={group.key}>
            {group.label && (
              <p className="text-[10px] font-semibold text-[#8b949e] uppercase tracking-wider mb-1 px-2">{group.label}</p>
            )}
            <ul className="space-y-0.5">
              {group.items.map(item => {
                const disabled = group.key === "bot" && !botId;
                const active = page === item.id;
                return (
                  <li key={item.id}>
                    <button
                      onClick={() => !disabled && setPage(item.id)}
                      disabled={disabled}
                      className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-sm transition-colors text-left ${
                        active
                          ? "bg-[#1c2128] text-[#e6edf3] font-medium"
                          : disabled
                            ? "text-[#8b949e]/40 cursor-not-allowed"
                            : "text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d]"
                      }`}
                    >
                      <span className={`text-sm ${active ? "text-[#388bfd]" : ""}`}>{item.icon}</span>
                      {item.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-[#21262d]">
        <p className="text-[11px] text-[#8b949e]/60">OpenClaw Dashboard</p>
      </div>
    </aside>
  );
}
