/**
 * Contexto por requisicao (AsyncLocalStorage). Carrega o tenant/actor
 * autenticado atraves da cadeia async, para a camada de dados aplicar o
 * tenant no Oracle (VPD) sem precisar passar o valor manualmente em toda query.
 */
import { AsyncLocalStorage } from "async_hooks";

export interface RequestStore {
  tenant: string;
  actor: string;
}

export const requestContext = new AsyncLocalStorage<RequestStore>();

export function currentTenant(): string | null {
  return requestContext.getStore()?.tenant ?? null;
}
