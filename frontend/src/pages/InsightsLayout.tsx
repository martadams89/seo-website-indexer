import { useEffect } from "react";
import { BarChart3, Bot, Database, MapPin } from "lucide-react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useApp } from "../AppContext";
import {
  InsightsProvider,
  useInsights,
  type InsightRange,
} from "../insights/InsightsContext";

const TABS = [
  { to: "/insights/search", label: "Search", icon: BarChart3 },
  { to: "/insights/ai", label: "AI visibility", icon: Bot },
  { to: "/insights/evidence", label: "Connected evidence", icon: Database },
  { to: "/insights/entities", label: "Entities", icon: MapPin },
];

function InsightsShell() {
  const { sites } = useApp();
  const { siteScope, setSiteScope, range, setRange } = useInsights();
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (
      siteScope !== "all" &&
      siteScope !== "workspace" &&
      !sites.some((site) => site.id === siteScope)
    ) {
      setSiteScope("all");
    }
  }, [siteScope, setSiteScope, sites]);
  function changeSiteScope(next: string) {
    setSiteScope(next);
    if (!location.pathname.startsWith("/insights/search/")) return;
    navigate(
      next === "all" || next === "workspace"
        ? "/insights/search"
        : `/insights/search/${encodeURIComponent(next)}`,
    );
  }
  return (
    <div className="insights-shell">
      <header className="insights-shell-header">
        <div>
          <span>One measurement workspace</span>
          <h1>Insights</h1>
          <p>
            Search performance, AI visibility and connected evidence with one
            persistent scope.
          </p>
        </div>
        <div className="insights-global-filters">
          <label>
            <span>Website</span>
            <select
              value={siteScope}
              onChange={(event) => changeSiteScope(event.target.value)}
            >
              <option value="all">All sites</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
              <option value="workspace">Workspace-wide only</option>
            </select>
          </label>
          <label>
            <span>Period</span>
            <select
              value={range}
              onChange={(event) =>
                setRange(Number(event.target.value) as InsightRange)
              }
            >
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
          </label>
        </div>
      </header>
      <nav className="insights-tabs" aria-label="Insight types">
        {TABS.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => (isActive ? "active" : "")}
          >
            <Icon size={14} />
            {label}
          </NavLink>
        ))}
      </nav>
      <div className="insights-content">
        <Outlet />
      </div>
    </div>
  );
}

export default function InsightsLayout() {
  return (
    <InsightsProvider>
      <InsightsShell />
    </InsightsProvider>
  );
}
