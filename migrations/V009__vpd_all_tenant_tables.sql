-- V009 Estende o VPD (isolamento por tenant) as demais tabelas com dados de
-- tenant: REGISTRO_HISTORY, AUDIT_LOG e IGNORED_FIELDS. Reusa a mesma funcao
-- de predicado (VPD_TENANT_PREDICATE) - filtro por SYS_CONTEXT('APP_CTX').
-- Idempotente (ignora ORA-28101: policy ja existe).
--
-- APP_USER e SCHEMA_MIGRATIONS ficam FORA de proposito: login precisa consultar
-- APP_USER antes de haver contexto; migrations gerenciam SCHEMA_MIGRATIONS.

DECLARE
  PROCEDURE add_iso(p_table VARCHAR2, p_policy VARCHAR2) IS
  BEGIN
    DBMS_RLS.ADD_POLICY(
      object_schema   => USER,
      object_name     => p_table,
      policy_name     => p_policy,
      function_schema => USER,
      policy_function => 'VPD_TENANT_PREDICATE',
      statement_types => 'SELECT,INSERT,UPDATE,DELETE',
      update_check    => TRUE
    );
  EXCEPTION
    WHEN OTHERS THEN IF SQLCODE = -28101 THEN NULL; ELSE RAISE; END IF;
  END;
BEGIN
  add_iso('REGISTRO_HISTORY', 'HISTORY_TENANT_ISO');
  add_iso('AUDIT_LOG',        'AUDIT_TENANT_ISO');
  add_iso('IGNORED_FIELDS',   'IGNORED_TENANT_ISO');
END;
/
