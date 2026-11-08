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
import { UsersView } from "../views/UsersView";
import { Shell } from "./Shell";
import { go, useRoute, type Route } from "./router";
import { Component, type ComponentChildren } from "preact";

/** A screen that throws must say so instead of leaving a blank page. */
class Boundary extends Component<{ children?: ComponentChildren; resetKey: string }, { error: Error | null; key: string }> {
  state = { error: null as Error | null, key: this.props.resetKey };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error("view_error", error.name, error.message);
  }
  componentDidUpdate() {
    if (this.state.key !== this.props.resetKey) this.setState({ error: null, key: this.props.resetKey });
  }
  render() {
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
const VIEWS: Record<string, View> = { dashboard: DashboardView, audit: AuditView, rubrics: RubricsView, review: ReviewView, users: UsersView, runs: RunsView, how: HowView };

export function App() {
  const route = useRoute();
  const { can, showHow } = useSession();
  useConfirm();
  const item = NAV.find((n) => n.route === route.name);
  const allowed = item && can(item.min) && (item.route !== "how" || showHow);
  if (!allowed) {
    go("#/dashboard");
    return null;
  }
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
