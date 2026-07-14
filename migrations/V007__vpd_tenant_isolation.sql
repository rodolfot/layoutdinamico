-- V007 Isolamento reforcado (Oracle VPD / Row-Level Security)
--
-- O Oracle passa a INJETAR automaticamente "TENANT_ID = <contexto>" em toda
-- query sobre REGISTRO. Mesmo um SELECT sem WHERE so ve o tenant da sessao.
-- O contexto e setado por PKG_APP_CTX (pacote confiavel) a partir do tenant
-- autenticado no token. Sem contexto (scripts/infra) -> predicado permissivo.
--
-- Requer (passo de DBA, uma vez): GRANT CREATE ANY CONTEXT, EXECUTE ON DBMS_RLS.

CREATE OR REPLACE PACKAGE PKG_APP_CTX AS
  PROCEDURE set_tenant(p_tenant IN VARCHAR2);
END PKG_APP_CTX;
/

CREATE OR REPLACE PACKAGE BODY PKG_APP_CTX AS
  PROCEDURE set_tenant(p_tenant IN VARCHAR2) IS
  BEGIN
    IF p_tenant IS NULL THEN
      DBMS_SESSION.CLEAR_CONTEXT('APP_CTX', NULL, 'TENANT_ID');
    ELSE
      DBMS_SESSION.SET_CONTEXT('APP_CTX', 'TENANT_ID', p_tenant);
    END IF;
  END set_tenant;
END PKG_APP_CTX;
/

-- Contexto so pode ser alterado pelo pacote confiavel acima.
CREATE OR REPLACE CONTEXT APP_CTX USING PKG_APP_CTX;
/

-- Funcao de policy: predicado aplicado a cada query.
CREATE OR REPLACE FUNCTION VPD_TENANT_PREDICATE(
  p_schema IN VARCHAR2, p_object IN VARCHAR2
) RETURN VARCHAR2 AS
BEGIN
  IF SYS_CONTEXT('APP_CTX', 'TENANT_ID') IS NULL THEN
    RETURN '1=1';  -- sem contexto (migrate/infra): permissivo
  END IF;
  RETURN 'TENANT_ID = SYS_CONTEXT(''APP_CTX'', ''TENANT_ID'')';
END VPD_TENANT_PREDICATE;
/

-- Aplica a policy em REGISTRO (SELECT/INSERT/UPDATE/DELETE). update_check
-- impede gravar linha com tenant diferente do contexto.
BEGIN
  DBMS_RLS.ADD_POLICY(
    object_schema   => USER,
    object_name     => 'REGISTRO',
    policy_name     => 'REGISTRO_TENANT_ISO',
    function_schema => USER,
    policy_function => 'VPD_TENANT_PREDICATE',
    statement_types => 'SELECT,INSERT,UPDATE,DELETE',
    update_check    => TRUE
  );
EXCEPTION
  WHEN OTHERS THEN
    IF SQLCODE = -28101 THEN NULL; -- policy ja existe: idempotente
    ELSE RAISE;
    END IF;
END;
/
