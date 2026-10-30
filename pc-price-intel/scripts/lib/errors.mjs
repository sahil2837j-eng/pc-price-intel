// One error type for every expected failure. The CLI prints it as JSON with a hint
// so an agent can recover without guessing.

export class PcpError extends Error {
  /**
   * @param {string} code    stable machine-readable code, e.g. NO_COUNTRY, VALIDATION
   * @param {string} message human sentence
   * @param {string} [hint]  what to do next
   * @param {object} [details]
   */
  constructor(code, message, hint, details) {
    super(message);
    this.name = "PcpError";
    this.code = code;
    this.hint = hint;
    this.details = details;
  }
}
