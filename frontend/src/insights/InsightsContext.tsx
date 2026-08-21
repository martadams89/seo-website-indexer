import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useWorkspace } from "../workspace/WorkspaceContext";

export type InsightSiteScope = "all" | "workspace" | string;
export type InsightRange = 7 | 30 | 90;

interface InsightsContextValue {
  siteScope: InsightSiteScope;
  setSiteScope: (value: InsightSiteScope) => void;
  range: InsightRange;
  setRange: (value: InsightRange) => void;
}

const InsightsContext = createContext<InsightsContextValue | null>(null);

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The in-memory selection still works when storage is unavailable.
  }
}

export function InsightsProvider({ children }: { children: ReactNode }) {
  const { active } = useWorkspace();
  const [siteScope, setSiteScope] = useState<InsightSiteScope>(
    () => stored("organic:insights-site") || "all",
  );
  const [range, setRange] = useState<InsightRange>(() => {
    const saved = Number(stored("organic:insights-range"));
    return saved === 7 || saved === 90 ? saved : 30;
  });

  useEffect(() => {
    if (!active?.id) return;
    const previousWorkspace = stored("organic:insights-workspace");
    if (previousWorkspace && previousWorkspace !== active.id) {
      setSiteScope("all");
    }
    persist("organic:insights-workspace", active.id);
  }, [active?.id]);
  useEffect(
    () => persist("organic:insights-site", siteScope),
    [siteScope],
  );
  useEffect(
    () => persist("organic:insights-range", String(range)),
    [range],
  );

  return (
    <InsightsContext.Provider
      value={{ siteScope, setSiteScope, range, setRange }}
    >
      {children}
    </InsightsContext.Provider>
  );
}

export function useInsights(): InsightsContextValue {
  const value = useContext(InsightsContext);
  if (!value)
    throw new Error("useInsights must be used inside InsightsProvider");
  return value;
}
