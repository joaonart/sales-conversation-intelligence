import type { ComponentType } from "preact";
import { Alert } from "../components/Alert";
import { useConfirm } from "../components/Modal";
import { NAV } from "../lib/nav";
import { useSession } from "../state/session";
import { AuditView } from "../views/AuditView";
import { RubricsView } from "../views/RubricsView";
import { ReviewView } from "../views/ReviewView";
import { RunsView } from "../views/RunsView";
import { DashboardView } from "../views/DashboardView";
import { HowView } from "../views/HowView";
import { SessionsView } from "../views/SessionsView";
import { UsersView } from "../views/UsersView";
import { Shell } from "./Shell";
import { go, useRoute, type Route } from "./router";
import { Component, type ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";

/** A screen that throws must say so instead of leaving a blank page. */
class Boundary extends Component<{ children?: ComponentChildren; resetKey: string }, { error: Error | null; key: string }> {
  override state = { error: null as Error | null, key: this.props.resetKey };
  static override getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error) {
    console.error("view_error", error.name, error.message);
  }
  override componentDidUpdate() {
    if (this.state.key !== this.props.resetKey) this.setState({ error: null, key: this.props.resetKey });
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <Alert tone="bad">
        <strong>Não foi possível exibir esta tela.</strong>
        <div>
          Detalhe técnico: {this.state.error.name}: {this.state.error.message}
        </div>
      </Alert>
    );
  }
}

function Soon({ name }: { name: string }) {
  return <Alert tone="info">A tela “{name}” ainda está sendo migrada.</Alert>;
}

type View = ComponentType<{ parts: string[] }>;
const VIEWS: Record<string, View> = { dashboard: DashboardView, audit: AuditView, rubrics: RubricsView, review: ReviewView, users: UsersView, runs: RunsView, sessions: SessionsView, how: HowView };

export function App() {
  const route = useRoute();
  const { can, showHow } = useSession();
  useConfirm();
  const item = NAV.find((n) => n.route === route.name);
  const allowed = Boolean(item && can(item.min) && (item.route !== "how" || showHow));
  // A page this profile cannot open (or an unknown one) goes to the dashboard. Done in an effect, never while rendering.
  useEffect(() => {
    if (!allowed) go("#/dashboard");
  }, [allowed, route.name]);
  if (!item || !allowed) return null;
  const View = VIEWS[route.name];
  return (
    <Shell route={route}>
      <Boundary resetKey={routeKey(route)}>{View ? <View parts={route.parts} /> : <Soon name={item.label} />}</Boundary>
    </Shell>
  );
}

function routeKey(r: Route): string {
  return [r.name, ...r.parts].join("/");
}
