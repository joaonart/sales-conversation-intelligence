import type { IconName } from "../components/icons";
import type { Role } from "./types";

export interface NavItem {
  route: string;
  label: string;
  min: Role;
  icon: IconName;
  group: string;
}

/** The side menu, in order. A person only sees (and can only open) what their profile in the workspace allows. */
export const NAV: NavItem[] = [
  { route: "dashboard", label: "Painel", min: "VIEWER", icon: "dashboard", group: "Análise" },
  { route: "sessions", label: "Sessões", min: "VIEWER", icon: "sessions", group: "Análise" },
  { route: "review", label: "Fila de revisão", min: "VIEWER", icon: "inbox", group: "Análise" },
  { route: "runs", label: "Execuções", min: "VIEWER", icon: "runs", group: "Análise" },
  { route: "rubrics", label: "Rubricas", min: "VIEWER", icon: "rubrics", group: "Configuração" },
  { route: "users", label: "Usuários e acesso", min: "ADMIN", icon: "users", group: "Administração" },
  { route: "audit", label: "Auditoria", min: "ADMIN", icon: "audit", group: "Administração" },
  { route: "how", label: "Como funciona", min: "VIEWER", icon: "how", group: "Ajuda" },
];
