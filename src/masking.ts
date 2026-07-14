/**
 * Mascaramento de valores sensiveis (LGPD) e resolucao de rotulo por idioma.
 */
import { FieldMetadata, MaskStyle } from "./types";

export function maskValue(value: any, style: MaskStyle | null): any {
  if (value == null || value === "") return value;
  const s = String(value);
  switch (style) {
    case "cpf": // 123.456.789-01 -> ***.***.789-01 (mantem 4 ultimos)
      return s.length >= 4 ? "*".repeat(Math.max(0, s.length - 4)) + s.slice(-4) : "****";
    case "email": {
      const [user, domain] = s.split("@");
      if (!domain) return "****";
      const head = user.slice(0, 1);
      return `${head}${"*".repeat(Math.max(1, user.length - 1))}@${domain}`;
    }
    case "partial": // mantem primeiro e ultimo
      return s.length <= 2 ? "**" : `${s[0]}${"*".repeat(s.length - 2)}${s[s.length - 1]}`;
    case "full":
    default:
      return "****";
  }
}

/** Resolve o rotulo do campo para o idioma pedido, com fallback para LABEL. */
export function resolveLabel(f: FieldMetadata, lang: string): string {
  return (f.labelI18n && f.labelI18n[lang]) || f.label;
}
