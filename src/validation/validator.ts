/**
 * Validacao dirigida por metadados. Regras-chave:
 *   - OBRIGATORIO ausente/vazio  -> erro
 *   - OPCIONAL conhecido ausente  -> ok
 *   - DESCONHECIDO (sem metadado)  -> policy (passthrough grava no ATTRS)
 *   - tipo/regex/min/max/enum, ARRAY (itemType/itemRegex) e OBJECT
 */
import { FieldMetadata, RegistroInput, ValidationError } from "../types";

export type UnknownPolicy = "passthrough" | "reject";

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  unknownKeys: string[];
}

function isEmpty(v: any): boolean {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

function checkScalarType(value: any, type: string, field: string, errors: ValidationError[]): void {
  switch (type) {
    case "NUMBER":
      if (typeof value !== "number" || Number.isNaN(value)) errors.push({ field, message: "deve ser numerico" });
      break;
    case "BOOLEAN":
      if (typeof value !== "boolean") errors.push({ field, message: "deve ser booleano" });
      break;
    case "DATE":
      if (typeof value !== "string" || Number.isNaN(Date.parse(value))) errors.push({ field, message: "deve ser data ISO valida" });
      break;
    case "STRING":
    default:
      if (typeof value !== "string") errors.push({ field, message: "deve ser texto" });
      break;
  }
}

function applyRules(value: any, field: FieldMetadata, errors: ValidationError[]): void {
  const r = field.validation;
  if (!r) return;
  if (r.regex && typeof value === "string" && !new RegExp(r.regex).test(value))
    errors.push({ field: field.logicalName, message: "formato invalido" });
  if (typeof r.min === "number") {
    const n = typeof value === "string" ? value.length : value;
    if (typeof n === "number" && n < r.min) errors.push({ field: field.logicalName, message: `valor/tamanho minimo: ${r.min}` });
  }
  if (typeof r.max === "number") {
    const n = typeof value === "string" ? value.length : value;
    if (typeof n === "number" && n > r.max) errors.push({ field: field.logicalName, message: `valor/tamanho maximo: ${r.max}` });
  }
  if (r.enum && !r.enum.includes(value))
    errors.push({ field: field.logicalName, message: `valor deve ser um de: ${r.enum.join(", ")}` });
}

function validateField(value: any, field: FieldMetadata, errors: ValidationError[]): void {
  if (field.dataType === "ARRAY") {
    if (!Array.isArray(value)) {
      errors.push({ field: field.logicalName, message: "deve ser uma lista" });
      return;
    }
    const itemType = field.itemType ?? "STRING";
    const itemRegex = field.validation?.itemRegex ? new RegExp(field.validation.itemRegex) : null;
    value.forEach((item, i) => {
      checkScalarType(item, itemType, `${field.logicalName}[${i}]`, errors);
      if (itemRegex && typeof item === "string" && !itemRegex.test(item))
        errors.push({ field: `${field.logicalName}[${i}]`, message: "formato de item invalido" });
    });
    return;
  }
  if (field.dataType === "OBJECT") {
    if (typeof value !== "object" || Array.isArray(value) || value === null)
      errors.push({ field: field.logicalName, message: "deve ser um objeto" });
    return;
  }
  checkScalarType(value, field.dataType, field.logicalName, errors);
  applyRules(value, field, errors);
}

export function validate(
  input: RegistroInput,
  fields: FieldMetadata[],
  unknownPolicy: UnknownPolicy
): ValidationResult {
  const errors: ValidationError[] = [];
  const knownNames = new Set(fields.map((f) => f.logicalName));

  for (const field of fields) {
    const value = input[field.logicalName];
    if (isEmpty(value)) {
      if (field.required) errors.push({ field: field.logicalName, message: "campo obrigatorio ausente" });
      continue;
    }
    validateField(value, field, errors);
  }

  const unknownKeys = Object.keys(input).filter((k) => !knownNames.has(k));
  if (unknownPolicy === "reject" && unknownKeys.length > 0) {
    for (const k of unknownKeys) errors.push({ field: k, message: "campo nao cadastrado (policy=reject)" });
  }

  return { valid: errors.length === 0, errors, unknownKeys };
}
