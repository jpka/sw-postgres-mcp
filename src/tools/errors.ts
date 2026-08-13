export interface ToolErrorShape {
  code: string;
  message: string;
  hint: string;
}

export class ToolFailure extends Error {
  readonly code: string;
  readonly hint: string;

  constructor(code: string, message: string, hint: string) {
    super(message);
    this.name = "ToolFailure";
    this.code = code;
    this.hint = hint;
  }

  toJSON(): ToolErrorShape {
    return { code: this.code, message: this.message, hint: this.hint };
  }
}

export function validateReason(reason: unknown): void {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new ToolFailure(
      "MISSING_REASON",
      "A `reason` string is required.",
      "Pass a short explanation of why this statement is being run; it is recorded in the audit log.",
    );
  }
}