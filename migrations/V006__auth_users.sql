-- V006 autenticacao: usuarios por tenant + papeis (RBAC)
-- Senhas demo (bcrypt): admin123 / editor123 / viewer123. Troque em producao.

CREATE TABLE APP_USER (
  USER_ID       NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  TENANT_ID     VARCHAR2(60) NOT NULL,
  USERNAME      VARCHAR2(120) NOT NULL,
  PASSWORD_HASH VARCHAR2(200) NOT NULL,
  ROLES         VARCHAR2(200) NOT NULL,          -- csv: admin,editor,viewer,pii
  ACTIVE        NUMBER(1) DEFAULT 1 CONSTRAINT CK_USER_ACT CHECK (ACTIVE IN (0,1)),
  CREATED_AT    TIMESTAMP DEFAULT SYSTIMESTAMP,
  CONSTRAINT UQ_USER UNIQUE (TENANT_ID, USERNAME)
);

-- admin: tudo, inclui 'pii' (pode revelar dado sensivel)
INSERT INTO APP_USER (TENANT_ID, USERNAME, PASSWORD_HASH, ROLES) VALUES
  ('default', 'admin',  '$2b$10$PStTKUDTyuNiMZlnVFmHKe5kaCw6DL9aTIgUTNmQwv4C7nUf3WJEG', 'admin,editor,viewer,pii');

-- editor: cria/edita registros e governanca; NAO revela sensivel
INSERT INTO APP_USER (TENANT_ID, USERNAME, PASSWORD_HASH, ROLES) VALUES
  ('default', 'editor', '$2b$10$SJzJR673eqtnsP7MFhZUvusps3ld74a70E/E/LR.DVjH3hoAIAg72', 'editor,viewer');

-- viewer: somente leitura (mascarado)
INSERT INTO APP_USER (TENANT_ID, USERNAME, PASSWORD_HASH, ROLES) VALUES
  ('default', 'viewer', '$2b$10$LFQrPb99tP9YwRgREOBBEeD4MKMrC8haPIJE39GdxdC4tJbg7OhPy', 'viewer');
