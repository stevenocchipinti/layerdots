export class LayerdotsError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'LayerdotsError';
  }
}
