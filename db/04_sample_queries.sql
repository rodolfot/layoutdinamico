--------------------------------------------------------------------------------
-- POC Layout Dinamico - Consultas de leitura sobre JSON (demonstrativas)
--------------------------------------------------------------------------------

-- (1) JSON_VALUE: extrair UM campo dinamico tipado a partir do ATTRS.
SELECT ID,
       NOME,
       JSON_VALUE(ATTRS, '$.rendaMensal' RETURNING NUMBER)      AS RENDA_MENSAL,
       JSON_VALUE(ATTRS, '$.estadoCivil')                       AS ESTADO_CIVIL
FROM   REGISTRO;

-- (2) JSON_EXISTS: filtrar registros que POSSUEM determinado campo dinamico.
SELECT ID, NOME
FROM   REGISTRO
WHERE  JSON_EXISTS(ATTRS, '$.rendaMensal');

-- (3) Filtro tipado por campo dinamico (usa o indice funcional IX_REG_RENDA).
SELECT ID, NOME
FROM   REGISTRO
WHERE  JSON_VALUE(ATTRS, '$.rendaMensal' RETURNING NUMBER) > 5000;

-- (4) JSON_TABLE: projetar VARIOS campos do JSON como se fossem colunas
--     (util para relatorios/BI sobre campos dinamicos).
SELECT r.ID, r.NOME, jt.renda, jt.estado_civil, jt.possui_veiculo
FROM   REGISTRO r,
       JSON_TABLE(r.ATTRS, '$'
         COLUMNS (
           renda          NUMBER        PATH '$.rendaMensal',
           estado_civil   VARCHAR2(20)  PATH '$.estadoCivil',
           possui_veiculo VARCHAR2(5)   PATH '$.possuiVeiculo'
         )) jt;

-- (5) Ver o documento dinamico bruto (inclui ate campos "desconhecidos" que
--     nao estao cadastrados nos metadados, mas foram persistidos sem quebra).
SELECT ID, NOME, JSON_SERIALIZE(ATTRS PRETTY) AS ATTRS_JSON
FROM   REGISTRO;

-- (6) Diagnostico: um campo dinamico "quente" X esta usando indice?
--     Rode com autotrace/plano de execucao e confira INDEX RANGE SCAN em IX_REG_RENDA:
--   EXPLAIN PLAN FOR
--     SELECT ID FROM REGISTRO
--     WHERE JSON_VALUE(ATTRS, '$.rendaMensal' RETURNING NUMBER) > 5000;
--   SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY);
