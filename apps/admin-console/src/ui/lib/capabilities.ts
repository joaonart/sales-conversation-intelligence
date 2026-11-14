import type { Role } from "./types";

/**
 * What each profile can do, for the list in the account menu. DESCRIPTIVE only: the server enforces every permission, and
 * `tests/account.test.ts` keeps this list identical to the roles the server really checks.
 */
export interface Capability {
  label: string;
  min: Role;
  info: string;
}

export const CAPABILITIES: Capability[] = [
  { label: "Ver painel, sessões, resultados e execuções", min: "VIEWER", info: "Acompanhe os números, as conversas analisadas, as notas e o andamento das execuções." },
  { label: "Ver o conteúdo das conversas (mascarado)", min: "VIEWER", info: "Leia as mensagens na página da sessão. CPF, CNPJ, e-mail e telefone aparecem mascarados e cada acesso fica na auditoria." },
  { label: "Registrar decisão de revisão", min: "EDITOR", info: "Confirme, discorde ou recomende uma nova análise para o que o motor deixou para revisão humana. A análise original não muda." },
  { label: "Criar e editar rascunhos de rubricas", min: "EDITOR", info: "Monte critérios, pesos e regras de aplicabilidade em um rascunho, sem afetar nenhuma análise." },
  { label: "Publicar rubricas", min: "ADMIN", info: "Torna uma versão da rubrica oficial e imutável. Qualquer mudança depois exige uma nova versão." },
  { label: "Pedir e cancelar execuções (roteamento e análises)", min: "ADMIN", info: "Dispara a análise ou o roteamento de um período, com teto de custo, cancela o que ainda não terminou e cuida das agendas recorrentes." },
  { label: "Gerenciar usuários e acessos", min: "ADMIN", info: "Convide pessoas, defina o perfil de cada uma e remova acessos a este workspace." },
  { label: "Consultar a auditoria", min: "ADMIN", info: "Veja quem leu conversas e quem alterou rubricas, usuários, execuções e agendas." },
];
