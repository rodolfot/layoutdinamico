-- Grants necessarios para o VPD (Row-Level Security). Passo de DBA, uma vez por
-- ambiente. Rode como SYSDBA (usuario SYS). Idempotente.
--
--   docker exec -i poc-oracle-free sqlplus -s \
--     "sys/<SENHA_SYS>@localhost:1521/FREEPDB1 as sysdba" < scripts/grant-vpd.sql
--
-- Substitua 'app' se o usuario da aplicacao (ORACLE_USER) for outro.

GRANT CREATE ANY CONTEXT TO app;
GRANT DROP ANY CONTEXT TO app;
GRANT CREATE PROCEDURE TO app;
GRANT EXECUTE ON SYS.DBMS_RLS TO app;
GRANT EXECUTE ON SYS.DBMS_SESSION TO app;
EXIT;
