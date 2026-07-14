/**
 * Tipos centrais da POC.
 *  - RegistroCore  -> campos criticos fortemente tipados (viram colunas).
 *  - attrs         -> mapa flexivel de atributos dinamicos/opcionais/desconhecidos.
 */

export type DataType = "STRING" | "NUMBER" | "BOOLEAN" | "DATE" | "ARRAY" | "OBJECT";
export type ItemType = "STRING" | "NUMBER" | "BOOLEAN" | "DATE";
export type Storage = "CORE" | "DYNAMIC";
export type MaskStyle = "cpf" | "email" | "partial" | "full";

/** Campos criticos, sempre estruturados (persistidos em colunas fixas). */
export interface RegistroCore {
  cpf: string;
  nome: string;
  email?: string;
}

/** Registro completo = core tipado + atributos flexiveis. */
export interface Registro extends RegistroCore {
  id?: number;
  tenantId: string;
  layoutVersion: number;
  attrs: Record<string, any>;
}

/** Payload de entrada da API: core + qualquer chave extra (conhecida ou nao). */
export interface RegistroInput extends Partial<RegistroCore> {
  [key: string]: any;
}

/** Regras opcionais de validacao declaradas no metadado (coluna VALIDATION). */
export interface ValidationRule {
  regex?: string;
  min?: number;
  max?: number;
  enum?: Array<string | number>;
  itemRegex?: string; // para itens de ARRAY
}

/** Regra de exibicao condicional: mostra o campo quando outro campo == valor. */
export interface VisibleWhen {
  field: string;
  equals: any;
}

/** Contrato de um campo, vindo de FIELD_METADATA. Dirige validacao E exibicao. */
export interface FieldMetadata {
  fieldId: number;
  tenantId: string;
  layoutVersion: number;
  logicalName: string;
  jsonPath: string | null;
  storage: Storage;
  dataType: DataType;
  itemType: ItemType | null;
  required: boolean;
  visible: boolean;
  editable: boolean;
  sensitive: boolean;
  maskStyle: MaskStyle | null;
  displayOrder: number;
  label: string;
  labelI18n: Record<string, string> | null;
  section: string | null;
  validation: ValidationRule | null;
  visibleWhen: VisibleWhen | null;
  active: boolean;
}

/** Um erro de validacao ligado a um campo. */
export interface ValidationError {
  field: string;
  message: string;
}

/** Item pronto para a tela (resultado do GET /registros/:id/view). */
export interface ViewField {
  logicalName: string;
  label: string;
  dataType: DataType;
  section: string | null;
  editable: boolean;
  sensitive: boolean;
  masked: boolean;
  displayOrder: number;
  value: any;
}
